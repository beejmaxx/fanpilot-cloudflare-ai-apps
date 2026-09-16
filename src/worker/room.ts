import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  createRoomSchema,
  finalizeSchema,
  joinRoomSchema,
  messageSchema,
  voteSchema,
} from "../shared/schemas";
import type {
  AiProposal,
  AiSource,
  Constraint,
  ConstraintStrength,
  ConstraintType,
  Message,
  Participant,
  ParticipantRole,
  Proposal,
  Room,
  RoomSnapshot,
  RoomStage,
  Vote,
} from "../shared/types";
import { titleFromPrompt } from "../shared/title";
import { extractPlanningFacts } from "./ai";
import type { Env } from "./env";
import { errorResponse, HttpError, json, parseJson } from "./http";
import { isCurrentWorkflowResult } from "./workflow-state";

const initializeSchema = createRoomSchema.extend({ roomId: z.string().uuid() });
const workflowCommitSchema = z.object({
  workflowRunId: z.string().uuid(),
  sourceStateVersion: z.number().int().nonnegative(),
  source: z.enum(["workers-ai", "fallback"]),
  proposals: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      when: z.string(),
      where: z.string(),
      cost: z.string(),
      notes: z.array(z.string()),
      tradeoffs: z.array(z.string()),
      score: z.number(),
    }),
  ),
});

type RoomRow = {
  id: string;
  title: string;
  prompt: string;
  stage: RoomStage;
  state_version: number;
  created_at: number;
  updated_at: number;
  finalized_proposal_id: string | null;
  workflow_status: Room["workflowStatus"];
};

type ParticipantRow = {
  id: string;
  display_name: string;
  role: ParticipantRole;
  rsvp_status: Participant["rsvpStatus"];
  joined_at: number;
  last_seen_at: number;
};

type MessageRow = {
  id: string;
  participant_id: string | null;
  participant_name: string | null;
  kind: Message["kind"];
  body: string;
  created_at: number;
};

type ConstraintRow = {
  id: string;
  participant_id: string | null;
  participant_name: string | null;
  source_message_id: string | null;
  type: ConstraintType;
  value: string;
  strength: ConstraintStrength;
  status: Constraint["status"];
  created_at: number;
  updated_at: number;
};

type ProposalRow = {
  id: string;
  proposal_set_id: string;
  title: string;
  summary: string;
  details_json: string;
  tradeoffs_json: string;
  score: number;
  votes: number;
  created_at: number;
};

type VoteRow = {
  proposal_id: string;
  participant_id: string;
  value: 1 | -1;
  reason: string;
  created_at: number;
  updated_at: number;
};

interface SocketAttachment {
  participantId: string;
}

