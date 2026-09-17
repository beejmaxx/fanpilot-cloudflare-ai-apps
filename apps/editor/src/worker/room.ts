import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import {
  acceptAllSchema,
  aiRequestSchema,
  commentSchema,
  createDocumentSchema,
  createInvitationSchema,
  initializeDocumentSchema,
  invitationInfoSchema,
  joinDocumentSchema,
  renameParticipantSchema,
  resolveCommentSchema,
  suggestionDecisionSchema,
  updateTitleSchema,
  workflowCommitSchema,
} from "../shared/schemas";
import type {
  AiJobSnapshot,
  ChatMessage,
  Comment,
  DocumentSnapshot,
  Participant,
  ParticipantRole,
  Revision,
  Suggestion,
} from "../shared/types";
import type { Env } from "./env";
import { errorResponse, HttpError, json, parseJson } from "./http";
import {
  blocks,
  createDocument,
  documentMarkdown,
  documentText,
  richContentFingerprint,
  replaceBlockText,
  validateDocument,
} from "./y-document";

const MAX_DOCUMENT_CHARACTERS = 20_000;
const MAX_UPDATE_BYTES = 128_000;
const MAX_DOCUMENT_STATE_BYTES = 2_000_000;
const MAX_EDITORS = 5;
const MAX_PARTICIPANTS = 50;
const UPDATE_BYTES_PER_MINUTE = 512_000;
const DOCUMENT_UPDATE_BYTES_PER_MINUTE = 2_000_000;
const AI_REQUESTS_PER_HOUR = 20;
const COMMENTS_PER_HOUR = 100;
const INVITES_PER_HOUR = 30;
const CHECKPOINT_INTERVAL = 100;
const UPDATE_MESSAGE = 0;
const AWARENESS_MESSAGE = 1;

type Origin = {
  kind: "client" | "server-atomic";
  participantId: string;
  submissionId: string;
  socket?: WebSocket;
};

interface SocketAttachment {
  participantId: string;
  role: ParticipantRole;
  awarenessClientIds: number[];
}

type DocumentRow = {
  id: string;
  title: string;
  content_sequence: number;
  created_at: number;
  updated_at: number;
};

type ParticipantRow = {
  id: string;
  display_name: string;
  role: ParticipantRole;
  joined_at: number;
  last_seen_at: number;
};

export class DocumentRoom extends DurableObject<Env> {
  private document = new Y.Doc();
  private awareness = new awarenessProtocol.Awareness(this.document);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.loadDocument();
      this.attachDocumentListeners();
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/initialize") return await this.initialize(request);
      if (request.method === "POST" && pathname === "/invitation-info") return await this.invitationInfo(request);
      if (request.method === "POST" && pathname === "/join") return await this.join(request);
      if (request.method === "GET" && pathname === "/session") return await this.session(request);
      if (request.method === "GET" && pathname === "/snapshot") return await this.snapshotResponse(request);
      if (request.method === "GET" && pathname === "/ws") return await this.connectWebSocket(request);
      if (request.method === "PATCH" && pathname === "/title") return await this.updateTitle(request);
      if (request.method === "PATCH" && pathname === "/participant") return await this.renameParticipant(request);
      if (request.method === "POST" && pathname === "/participant/rotate-access") return await this.rotateAccess(request);
      if (request.method === "POST" && pathname === "/invitations") return await this.createInvitation(request);
      if (request.method === "POST" && pathname === "/comments") return await this.createComment(request);
      if (request.method === "POST" && /^\/comments\/[^/]+\/resolve$/.test(pathname)) return await this.resolveComment(request, pathname.split("/")[2]);
      if (request.method === "POST" && pathname === "/ai") return await this.requestAI(request);
      if (request.method === "POST" && /^\/suggestions\/[^/]+\/decision$/.test(pathname)) return await this.decideSuggestion(request, pathname.split("/")[2]);
      if (request.method === "POST" && pathname === "/suggestions/accept-all") return await this.acceptAllSuggestions(request);
      if (request.method === "POST" && /^\/revisions\/[^/]+\/revert$/.test(pathname)) return await this.revertRevision(request, pathname.split("/")[2]);
      if (request.method === "POST" && /^\/participants\/[^/]+\/revoke$/.test(pathname)) return await this.revokeParticipant(request, pathname.split("/")[2]);
      if (request.method === "GET" && pathname === "/export") return await this.exportDocument(request);
      if (request.method === "GET" && pathname === "/internal/ai-job") return this.aiJobSnapshot(new URL(request.url));
      if (request.method === "POST" && pathname === "/internal/ai-commit") return await this.commitAI(request);
      if (request.method === "POST" && pathname === "/internal/ai-failed") return await this.failAI(request);
      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || !this.participantActive(attachment.participantId)) {
      socket.close(4003, "Access revoked");
      return;
    }
    if (typeof message === "string") return;
    const bytes = new Uint8Array(message);
    if (!bytes.length || bytes.byteLength > MAX_UPDATE_BYTES + 64) {
      socket.close(4009, "Message too large");
      return;
    }
    if (bytes[0] === UPDATE_MESSAGE) {
      if (attachment.role === "viewer") {
        socket.send(JSON.stringify({ type: "error", error: "Viewers cannot edit" }));
        return;
      }
      const submissionId = new TextDecoder().decode(bytes.slice(1, 37));
      const update = bytes.slice(37);
      if (!/^[0-9a-f-]{36}$/i.test(submissionId) || !update.length) return;
      if (this.submissionExists(submissionId)) {
        socket.send(JSON.stringify({ type: "ack", submissionId, sequence: this.contentSequence() }));
        return;
      }
      if (this.usageInWindow("update-bytes", attachment.participantId, 60_000) + update.byteLength > UPDATE_BYTES_PER_MINUTE
        || this.usageInWindow("update-bytes", null, 60_000) + update.byteLength > DOCUMENT_UPDATE_BYTES_PER_MINUTE) {
        socket.send(JSON.stringify({ type: "error", error: "Editing is temporarily rate limited. Wait a moment and try again.", reload: true }));
        return;
      }
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.document));
        Y.applyUpdate(candidate, update);
        validateDocument(candidate, { maxCharacters: MAX_DOCUMENT_CHARACTERS, maxStateBytes: MAX_DOCUMENT_STATE_BYTES });
      } catch (error) {
        candidate.destroy();
        socket.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "The document update is invalid", reload: true }));
        socket.send(envelope(UPDATE_MESSAGE, Y.encodeStateAsUpdate(this.document)));
        return;
      }
      candidate.destroy();
      const before = Y.encodeStateVector(this.document);
      Y.applyUpdate(this.document, update, { kind: "client", participantId: attachment.participantId, submissionId, socket } satisfies Origin);
      const accepted = Y.encodeStateAsUpdate(this.document, before);
      if (accepted.length) this.sendUpdateToOthers(accepted, socket);
      socket.send(JSON.stringify({ type: "ack", submissionId, sequence: this.contentSequence() }));
      return;
    }
    if (bytes[0] === AWARENESS_MESSAGE) {
      if (bytes.byteLength > 16_000) return;
      const participant = this.participantById(attachment.participantId);
      if (!participant) return;
      let entries: Array<{ clientId: number; state: unknown }>;
      try { entries = awarenessEntries(bytes.slice(1)); } catch { return; }
      for (const entry of entries) {
        const owner = this.socketOwningAwareness(entry.clientId);
        if (owner && owner !== socket) {
          socket.send(JSON.stringify({ type: "error", error: "Invalid presence identity" }));
          return;
        }
        if (!owner && entry.state !== null && attachment.awarenessClientIds.length >= 1) {
          socket.send(JSON.stringify({ type: "error", error: "Only one presence identity is allowed per connection" }));
          return;
        }
        if (!owner && entry.state === null) return;
      }
      const safeUpdate = awarenessProtocol.modifyAwarenessUpdate(bytes.slice(1), (state) => state ? {
        cursor: typeof state === "object" && state && "cursor" in state ? state.cursor : null,
        user: { name: participant.displayName, color: participantColor(participant.id) },
      } : state);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, safeUpdate, socket);
      for (const entry of entries) {
        if (entry.state === null) attachment.awarenessClientIds = attachment.awarenessClientIds.filter((id) => id !== entry.clientId);
        else if (!attachment.awarenessClientIds.includes(entry.clientId)) attachment.awarenessClientIds.push(entry.clientId);
      }
      socket.serializeAttachment(attachment);
      this.sendToOthers(envelope(AWARENESS_MESSAGE, safeUpdate), socket);
    }
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.awarenessClientIds.length) {
      awarenessProtocol.removeAwarenessStates(this.awareness, attachment.awarenessClientIds, socket);
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, attachment.awarenessClientIds);
      this.sendToOthers(envelope(AWARENESS_MESSAGE, update), socket);
    }
  }

  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, joined_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER, used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS y_updates (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, update_blob BLOB NOT NULL,
        participant_id TEXT NOT NULL, submission_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS y_checkpoints (
        id INTEGER PRIMARY KEY CHECK (id = 1), covered_sequence INTEGER NOT NULL,
        state_blob BLOB NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, participant_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL,
        job_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, block_id TEXT NOT NULL, participant_id TEXT NOT NULL, body TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_jobs (
        id TEXT PRIMARY KEY, participant_id TEXT NOT NULL, instruction TEXT NOT NULL, scope TEXT NOT NULL,
        source_sequence INTEGER NOT NULL, input_json TEXT NOT NULL, status TEXT NOT NULL,
        workflow_instance_id TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, block_id TEXT NOT NULL, before_text TEXT NOT NULL,
        after_text TEXT NOT NULL, before_fingerprint TEXT NOT NULL, rationale TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, actor_id TEXT NOT NULL,
        export_text TEXT NOT NULL, state_blob BLOB NOT NULL, block_id TEXT,
        before_text TEXT, after_fingerprint TEXT, reverted_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, actor_id TEXT,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, participant_id TEXT,
        amount INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS suggestions_job ON suggestions(job_id, status);
      CREATE INDEX IF NOT EXISTS comments_block ON comments(block_id, created_at);
      CREATE INDEX IF NOT EXISTS usage_window ON usage_events(kind, participant_id, created_at);
    `);
    const revisionColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(revisions)").toArray();
    for (const [name, type] of [["block_id", "TEXT"], ["before_text", "TEXT"], ["after_fingerprint", "TEXT"], ["reverted_at", "INTEGER"]] as const) {
      if (!revisionColumns.some((column) => column.name === name)) this.ctx.storage.sql.exec(`ALTER TABLE revisions ADD COLUMN ${name} ${type}`);
    }
    const invitationColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(invitations)").toArray();
    if (!invitationColumns.some((column) => column.name === "used_at")) this.ctx.storage.sql.exec("ALTER TABLE invitations ADD COLUMN used_at INTEGER");
  }

  private loadDocument(): void {
    this.document.destroy();
    this.document = new Y.Doc();
    const checkpoint = this.ctx.storage.sql
      .exec<{ covered_sequence: number; state_blob: ArrayBuffer }>("SELECT covered_sequence, state_blob FROM y_checkpoints WHERE id = 1")
      .toArray()[0];
    if (!checkpoint) return;
    Y.applyUpdate(this.document, new Uint8Array(checkpoint.state_blob));
    const updates = this.ctx.storage.sql
      .exec<{ update_blob: ArrayBuffer }>("SELECT update_blob FROM y_updates WHERE sequence > ? ORDER BY sequence", checkpoint.covered_sequence)
      .toArray();
    updates.forEach((row) => Y.applyUpdate(this.document, new Uint8Array(row.update_blob)));
    this.awareness.destroy();
    this.awareness = new awarenessProtocol.Awareness(this.document);
  }

  private reloadDocument(): void {
    this.loadDocument();
    this.attachDocumentListeners();
    this.broadcastFullState();
  }

  private attachDocumentListeners(): void {
    this.document.off("update", this.onDocumentUpdate);
    this.document.on("update", this.onDocumentUpdate);
  }

  private onDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    const event = origin as Origin | null;
    if (!event || event.kind === "server-atomic") return;
    const now = Date.now();
    let sequence = 0;
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO y_updates (update_blob, participant_id, submission_id, created_at) VALUES (?, ?, ?, ?)",
          toArrayBuffer(update), event.participantId, event.submissionId, now,
        );
        sequence = this.ctx.storage.sql.exec<{ sequence: number }>("SELECT last_insert_rowid() AS sequence").one().sequence;
        this.ctx.storage.sql.exec("UPDATE documents SET content_sequence = ?, updated_at = ?", sequence, now);
        this.recordUsage("update-bytes", event.participantId, update.byteLength, now);
      });
    } catch (error) {
      if (this.submissionExists(event.submissionId)) return;
      throw error;
    }
    this.ctx.storage.sql.exec(
      `UPDATE suggestions SET status = 'stale' WHERE status = 'pending' AND job_id IN
       (SELECT id FROM ai_jobs WHERE scope = 'document' AND source_sequence < ?)`,
      sequence,
    );
    if (sequence % CHECKPOINT_INTERVAL === 0) this.tryCheckpoint(sequence);
  };

  private async initialize(request: Request): Promise<Response> {
    if (this.documentExists()) throw new HttpError(409, "Document already exists");
    const input = await parseJson(request, initializeDocumentSchema);
    const documentId = input.documentId;
    const participantId = crypto.randomUUID();
    const accessToken = randomToken();
    const now = Date.now();
    this.document.destroy();
    this.document = createDocument(input.template);
    this.awareness.destroy();
    this.awareness = new awarenessProtocol.Awareness(this.document);
    const tokenHash = await hashToken(accessToken);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO documents (id, title, content_sequence, created_at, updated_at) VALUES (?, ?, 0, ?, ?)", documentId, input.title, now, now);
      this.ctx.storage.sql.exec(
        "INSERT INTO participants (id, display_name, role, token_hash, joined_at, last_seen_at) VALUES (?, ?, 'owner', ?, ?, ?)",
        participantId, input.displayName, tokenHash, now, now,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO y_checkpoints (id, covered_sequence, state_blob, created_at) VALUES (1, 0, ?, ?)",
        toArrayBuffer(Y.encodeStateAsUpdate(this.document)), now,
      );
    });
    this.attachDocumentListeners();
    this.addAudit("document.created", participantId, { template: input.template });
    return json({ documentId, participantId, accessToken, snapshot: this.getSnapshot(participantId) }, { status: 201 });
  }

  private async invitationInfo(request: Request): Promise<Response> {
    const { inviteToken } = await parseJson(request, invitationInfoSchema);
    const invite = await this.invitationByToken(inviteToken);
    if (!invite) throw new HttpError(404, "Invitation is invalid or expired");
    const doc = this.getDocument();
    return json({ documentId: doc.id, title: doc.title, role: invite.role });
  }

  private async join(request: Request): Promise<Response> {
    const input = await parseJson(request, joinDocumentSchema);
    const invite = await this.invitationByToken(input.inviteToken);
    if (!invite) throw new HttpError(404, "Invitation is invalid, expired, or already used");
    const participantCount = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM participants WHERE revoked_at IS NULL").one().count;
    if (participantCount >= MAX_PARTICIPANTS) throw new HttpError(409, "This document has reached its participant limit");
    const participantId = crypto.randomUUID();
    const accessToken = randomToken();
    const tokenHash = await hashToken(accessToken);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const claimed = this.ctx.storage.sql.exec("UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", now, invite.id, now).rowsWritten;
      if (!claimed) throw new HttpError(409, "Invitation is invalid, expired, or already used");
      this.ctx.storage.sql.exec(
        "INSERT INTO participants (id, display_name, role, token_hash, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
        participantId, input.displayName, invite.role, tokenHash, now, now,
      );
    });
    this.addAudit("participant.joined", participantId, { role: invite.role });
    await this.broadcastSnapshots();
    return json({ documentId: this.getDocument().id, participantId, accessToken, snapshot: this.getSnapshot(participantId) }, { status: 201 });
  }

  private async session(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    return json({ participant, snapshot: this.getSnapshot(participant.id) });
  }

  private async snapshotResponse(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    return json(this.getSnapshot(participant.id));
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "WebSocket upgrade required");
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim());
    if (protocols[0] !== "draft-v1" || !protocols[1]) throw new HttpError(401, "Private access token required");
    const participant = await this.participantByToken(protocols[1]);
    if (!participant) throw new HttpError(401, "Private access token is invalid");
    if (participant.role !== "viewer") {
      const editors = this.ctx.getWebSockets().filter((socket) => (socket.deserializeAttachment() as SocketAttachment | null)?.role !== "viewer").length;
      if (editors >= MAX_EDITORS) throw new HttpError(429, "This document already has five active editors");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ participantId: participant.id, role: participant.role, awarenessClientIds: [] } satisfies SocketAttachment);
    server.send(envelope(UPDATE_MESSAGE, Y.encodeStateAsUpdate(this.document)));
    const awarenessIds = [...this.awareness.getStates().keys()];
    if (awarenessIds.length) server.send(envelope(AWARENESS_MESSAGE, awarenessProtocol.encodeAwarenessUpdate(this.awareness, awarenessIds)));
    server.send(JSON.stringify({ type: "ready", sequence: this.contentSequence() }));
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "draft-v1" } });
  }

  private async updateTitle(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    this.requireEdit(participant);
    const { title } = await parseJson(request, updateTitleSchema);
    this.ctx.storage.sql.exec("UPDATE documents SET title = ?, updated_at = ?", title, Date.now());
    this.addAudit("document.renamed", participant.id, { title });
    await this.broadcastSnapshots();
    return json(this.getSnapshot(participant.id));
  }

  private async renameParticipant(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    const { displayName } = await parseJson(request, renameParticipantSchema);
    this.ctx.storage.sql.exec("UPDATE participants SET display_name = ?, last_seen_at = ? WHERE id = ?", displayName, Date.now(), participant.id);
    await this.broadcastSnapshots();
    return json(this.getSnapshot(participant.id));
  }

  private async rotateAccess(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    const accessToken = randomToken();
    const tokenHash = await hashToken(accessToken);
    this.ctx.storage.sql.exec("UPDATE participants SET token_hash = ? WHERE id = ?", tokenHash, participant.id);
    this.disconnectParticipant(participant.id, "Access link rotated");
    return json({ accessToken });
  }

  private async createInvitation(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    if (participant.role !== "owner") throw new HttpError(403, "Only the owner can invite collaborators");
    this.enforceRateLimit("invite", participant.id, INVITES_PER_HOUR, 60 * 60_000);
    const { role } = await parseJson(request, createInvitationSchema);
    const inviteToken = randomToken();
    const tokenHash = await hashToken(inviteToken);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO invitations (id, token_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), tokenHash, role, participant.id, now, now + 30 * 24 * 60 * 60 * 1000,
    );
    return json({ inviteToken, role, expiresAt: now + 30 * 24 * 60 * 60 * 1000 });
  }

  private async createComment(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    this.requireEdit(participant);
    this.enforceRateLimit("comment", participant.id, COMMENTS_PER_HOUR, 60 * 60_000);
    const input = await parseJson(request, commentSchema);
    if (!blocks(this.document).some((block) => block.id === input.blockId)) throw new HttpError(409, "That paragraph no longer exists");
    const id = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO comments (id, block_id, participant_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, input.blockId, participant.id, input.body, now, now);
    this.addAudit("comment.created", participant.id, { id, blockId: input.blockId });
    await this.broadcastSnapshots();
    return json(this.getSnapshot(participant.id), { status: 201 });
  }

  private async resolveComment(request: Request, commentId: string): Promise<Response> {
    const participant = await this.authenticate(request);
    this.requireEdit(participant);
    const { resolved } = await parseJson(request, resolveCommentSchema);
    const changed = this.ctx.storage.sql.exec("UPDATE comments SET resolved = ?, updated_at = ? WHERE id = ?", resolved ? 1 : 0, Date.now(), commentId).rowsWritten;
    if (!changed) throw new HttpError(404, "Comment not found");
    this.addAudit(resolved ? "comment.resolved" : "comment.reopened", participant.id, { commentId });
    await this.broadcastSnapshots();
    return json(this.getSnapshot(participant.id));
  }

  private async requestAI(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    this.requireEdit(participant);
    this.enforceRateLimit("ai", participant.id, AI_REQUESTS_PER_HOUR, 60 * 60_000);
    const input = await parseJson(request, aiRequestSchema);
    const active = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM ai_jobs WHERE status IN ('queued', 'running') LIMIT 1").toArray()[0];
    if (active) throw new HttpError(409, "An AI request is already running for this document");
    const available = blocks(this.document);
    const selected = input.scope === "selection" ? available.filter((block) => input.blockIds.includes(block.id)) : available;
    if (input.scope === "selection" && !selected.length) throw new HttpError(409, "Select at least one paragraph first");
    const jobId = crypto.randomUUID();
    const workflowInstanceId = `doc-${this.getDocument().id}-${jobId}`;
    const now = Date.now();
    const captured: AiJobSnapshot = {
      documentId: this.getDocument().id,
      title: this.getDocument().title,
      jobId,
      instruction: input.instruction,
      scope: input.scope,
      requesterName: participant.displayName,
      sourceSequence: this.contentSequence(),
      blocks: selected.map((block) => ({ id: block.id, type: block.type, text: block.text, fingerprint: richContentFingerprint(block.json) })),
      allowFallback: isLocalOrigin(request.headers.get("x-draft-origin")),
    };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO ai_jobs (id, participant_id, instruction, scope, source_sequence, input_json, status, workflow_instance_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
        jobId, participant.id, input.instruction, input.scope, captured.sourceSequence, JSON.stringify(captured), workflowInstanceId, now,
      );
      this.ctx.storage.sql.exec("INSERT INTO chat_messages (id, participant_id, kind, body, job_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)", crypto.randomUUID(), participant.id, input.instruction, jobId, now);
    });
    try {
      await this.env.AI_EDIT_WORKFLOW.create({ id: workflowInstanceId, params: { documentId: captured.documentId, jobId } });
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE ai_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", error instanceof Error ? error.message : "Could not start AI workflow", Date.now(), jobId);
      throw error;
    }
    await this.broadcastSnapshots();
    return json({ jobId, snapshot: this.getSnapshot(participant.id) }, { status: 202 });
  }

  private aiJobSnapshot(url: URL): Response {
    const jobId = url.searchParams.get("jobId");
    const row = this.ctx.storage.sql.exec<{ input_json: string; status: string }>("SELECT input_json, status FROM ai_jobs WHERE id = ?", jobId).toArray()[0];
    if (!row) throw new HttpError(404, "AI job not found");
    if (row.status === "cancelled") throw new HttpError(409, "AI job was cancelled");
    this.ctx.storage.sql.exec("UPDATE ai_jobs SET status = 'running' WHERE id = ? AND status = 'queued'", jobId);
    return json(JSON.parse(row.input_json));
  }

  private async commitAI(request: Request): Promise<Response> {
    const input = await parseJson(request, workflowCommitSchema);
    if (input.changes.reduce((total, change) => total + change.replacement.length, 0) > 40_000) throw new HttpError(400, "AI response is too large");
    const job = this.ctx.storage.sql.exec<{ status: string; participant_id: string; input_json: string }>("SELECT status, participant_id, input_json FROM ai_jobs WHERE id = ?", input.jobId).toArray()[0];
    if (!job) throw new HttpError(404, "AI job not found");
    if (job.status === "complete") return json({ committed: false, duplicate: true });
    if (job.status === "cancelled") return json({ committed: false, cancelled: true });
    const captured = JSON.parse(job.input_json) as AiJobSnapshot;
    const allowed = new Map(captured.blocks.map((block) => [block.id, block]));
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const change of input.changes) {
        const block = allowed.get(change.blockId);
        if (!block || change.replacement === block.text) continue;
        this.ctx.storage.sql.exec(
          "INSERT INTO suggestions (id, job_id, block_id, before_text, after_text, before_fingerprint, rationale, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
          crypto.randomUUID(), input.jobId, block.id, block.text, change.replacement, block.fingerprint, change.rationale, now,
        );
      }
      this.ctx.storage.sql.exec("INSERT INTO chat_messages (id, participant_id, kind, body, job_id, created_at) VALUES (?, NULL, 'assistant', ?, ?, ?)", crypto.randomUUID(), input.answer, input.jobId, now);
      this.ctx.storage.sql.exec("UPDATE ai_jobs SET status = 'complete', completed_at = ? WHERE id = ?", now, input.jobId);
    });
    this.addAudit("ai.completed", job.participant_id, { jobId: input.jobId, source: input.source, suggestionCount: input.changes.length });
    await this.broadcastSnapshots();
    return json({ committed: true });
  }

  private async failAI(request: Request): Promise<Response> {
    const body = await request.json<{ jobId: string; error: string }>();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const changed = this.ctx.storage.sql.exec("UPDATE ai_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status NOT IN ('complete', 'cancelled')", body.error.slice(0, 1_000), now, body.jobId).rowsWritten;
      if (changed) this.ctx.storage.sql.exec(
        "INSERT INTO chat_messages (id, participant_id, kind, body, job_id, created_at) VALUES (?, NULL, 'system', ?, ?, ?)",
        crypto.randomUUID(), "Draft AI could not complete this request. Please try again.", body.jobId, now,
      );
    });
    await this.broadcastSnapshots();
    return json({ failed: true });
  }

  private async decideSuggestion(request: Request, suggestionId: string): Promise<Response> {
    const participant = await this.authenticate(request);
    this.requireEdit(participant);
    const { decision } = await parseJson(request, suggestionDecisionSchema);
    const suggestion = this.ctx.storage.sql.exec<{
      id: string; status: string; block_id: string; before_fingerprint: string; after_text: string; before_text: string;
    }>("SELECT id, status, block_id, before_fingerprint, after_text, before_text FROM suggestions WHERE id = ?", suggestionId).toArray()[0];
    if (!suggestion) throw new HttpError(404, "Suggestion not found");
    if (suggestion.status !== "pending") return json({ applied: suggestion.status === "accepted", duplicate: true, snapshot: this.getSnapshot(participant.id) });
    if (decision === "reject") {
      this.ctx.storage.sql.exec("UPDATE suggestions SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", Date.now(), participant.id, suggestionId);
      this.addAudit("suggestion.rejected", participant.id, { suggestionId });
      await this.broadcastSnapshots();
      return json({ applied: false, snapshot: this.getSnapshot(participant.id) });
    }
    const current = blocks(this.document).find((block) => block.id === suggestion.block_id);
    if (!current || richContentFingerprint(current.json) !== suggestion.before_fingerprint) {
      this.ctx.storage.sql.exec("UPDATE suggestions SET status = 'stale', decided_at = ? WHERE id = ?", Date.now(), suggestionId);
      await this.broadcastSnapshots();
      throw new HttpError(409, "That paragraph changed. Regenerate this suggestion before applying it.");
    }
    const update = this.commitServerDocumentChange(participant.id, (origin) => {
      if (!replaceBlockText(this.document, suggestion.block_id, suggestion.after_text, origin)) throw new HttpError(409, "That paragraph no longer exists");
    }, ({ beforeState, beforeExport, now }) => {
      const changed = this.ctx.storage.sql.exec("UPDATE suggestions SET status = 'accepted', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", now, participant.id, suggestionId).rowsWritten;
      if (!changed) throw new HttpError(409, "This suggestion was already decided");
      const after = blocks(this.document).find((block) => block.id === suggestion.block_id);
      if (!after) throw new HttpError(409, "That paragraph no longer exists");
      this.ctx.storage.sql.exec(
        "INSERT INTO revisions (id, label, actor_id, export_text, state_blob, block_id, before_text, after_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(), "Before AI edit", participant.id, beforeExport, toArrayBuffer(beforeState), suggestion.block_id,
        suggestion.before_text, richContentFingerprint(after.json), now,
      );
      this.insertAudit("suggestion.accepted", participant.id, { suggestionId, blockId: suggestion.block_id }, now);
    });
    if (update.length) this.sendUpdateToOthers(update);
    await this.broadcastSnapshots();
    return json({ applied: true, snapshot: this.getSnapshot(participant.id) });
  }

  private async acceptAllSuggestions(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    this.requireEdit(participant);
    const { jobId } = await parseJson(request, acceptAllSchema);
    const suggestions = this.ctx.storage.sql.exec<{
      id: string; block_id: string; before_text: string; after_text: string; before_fingerprint: string;
    }>("SELECT id, block_id, before_text, after_text, before_fingerprint FROM suggestions WHERE job_id = ? AND status = 'pending' ORDER BY created_at", jobId).toArray();
    if (!suggestions.length) throw new HttpError(409, "There are no pending suggestions in this set");
    const current = new Map(blocks(this.document).map((block) => [block.id, block]));
    const stale = suggestions.find((suggestion) => {
      const block = current.get(suggestion.block_id);
      return !block || richContentFingerprint(block.json) !== suggestion.before_fingerprint;
    });
    if (stale) throw new HttpError(409, "At least one paragraph changed. Review or regenerate the set before accepting all.");
    const update = this.commitServerDocumentChange(participant.id, (origin) => {
      for (const suggestion of suggestions) {
        if (!replaceBlockText(this.document, suggestion.block_id, suggestion.after_text, origin)) throw new HttpError(409, "A target paragraph no longer exists");
      }
    }, ({ beforeState, beforeExport, now }) => {
      for (const suggestion of suggestions) {
        const changed = this.ctx.storage.sql.exec("UPDATE suggestions SET status = 'accepted', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", now, participant.id, suggestion.id).rowsWritten;
        if (!changed) throw new HttpError(409, "A suggestion in this set was already decided");
        const after = blocks(this.document).find((block) => block.id === suggestion.block_id);
        if (!after) throw new HttpError(409, "A target paragraph no longer exists");
        this.ctx.storage.sql.exec(
          "INSERT INTO revisions (id, label, actor_id, export_text, state_blob, block_id, before_text, after_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          crypto.randomUUID(), "Before AI edit", participant.id, beforeExport, toArrayBuffer(beforeState), suggestion.block_id,
          suggestion.before_text, richContentFingerprint(after.json), now,
        );
      }
      this.insertAudit("suggestions.accepted_all", participant.id, { jobId, count: suggestions.length }, now);
    });
    if (update.length) this.sendUpdateToOthers(update);
    await this.broadcastSnapshots();
    return json({ applied: suggestions.length, snapshot: this.getSnapshot(participant.id) });
  }

  private async revertRevision(request: Request, revisionId: string): Promise<Response> {
    const participant = await this.authenticate(request);
    this.requireEdit(participant);
    const revision = this.ctx.storage.sql.exec<{
      block_id: string | null; before_text: string | null; after_fingerprint: string | null; reverted_at: number | null;
    }>("SELECT block_id, before_text, after_fingerprint, reverted_at FROM revisions WHERE id = ?", revisionId).toArray()[0];
    if (!revision) throw new HttpError(404, "Revision not found");
    if (revision.reverted_at) throw new HttpError(409, "This AI edit has already been reverted");
    if (!revision.block_id || revision.before_text === null || !revision.after_fingerprint) throw new HttpError(409, "This historical version can be exported but not safely reverted");
    const current = blocks(this.document).find((block) => block.id === revision.block_id);
    if (!current || richContentFingerprint(current.json) !== revision.after_fingerprint) throw new HttpError(409, "This paragraph changed after the AI edit. Copy the historical version instead of overwriting newer work.");
    const update = this.commitServerDocumentChange(participant.id, (origin) => {
      if (!replaceBlockText(this.document, revision.block_id!, revision.before_text!, origin)) throw new HttpError(409, "That paragraph no longer exists");
    }, ({ now }) => {
      const changed = this.ctx.storage.sql.exec("UPDATE revisions SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL", now, revisionId).rowsWritten;
      if (!changed) throw new HttpError(409, "This AI edit has already been reverted");
      this.insertAudit("revision.reverted", participant.id, { revisionId, blockId: revision.block_id }, now);
    });
    if (update.length) this.sendUpdateToOthers(update);
    await this.broadcastSnapshots();
    return json({ reverted: true, snapshot: this.getSnapshot(participant.id) });
  }

  private async revokeParticipant(request: Request, targetId: string): Promise<Response> {
    const participant = await this.authenticate(request);
    if (participant.role !== "owner") throw new HttpError(403, "Only the owner can revoke collaborators");
    if (targetId === participant.id) throw new HttpError(409, "The owner cannot revoke their own access");
    const target = this.participantById(targetId);
    if (!target) throw new HttpError(404, "Participant not found");
    this.ctx.storage.sql.exec("UPDATE participants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", Date.now(), targetId);
    this.addAudit("participant.revoked", participant.id, { participantId: targetId });
    this.disconnectParticipant(targetId, "Access revoked by the owner");
    await this.broadcastSnapshots();
    return json(this.getSnapshot(participant.id));
  }

  private async exportDocument(request: Request): Promise<Response> {
    await this.authenticate(request);
    const format = new URL(request.url).searchParams.get("format") === "text" ? "text" : "markdown";
    const body = format === "text" ? documentText(this.document) : documentMarkdown(this.document);
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }

  private getSnapshot(participantId: string): DocumentSnapshot {
    const document = this.getDocument();
    const participants = this.getParticipants();
    const participant = participants.find((item) => item.id === participantId);
    if (!participant) throw new HttpError(401, "Participant access is no longer active");
    return {
      document: { id: document.id, title: document.title, contentSequence: document.content_sequence, createdAt: document.created_at, updatedAt: document.updated_at },
      participant,
      participants,
      chatMessages: this.getChatMessages(),
      comments: this.getComments(),
      suggestions: this.getSuggestions(),
      revisions: this.getRevisions(),
      activeJob: this.ctx.storage.sql.exec<{ id: string; status: "queued" | "running" }>("SELECT id, status FROM ai_jobs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1").toArray()[0] ?? null,
    };
  }

  private getDocument(): DocumentRow {
    const row = this.ctx.storage.sql.exec<DocumentRow>("SELECT * FROM documents LIMIT 1").toArray()[0];
    if (!row) throw new HttpError(404, "Document not found");
    return row;
  }

  private getParticipants(): Participant[] {
    return this.ctx.storage.sql.exec<ParticipantRow>("SELECT id, display_name, role, joined_at, last_seen_at FROM participants WHERE revoked_at IS NULL ORDER BY joined_at").toArray().map((row) => ({
      id: row.id, displayName: row.display_name, role: row.role, joinedAt: row.joined_at, lastSeenAt: row.last_seen_at,
    }));
  }

  private getChatMessages(): ChatMessage[] {
    return this.ctx.storage.sql.exec<{
      id: string; participant_id: string | null; participant_name: string | null; kind: ChatMessage["kind"]; body: string; job_id: string | null; created_at: number;
    }>(`SELECT m.id, m.participant_id, p.display_name AS participant_name, m.kind, m.body, m.job_id, m.created_at
        FROM chat_messages m LEFT JOIN participants p ON p.id = m.participant_id ORDER BY m.created_at`).toArray().map((row) => ({
      id: row.id, participantId: row.participant_id, participantName: row.participant_name ?? "Draft AI", kind: row.kind,
      body: row.body, jobId: row.job_id, createdAt: row.created_at,
    }));
  }

  private getComments(): Comment[] {
    return this.ctx.storage.sql.exec<{
      id: string; block_id: string; participant_id: string; participant_name: string; body: string; resolved: number; created_at: number; updated_at: number;
    }>(`SELECT c.*, p.display_name AS participant_name FROM comments c JOIN participants p ON p.id = c.participant_id ORDER BY c.created_at DESC`).toArray().map((row) => ({
      id: row.id, blockId: row.block_id, participantId: row.participant_id, participantName: row.participant_name,
      body: row.body, resolved: Boolean(row.resolved), createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  private getSuggestions(): Suggestion[] {
    return this.ctx.storage.sql.exec<{
      id: string; job_id: string; block_id: string; before_text: string; after_text: string; before_fingerprint: string;
      rationale: string; status: Suggestion["status"]; requester_name: string; created_at: number; decided_at: number | null;
    }>(`SELECT s.*, p.display_name AS requester_name FROM suggestions s
        JOIN ai_jobs j ON j.id = s.job_id JOIN participants p ON p.id = j.participant_id
        ORDER BY s.created_at DESC`).toArray().map((row) => ({
      id: row.id, jobId: row.job_id, blockId: row.block_id, beforeText: row.before_text, afterText: row.after_text,
      beforeFingerprint: row.before_fingerprint, rationale: row.rationale, status: row.status,
      requesterName: row.requester_name, createdAt: row.created_at, decidedAt: row.decided_at,
    }));
  }

  private getRevisions(): Revision[] {
    const current = new Map(blocks(this.document).map((block) => [block.id, richContentFingerprint(block.json)]));
    return this.ctx.storage.sql.exec<{ id: string; label: string; actor_name: string; created_at: number; export_text: string; block_id: string | null; after_fingerprint: string | null; reverted_at: number | null }>(
      `SELECT r.id, r.label, p.display_name AS actor_name, r.created_at, r.export_text,
              r.block_id, r.after_fingerprint, r.reverted_at FROM revisions r
       JOIN participants p ON p.id = r.actor_id ORDER BY r.created_at DESC LIMIT 30`,
    ).toArray().map((row) => ({
      id: row.id, label: row.label, actorName: row.actor_name, createdAt: row.created_at, exportText: row.export_text,
      canRevert: Boolean(!row.reverted_at && row.block_id && row.after_fingerprint && current.get(row.block_id) === row.after_fingerprint),
    }));
  }

  private async authenticate(request: Request): Promise<Participant> {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new HttpError(401, "Private access token required");
    const participant = await this.participantByToken(token);
    if (!participant) throw new HttpError(401, "Private access token is invalid");
    this.ctx.storage.sql.exec("UPDATE participants SET last_seen_at = ? WHERE id = ?", Date.now(), participant.id);
    return participant;
  }

  private async participantByToken(token: string): Promise<Participant | null> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;
    const hash = await hashToken(token);
    const row = this.ctx.storage.sql.exec<ParticipantRow>(
      "SELECT id, display_name, role, joined_at, last_seen_at FROM participants WHERE token_hash = ? AND revoked_at IS NULL",
      hash,
    ).toArray()[0];
    return row ? { id: row.id, displayName: row.display_name, role: row.role, joinedAt: row.joined_at, lastSeenAt: row.last_seen_at } : null;
  }

  private participantById(id: string): Participant | null {
    const row = this.ctx.storage.sql.exec<ParticipantRow>(
      "SELECT id, display_name, role, joined_at, last_seen_at FROM participants WHERE id = ? AND revoked_at IS NULL", id,
    ).toArray()[0];
    return row ? { id: row.id, displayName: row.display_name, role: row.role, joinedAt: row.joined_at, lastSeenAt: row.last_seen_at } : null;
  }

  private async invitationByToken(token: string): Promise<{ id: string; role: "editor" | "viewer" } | null> {
    const hash = await hashToken(token);
    return this.ctx.storage.sql.exec<{ id: string; role: "editor" | "viewer" }>(
      "SELECT id, role FROM invitations WHERE token_hash = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?", hash, Date.now(),
    ).toArray()[0] ?? null;
  }

  private requireEdit(participant: Participant): void {
    if (participant.role === "viewer") throw new HttpError(403, "Viewers have read-only access");
  }

  private documentExists(): boolean {
    return Boolean(this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM documents LIMIT 1").toArray()[0]);
  }

  private participantActive(id: string): boolean {
    return Boolean(this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM participants WHERE id = ? AND revoked_at IS NULL", id).toArray()[0]);
  }

  private submissionExists(id: string): boolean {
    return Boolean(this.ctx.storage.sql.exec<{ sequence: number }>("SELECT sequence FROM y_updates WHERE submission_id = ?", id).toArray()[0]);
  }

  private contentSequence(): number {
    return this.documentExists() ? this.getDocument().content_sequence : 0;
  }

  private commitServerDocumentChange(
    participantId: string,
    mutate: (origin: Origin) => void,
    commitMetadata: (context: { beforeState: Uint8Array; beforeExport: string; now: number; sequence: number }) => void,
  ): Uint8Array {
    const beforeState = Y.encodeStateAsUpdate(this.document);
    const beforeVector = Y.encodeStateVector(this.document);
    const beforeExport = documentMarkdown(this.document);
    const origin = { kind: "server-atomic", participantId, submissionId: crypto.randomUUID() } satisfies Origin;
    try {
      this.document.transact(() => mutate(origin), origin);
      validateDocument(this.document, { maxCharacters: MAX_DOCUMENT_CHARACTERS, maxStateBytes: MAX_DOCUMENT_STATE_BYTES });
      const update = Y.encodeStateAsUpdate(this.document, beforeVector);
      if (!update.length) throw new HttpError(409, "The requested edit did not change the document");
      const now = Date.now();
      let sequence = 0;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO y_updates (update_blob, participant_id, submission_id, created_at) VALUES (?, ?, ?, ?)",
          toArrayBuffer(update), participantId, origin.submissionId, now,
        );
        sequence = this.ctx.storage.sql.exec<{ sequence: number }>("SELECT last_insert_rowid() AS sequence").one().sequence;
        this.ctx.storage.sql.exec("UPDATE documents SET content_sequence = ?, updated_at = ?", sequence, now);
        commitMetadata({ beforeState, beforeExport, now, sequence });
      });
      if (sequence % CHECKPOINT_INTERVAL === 0) this.tryCheckpoint(sequence);
      return update;
    } catch (error) {
      this.loadDocument();
      this.attachDocumentListeners();
      throw error;
    }
  }

  private checkpoint(sequence: number): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO y_checkpoints (id, covered_sequence, state_blob, created_at) VALUES (1, ?, ?, ?)", sequence, toArrayBuffer(Y.encodeStateAsUpdate(this.document)), Date.now());
      this.ctx.storage.sql.exec("DELETE FROM y_updates WHERE sequence <= ?", sequence);
    });
  }

  private tryCheckpoint(sequence: number): void {
    try { this.checkpoint(sequence); } catch (error) { console.error("Document checkpoint failed", error); }
  }

  private addAudit(type: string, actorId: string | null, payload: unknown): void {
    this.insertAudit(type, actorId, payload, Date.now());
  }

  private insertAudit(type: string, actorId: string | null, payload: unknown, now: number): void {
    this.ctx.storage.sql.exec("INSERT INTO audit_events (type, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)", type, actorId, JSON.stringify(payload), now);
  }

  private enforceRateLimit(kind: string, participantId: string, limit: number, windowMs: number): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM usage_events WHERE created_at < ?", now - 24 * 60 * 60_000);
      if (this.usageInWindow(kind, participantId, windowMs) >= limit) throw new HttpError(429, "This action is temporarily rate limited");
      this.recordUsage(kind, participantId, 1, now);
    });
  }

  private usageInWindow(kind: string, participantId: string | null, windowMs: number): number {
    const since = Date.now() - windowMs;
    if (participantId) {
      return this.ctx.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE kind = ? AND participant_id = ? AND created_at >= ?", kind, participantId, since).one().total;
    }
    return this.ctx.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(amount), 0) AS total FROM usage_events WHERE kind = ? AND created_at >= ?", kind, since).one().total;
  }

  private recordUsage(kind: string, participantId: string | null, amount: number, now: number): void {
    this.ctx.storage.sql.exec("INSERT INTO usage_events (kind, participant_id, amount, created_at) VALUES (?, ?, ?, ?)", kind, participantId, amount, now);
  }

  private socketOwningAwareness(clientId: number): WebSocket | null {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.awarenessClientIds.includes(clientId)) return socket;
    }
    return null;
  }

  private sendUpdateToOthers(update: Uint8Array, except?: WebSocket): void {
    this.sendToOthers(envelope(UPDATE_MESSAGE, update), except);
  }

  private sendToOthers(message: ArrayBuffer | string, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) {
        try { socket.send(message); } catch { /* closed sockets are discarded by the runtime */ }
      }
    }
  }

  private broadcastFullState(): void {
    this.sendToOthers(envelope(UPDATE_MESSAGE, Y.encodeStateAsUpdate(this.document)));
  }

  private async broadcastSnapshots(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      try { socket.send(JSON.stringify({ type: "snapshot", snapshot: this.getSnapshot(attachment.participantId) })); } catch { /* ignore closed socket */ }
    }
  }

  private disconnectParticipant(participantId: string, reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.participantId === participantId) {
        try { socket.send(JSON.stringify({ type: "access-revoked", error: reason })); } catch { /* socket already closed */ }
        socket.close(4003, reason);
      }
    }
  }
}

function envelope(kind: number, body: Uint8Array): ArrayBuffer {
  const message = new Uint8Array(body.length + 1);
  message[0] = kind;
  message.set(body, 1);
  return message.buffer;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function participantColor(id: string): string {
  const palette = ["#6554e8", "#0b8f74", "#d25f3f", "#1b74c8", "#a443a7"];
  let value = 0;
  for (let index = 0; index < id.length; index += 1) value = (value * 31 + id.charCodeAt(index)) >>> 0;
  return palette[value % palette.length];
}

function awarenessEntries(update: Uint8Array): Array<{ clientId: number; state: unknown }> {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > 4) throw new Error("Too many awareness states");
  const entries: Array<{ clientId: number; state: unknown }> = [];
  for (let index = 0; index < count; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    entries.push({ clientId, state: JSON.parse(decoding.readVarString(decoder)) });
  }
  return entries;
}

function isLocalOrigin(value: string | null): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}