export class RallyRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        stage TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finalized_proposal_id TEXT,
        workflow_status TEXT NOT NULL DEFAULT 'idle'
      );

      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        rsvp_status TEXT NOT NULL DEFAULT 'pending',
        token_hash TEXT NOT NULL UNIQUE,
        joined_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        participant_id TEXT,
        client_id TEXT UNIQUE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);

      CREATE TABLE IF NOT EXISTS constraints (
        id TEXT PRIMARY KEY,
        participant_id TEXT,
        source_message_id TEXT,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        strength TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS constraints_type ON constraints(type);

      CREATE TABLE IF NOT EXISTS proposal_sets (
        id TEXT PRIMARY KEY,
        source_state_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        proposal_set_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        tradeoffs_json TEXT NOT NULL,
        score REAL NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS votes (
        proposal_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        value INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (proposal_id, participant_id)
      );

      CREATE TABLE IF NOT EXISTS room_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        source_state_version INTEGER NOT NULL,
        workflow_instance_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/initialize") return await this.initialize(request);
      if (request.method === "POST" && url.pathname === "/join") return await this.join(request);
      if (request.method === "GET" && url.pathname === "/snapshot") return await this.snapshotResponse(request);
      if (request.method === "GET" && url.pathname === "/ws") return await this.connectWebSocket(request);
      if (request.method === "POST" && url.pathname === "/message") return await this.postMessage(request);
      if (request.method === "POST" && url.pathname === "/generate") return await this.generateProposals(request);
      if (request.method === "POST" && url.pathname === "/vote") return await this.vote(request);
      if (request.method === "POST" && url.pathname === "/finalize") return await this.finalize(request);
      if (request.method === "GET" && url.pathname === "/internal/workflow-snapshot") return this.workflowSnapshot(url);
      if (request.method === "POST" && url.pathname === "/internal/workflow-commit") return await this.commitWorkflow(request);
      if (request.method === "POST" && url.pathname === "/internal/workflow-failed") return await this.failWorkflow(request);
      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async initialize(request: Request): Promise<Response> {
    if (this.roomExists()) throw new HttpError(409, "Room already exists");
    const input = await parseJson(request, initializeSchema);
    const participantId = crypto.randomUUID();
    const token = randomToken();
    const tokenHash = await hashToken(token);
    const now = Date.now();
    const title = titleFromPrompt(input.prompt);

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO room (id, title, prompt, stage, state_version, created_at, updated_at, workflow_status) VALUES (?, ?, ?, 'collecting', 1, ?, ?, 'idle')",
        input.roomId,
        title,
        input.prompt,
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO participants (id, display_name, role, rsvp_status, token_hash, joined_at, last_seen_at) VALUES (?, ?, 'organizer', 'yes', ?, ?, ?)",
        participantId,
        input.organizerName,
        tokenHash,
        now,
        now,
      );
      const messageId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (id, participant_id, client_id, kind, body, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
        messageId,
        participantId,
        crypto.randomUUID(),
        input.prompt,
        now,
      );
      this.addEvent("room.created", participantId, { title, prompt: input.prompt });
    });

    const extraction = await extractPlanningFacts(this.env.AI, input.prompt, input.organizerName, []);
    this.ctx.storage.transactionSync(() => {
      const sourceMessage = this.ctx.storage.sql
        .exec<{ id: string }>("SELECT id FROM messages ORDER BY created_at ASC LIMIT 1")
        .one().id;
      this.insertConstraints(extraction.constraints, participantId, sourceMessage, now);
      this.insertAgentMessage(
        `I started the room and captured the first details. Share this room so everyone can add their constraints.`,
        now + 1,
      );
      this.addEvent("agent.responded", null, { sourceMessageId: sourceMessage, aiSource: extraction.source });
      this.bumpVersion();
    });

    return json({
      roomId: input.roomId,
      participantId,
      token,
      role: "organizer",
      snapshot: this.getSnapshot(),
    });
  }

  private async join(request: Request): Promise<Response> {
    this.assertRoomExists();
    const input = await parseJson(request, joinRoomSchema);
    const id = crypto.randomUUID();
    const token = randomToken();
    const tokenHash = await hashToken(token);
    const now = Date.now();

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO participants (id, display_name, role, rsvp_status, token_hash, joined_at, last_seen_at) VALUES (?, ?, 'participant', 'pending', ?, ?, ?)",
        id,
        input.displayName,
        tokenHash,
        now,
        now,
      );
      this.insertSystemMessage(`${input.displayName} joined the room`, now);
      this.addEvent("participant.joined", id, { displayName: input.displayName });
      this.bumpVersion();
    });
    await this.broadcastSnapshot();
    return json({ roomId: this.getRoom().id, participantId: id, token, role: "participant", snapshot: this.getSnapshot() });
  }

  private async snapshotResponse(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    this.touchParticipant(participant.id);
    return json(this.getSnapshot());
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim());
    if (protocols[0] !== "rally" || !protocols[1]) throw new HttpError(401, "Missing room session");
    const token = protocols[1];
    const participant = await this.participantForToken(token);
    if (!participant) throw new HttpError(401, "Invalid room session");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ participantId: participant.id } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "snapshot", snapshot: this.getSnapshot() }));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "rally" },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }
    if (message === "sync") ws.send(JSON.stringify({ type: "snapshot", snapshot: this.getSnapshot() }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "Connection error");
  }

  private async postMessage(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    const input = await parseJson(request, messageSchema);
    const existing = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM messages WHERE client_id = ?", input.clientId)
      .toArray();
    if (existing.length) return json(this.getSnapshot());

    const messageId = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO messages (id, participant_id, client_id, kind, body, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
        messageId,
        participant.id,
        input.clientId,
        input.body,
        now,
      );
      this.addEvent("message.created", participant.id, { messageId });
      this.bumpVersion();
    });
    await this.broadcastSnapshot();

    const extraction = await extractPlanningFacts(this.env.AI, input.body, participant.displayName, this.getConstraints());
    this.ctx.storage.transactionSync(() => {
      this.insertConstraints(extraction.constraints, participant.id, messageId, Date.now());
      const reply = [extraction.acknowledgement, extraction.followUpQuestion].filter(Boolean).join(" ");
      this.insertAgentMessage(reply, Date.now());
      this.addEvent("agent.responded", null, { sourceMessageId: messageId, aiSource: extraction.source });
      this.bumpVersion();
    });
    await this.broadcastSnapshot();
    return json(this.getSnapshot());
  }

  private async generateProposals(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    if (participant.role !== "organizer") throw new HttpError(403, "Only the organizer can create proposals");
    const room = this.getRoom();
    if (room.stage === "generating") throw new HttpError(409, "Proposal generation is already running");

    const workflowRunId = crypto.randomUUID();
    const workflowInstanceId = `room-${room.id}-${workflowRunId}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM votes");
      this.ctx.storage.sql.exec("DELETE FROM proposals");
      this.ctx.storage.sql.exec("DELETE FROM proposal_sets");
      this.ctx.storage.sql.exec(
        "UPDATE room SET stage = 'generating', finalized_proposal_id = NULL, workflow_status = 'running', state_version = state_version + 1, updated_at = ?",
        now,
      );
      const sourceVersion = this.getRoom().stateVersion;
      this.ctx.storage.sql.exec(
        "INSERT INTO workflow_runs (id, source_state_version, workflow_instance_id, kind, status, created_at) VALUES (?, ?, ?, 'proposal-generation', 'running', ?)",
        workflowRunId,
        sourceVersion,
        workflowInstanceId,
        now,
      );
      this.addEvent("proposal_generation.started", participant.id, { workflowRunId, sourceVersion });
    });

    const sourceStateVersion = this.getRoom().stateVersion;
    try {
      await this.env.PROPOSAL_WORKFLOW.create({
        id: workflowInstanceId,
        params: { roomId: room.id, sourceStateVersion, workflowRunId, requestedBy: participant.id },
      });
    } catch (error) {
      this.markWorkflowFailed(workflowRunId, error instanceof Error ? error.message : "Could not start workflow");
      throw error;
    }
    await this.broadcastSnapshot();
    return json({ workflowRunId, snapshot: this.getSnapshot() }, { status: 202 });
  }

  private async vote(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    const input = await parseJson(request, voteSchema);
    const room = this.getRoom();
    if (room.stage !== "voting") throw new HttpError(409, "Voting is not open");
    if (!this.proposalExists(input.proposalId)) throw new HttpError(404, "Proposal not found");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      // A participant has one active choice. Re-voting moves that choice.
      this.ctx.storage.sql.exec("DELETE FROM votes WHERE participant_id = ?", participant.id);
      this.ctx.storage.sql.exec(
        `INSERT INTO votes (proposal_id, participant_id, value, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(proposal_id, participant_id) DO UPDATE SET value = excluded.value, reason = excluded.reason, updated_at = excluded.updated_at`,
        input.proposalId,
        participant.id,
        input.value,
        input.reason,
        now,
        now,
      );
      this.addEvent("vote.upserted", participant.id, { proposalId: input.proposalId, value: input.value });
      this.bumpVersion();
    });
    await this.broadcastSnapshot();
    return json(this.getSnapshot());
  }

  private async finalize(request: Request): Promise<Response> {
    const participant = await this.authenticate(request);
    if (participant.role !== "organizer") throw new HttpError(403, "Only the organizer can finalize the plan");
    const input = await parseJson(request, finalizeSchema);
    if (!this.proposalExists(input.proposalId)) throw new HttpError(404, "Proposal not found");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE room SET stage = 'finalized', finalized_proposal_id = ?, workflow_status = 'complete', state_version = state_version + 1, updated_at = ?",
        input.proposalId,
        now,
      );
      const proposal = this.ctx.storage.sql.exec<{ title: string }>("SELECT title FROM proposals WHERE id = ?", input.proposalId).one();
      this.insertSystemMessage(`The group finalized “${proposal.title}”`, now);
      this.addEvent("plan.finalized", participant.id, { proposalId: input.proposalId });
    });
    await this.broadcastSnapshot();
    return json(this.getSnapshot());
  }

  private workflowSnapshot(url: URL): Response {
    const sourceStateVersion = Number(url.searchParams.get("stateVersion"));
    const room = this.getRoom();
    if (room.stateVersion !== sourceStateVersion || room.stage !== "generating") {
      throw new HttpError(409, "Room changed while proposal generation was starting");
    }
    const snapshot = this.getSnapshot();
    return json({ room: snapshot.room, participants: snapshot.participants, constraints: snapshot.constraints });
  }

  private async commitWorkflow(request: Request): Promise<Response> {
    const input = await parseJson(request, workflowCommitSchema);
    const room = this.getRoom();
    if (!isCurrentWorkflowResult(room, input.sourceStateVersion)) {
      throw new HttpError(409, "Room changed while proposals were being generated");
    }
    const run = this.ctx.storage.sql
      .exec<{ status: string }>("SELECT status FROM workflow_runs WHERE id = ?", input.workflowRunId)
      .toArray()[0];
    if (!run) throw new HttpError(404, "Workflow run not found");
    if (run.status === "complete") return json(this.getSnapshot());

    const now = Date.now();
    const proposalSetId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO proposal_sets (id, source_state_version, status, created_at) VALUES (?, ?, 'ready', ?)",
        proposalSetId,
        input.sourceStateVersion,
        now,
      );
      for (const proposal of input.proposals) this.insertProposal(proposalSetId, proposal, now);
      this.ctx.storage.sql.exec(
        "UPDATE workflow_runs SET status = 'complete', completed_at = ? WHERE id = ?",
        now,
        input.workflowRunId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE room SET stage = 'voting', workflow_status = 'complete', state_version = state_version + 1, updated_at = ?",
        now,
      );
      this.insertAgentMessage("I created three options from the group's confirmed constraints. Review the tradeoffs, then vote for the plan you prefer.", now);
      this.addEvent("proposal_set.ready", null, { proposalSetId, aiSource: input.source });
    });
    await this.broadcastSnapshot();
    return json(this.getSnapshot());
  }

  private async failWorkflow(request: Request): Promise<Response> {
    const body = await request.json<{ workflowRunId?: string; error?: string }>();
    if (!body.workflowRunId) throw new HttpError(400, "Missing workflow run ID");
    this.markWorkflowFailed(body.workflowRunId, body.error ?? "Proposal generation failed");
    await this.broadcastSnapshot();
    return json(this.getSnapshot());
  }

  private markWorkflowFailed(workflowRunId: string, error: string): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE workflow_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
        error.slice(0, 1_000),
        now,
        workflowRunId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE room SET stage = 'collecting', workflow_status = 'failed', state_version = state_version + 1, updated_at = ?",
        now,
      );
      this.insertAgentMessage("I couldn't create the options this time. The room is intact, so the organizer can try again.", now);
      this.addEvent("proposal_generation.failed", null, { workflowRunId });
    });
  }

  private roomExists(): boolean {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM room").one().count > 0;
  }

  private assertRoomExists(): void {
    if (!this.roomExists()) throw new HttpError(404, "Room not found");
  }

  private getRoom(): Room {
    this.assertRoomExists();
    const row = this.ctx.storage.sql.exec<RoomRow>("SELECT * FROM room LIMIT 1").one();
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      stage: row.stage,
      stateVersion: row.state_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finalizedProposalId: row.finalized_proposal_id,
      workflowStatus: row.workflow_status,
    };
  }

  private getParticipants(): Participant[] {
    return this.ctx.storage.sql
      .exec<ParticipantRow>("SELECT id, display_name, role, rsvp_status, joined_at, last_seen_at FROM participants ORDER BY joined_at")
      .toArray()
      .map((row) => ({
        id: row.id,
        displayName: row.display_name,
        role: row.role,
        rsvpStatus: row.rsvp_status,
        joinedAt: row.joined_at,
        lastSeenAt: row.last_seen_at,
      }));
  }

  private getMessages(): Message[] {
    return this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT m.id, m.participant_id, p.display_name AS participant_name, m.kind, m.body, m.created_at
         FROM messages m LEFT JOIN participants p ON p.id = m.participant_id
         ORDER BY m.created_at, m.rowid`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        participantId: row.participant_id,
        participantName: row.participant_name ?? (row.kind === "agent" ? "Rally" : "System"),
        kind: row.kind,
        body: row.body,
        createdAt: row.created_at,
      }));
  }

  private getConstraints(): Constraint[] {
    return this.ctx.storage.sql
      .exec<ConstraintRow>(
        `SELECT c.id, c.participant_id, p.display_name AS participant_name, c.source_message_id,
                c.type, c.value, c.strength, c.status, c.created_at, c.updated_at
         FROM constraints c LEFT JOIN participants p ON p.id = c.participant_id
         ORDER BY CASE c.strength WHEN 'hard' THEN 0 ELSE 1 END, c.created_at`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        participantId: row.participant_id,
        participantName: row.participant_name ?? "Rally",
        sourceMessageId: row.source_message_id,
        type: row.type,
        value: row.value,
        strength: row.strength,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private getProposals(): Proposal[] {
    return this.ctx.storage.sql
      .exec<ProposalRow>(
        `SELECT p.*, COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS votes
         FROM proposals p LEFT JOIN votes v ON v.proposal_id = p.id
         GROUP BY p.id ORDER BY p.score DESC, p.created_at`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        proposalSetId: row.proposal_set_id,
        title: row.title,
        summary: row.summary,
        details: JSON.parse(row.details_json) as Proposal["details"],
        tradeoffs: JSON.parse(row.tradeoffs_json) as string[],
        score: row.score,
        votes: Number(row.votes),
        createdAt: row.created_at,
      }));
  }

  private getVotes(): Vote[] {
    return this.ctx.storage.sql
      .exec<VoteRow>("SELECT * FROM votes ORDER BY created_at")
      .toArray()
      .map((row) => ({
        proposalId: row.proposal_id,
        participantId: row.participant_id,
        value: row.value,
        reason: row.reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private getSnapshot(): RoomSnapshot {
    const eventSequence = this.ctx.storage.sql
      .exec<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM room_events")
      .one().sequence;
    return {
      room: this.getRoom(),
      participants: this.getParticipants(),
      messages: this.getMessages(),
      constraints: this.getConstraints(),
      proposals: this.getProposals(),
      votes: this.getVotes(),
      eventSequence: eventSequence ?? 0,
      aiUsage: {
        extraction: this.latestAiSource("agent.responded"),
        proposals: this.latestAiSource("proposal_set.ready"),
      },
    };
  }

  private latestAiSource(eventType: string): AiSource | null {
    const row = this.ctx.storage.sql
      .exec<{ payload_json: string }>(
        "SELECT payload_json FROM room_events WHERE type = ? ORDER BY sequence DESC LIMIT 1",
        eventType,
      )
      .toArray()[0];
    if (!row) return null;
    try {
      const source = (JSON.parse(row.payload_json) as { aiSource?: unknown }).aiSource;
      return source === "workers-ai" || source === "fallback" ? source : null;
    } catch {
      return null;
    }
  }

  private insertConstraints(
    constraints: Array<{ type: ConstraintType; value: string; strength: ConstraintStrength }>,
    participantId: string,
    sourceMessageId: string,
    now: number,
  ): void {
    for (const constraint of constraints) {
      const duplicate = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM constraints WHERE participant_id = ? AND type = ? AND lower(value) = lower(?) LIMIT 1",
          participantId,
          constraint.type,
          constraint.value,
        )
        .toArray()[0];
      if (duplicate) continue;
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO constraints (id, participant_id, source_message_id, type, value, strength, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'inferred', ?, ?)",
        id,
        participantId,
        sourceMessageId,
        constraint.type,
        constraint.value,
        constraint.strength,
        now,
        now,
      );
      this.addEvent("constraint.upserted", participantId, { constraintId: id, type: constraint.type });
    }
  }

  private insertProposal(proposalSetId: string, proposal: AiProposal, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO proposals (id, proposal_set_id, title, summary, details_json, tradeoffs_json, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      proposalSetId,
      proposal.title,
      proposal.summary,
      JSON.stringify({ when: proposal.when, where: proposal.where, cost: proposal.cost, notes: proposal.notes }),
      JSON.stringify(proposal.tradeoffs),
      proposal.score,
      now,
    );
  }

  private insertAgentMessage(body: string, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, participant_id, client_id, kind, body, created_at) VALUES (?, NULL, NULL, 'agent', ?, ?)",
      crypto.randomUUID(),
      body,
      now,
    );
  }

  private insertSystemMessage(body: string, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (id, participant_id, client_id, kind, body, created_at) VALUES (?, NULL, NULL, 'system', ?, ?)",
      crypto.randomUUID(),
      body,
      now,
    );
  }

  private addEvent(type: string, actorId: string | null, payload: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO room_events (type, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
      type,
      actorId,
      JSON.stringify(payload),
      Date.now(),
    );
  }

  private bumpVersion(): void {
    this.ctx.storage.sql.exec("UPDATE room SET state_version = state_version + 1, updated_at = ?", Date.now());
  }

  private proposalExists(id: string): boolean {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM proposals WHERE id = ?", id).one().count > 0;
  }

  private async authenticate(request: Request): Promise<Participant> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const participant = await this.participantForToken(token);
    if (!participant) throw new HttpError(401, "Invalid room session");
    return participant;
  }

  private async participantForToken(token: string): Promise<Participant | null> {
    if (!token) return null;
    const tokenHash = await hashToken(token);
    const row = this.ctx.storage.sql
      .exec<ParticipantRow & { token_hash: string }>(
        "SELECT id, display_name, role, rsvp_status, token_hash, joined_at, last_seen_at FROM participants WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      rsvpStatus: row.rsvp_status,
      joinedAt: row.joined_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  private touchParticipant(participantId: string): void {
    this.ctx.storage.sql.exec("UPDATE participants SET last_seen_at = ? WHERE id = ?", Date.now(), participantId);
  }

  private async broadcastSnapshot(): Promise<void> {
    const payload = JSON.stringify({ type: "snapshot", snapshot: this.getSnapshot() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.warn("Could not broadcast room snapshot", error);
      }
    }
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
