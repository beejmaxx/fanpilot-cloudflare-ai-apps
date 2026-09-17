import { DurableObject } from "cloudflare:workers";
import {
  analysisCommitSchema, chatSchema, createInvitationSchema, factUpdateSchema, generationCommitSchema,
  initializeWorkspaceSchema, invitationInfoSchema, joinWorkspaceSchema, postUpdateSchema,
  publishPostSchema, schedulePostSchema, sourceUpdateSchema,
} from "../shared/schemas";
import { scheduleChangeNeedsReview } from "../shared/logic";
import type {
  AnalysisInput, CampaignInfo, CampaignPost, ChatMessage, GenerationInput, Participant, ParticipantRole,
  RelaySnapshot, ReleaseFact, WorkspaceInfo,
} from "../shared/types";
import type { Env } from "./env";
import { errorResponse, HttpError, json, parseJson } from "./http";
import { answerClarification } from "./ai";

interface SocketAttachment { participantId: string; }
interface ParticipantRow { [key: string]: SqlStorageValue; id: string; display_name: string; role: ParticipantRole; }
interface FactRow { [key: string]: SqlStorageValue; id: string; label: string; value: string; excerpt: string; source_kind: "release" | "owner"; confirmed: number; revision: number; updated_at: number; }
interface PostRow { [key: string]: SqlStorageValue; id: string; channel: "linkedin" | "x"; purpose: "announcement" | "feature-follow-up"; body: string; revision: number; editorial_state: "draft" | "needs_changes" | "approved"; dependency_ids: string; planned_at: number | null; published_at: number | null; published_url: string | null; correction_needed: number; updated_at: number; }

export class LaunchWorkspace extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.initializeSchema());
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
      if (request.method === "POST" && pathname === "/invitations") return await this.createInvitation(request);
      if (request.method === "POST" && pathname === "/participant/rotate-access") return await this.rotateAccess(request);
      if (request.method === "PATCH" && /^\/facts\/[^/]+$/.test(pathname)) return await this.updateFact(request, pathname.split("/")[2]);
      if (request.method === "POST" && pathname === "/generate") return await this.generate(request);
      if (request.method === "PATCH" && /^\/posts\/[^/]+$/.test(pathname)) return await this.updatePost(request, pathname.split("/")[2]);
      if (request.method === "POST" && /^\/posts\/[^/]+\/approve$/.test(pathname)) return await this.approvePost(request, pathname.split("/")[2]);
      if (request.method === "POST" && /^\/posts\/[^/]+\/schedule$/.test(pathname)) return await this.schedulePost(request, pathname.split("/")[2]);
      if (request.method === "POST" && /^\/posts\/[^/]+\/publish$/.test(pathname)) return await this.publishPost(request, pathname.split("/")[2]);
      if (request.method === "POST" && pathname === "/source") return await this.updateSource(request);
      if (request.method === "POST" && pathname === "/chat") return await this.chat(request);
      if (request.method === "GET" && pathname === "/internal/analysis-input") return this.analysisInput(new URL(request.url));
      if (request.method === "POST" && pathname === "/internal/analysis-commit") return await this.commitAnalysis(request);
      if (request.method === "GET" && pathname === "/internal/generation-input") return this.generationInput(new URL(request.url));
      if (request.method === "POST" && pathname === "/internal/generation-commit") return await this.commitGeneration(request);
      if (request.method === "POST" && pathname === "/internal/job-failed") return await this.failJob(request);
      return json({ error: "Not found" }, { status: 404 });
    } catch (error) { return errorResponse(error); }
  }

  async alarm(): Promise<void> { await this.broadcastSnapshots(); await this.scheduleNextAlarm(); }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || !this.participantById(attachment.participantId)) { socket.close(4003, "Access revoked"); return; }
    if (message === "sync") socket.send(JSON.stringify({ type: "snapshot", snapshot: this.snapshotFor(attachment.participantId) }));
    if (message === "ping") socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
  }

  webSocketClose(socket: WebSocket): void { socket.close(1000, "Closed"); }
  webSocketError(socket: WebSocket): void { socket.close(1011, "Connection error"); }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, product_name TEXT NOT NULL, website TEXT NOT NULL, audience TEXT NOT NULL, tone TEXT NOT NULL, timezone TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_kind TEXT NOT NULL, source_url TEXT, source_body TEXT NOT NULL, source_checked_at INTEGER NOT NULL, stage TEXT NOT NULL, question TEXT, paused INTEGER NOT NULL DEFAULT 0, allow_fallback INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_snapshots (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_url TEXT, source_body TEXT NOT NULL, content_hash TEXT NOT NULL, checked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, label TEXT NOT NULL, value TEXT NOT NULL, excerpt TEXT NOT NULL, source_kind TEXT NOT NULL, confirmed INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fact_revisions (fact_id TEXT NOT NULL, revision INTEGER NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, excerpt TEXT NOT NULL, confirmed INTEGER NOT NULL, actor_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(fact_id, revision));
      CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, channel TEXT NOT NULL, purpose TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL, editorial_state TEXT NOT NULL, dependency_ids TEXT NOT NULL, planned_at INTEGER, published_at INTEGER, published_url TEXT, correction_needed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS post_revisions (post_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, actor_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(post_id, revision));
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, post_revision INTEGER NOT NULL, dependency_fingerprint TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at INTEGER NOT NULL, invalidated_at INTEGER, invalidation_reason TEXT);
      CREATE TABLE IF NOT EXISTS publication_records (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, post_revision INTEGER NOT NULL, published_url TEXT, published_at INTEGER NOT NULL, actor_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS correction_tasks (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, participant_id TEXT, participant_name TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, client_id TEXT UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, workflow_id TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_posts_planned ON posts(planned_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    `);
  }

  private async initialize(request: Request): Promise<Response> {
    if (this.exists()) throw new HttpError(409, "Workspace already exists");
    const input = await parseJson(request, initializeWorkspaceSchema);
    const now = Date.now(); const participantId = crypto.randomUUID(); const token = randomToken(); const campaignId = crypto.randomUUID();
    const jobId = crypto.randomUUID(); const workflowId = `analysis-${input.workspaceId}-${jobId}`;
    const hash = await sha256(input.sourceBody);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO workspace VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)", input.workspaceId, input.productName, input.website, input.audience, input.tone, input.timezone, now, now);
      this.ctx.storage.sql.exec("INSERT INTO participants (id, display_name, role, token_hash) VALUES (?, ?, 'owner', ?)", participantId, input.displayName, "pending");
      this.ctx.storage.sql.exec("INSERT INTO campaigns VALUES (?, ?, ?, ?, ?, ?, 'facts', NULL, 0, ?, ?, ?)", campaignId, input.campaignTitle, input.sourceKind, input.sourceUrl || null, input.sourceBody, input.sourceCheckedAt, Number(input.allowFallback), now, now);
      this.ctx.storage.sql.exec("INSERT INTO source_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), campaignId, input.sourceKind, input.sourceUrl || null, input.sourceBody, hash, input.sourceCheckedAt);
      this.ctx.storage.sql.exec("INSERT INTO jobs VALUES (?, 'analysis', 'running', ?, NULL, ?, NULL)", jobId, workflowId, now);
    });
    this.ctx.storage.sql.exec("UPDATE participants SET token_hash = ? WHERE id = ?", await hashToken(token), participantId);
    try { await this.env.RELEASE_ANALYSIS_WORKFLOW.create({ id: workflowId, params: { workspaceId: input.workspaceId, jobId } }); }
    catch (error) { this.markJobFailed(jobId, message(error)); }
    return json({ workspaceId: input.workspaceId, participantId, token, snapshot: this.snapshotFor(participantId) }, { status: 201 });
  }

  private async invitationInfo(request: Request): Promise<Response> {
    const { inviteToken } = await parseJson(request, invitationInfoSchema); const invite = await this.invitationByToken(inviteToken);
    if (!invite) throw new HttpError(404, "This invitation is invalid, expired, or already used");
    return json({ workspaceId: this.workspace().id, productName: this.workspace().productName, role: invite.role });
  }

  private async join(request: Request): Promise<Response> {
    const { inviteToken, displayName } = await parseJson(request, joinWorkspaceSchema); const invite = await this.invitationByToken(inviteToken);
    if (!invite) throw new HttpError(404, "This invitation is invalid, expired, or already used");
    const participantId = crypto.randomUUID(); const token = randomToken(); const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO participants (id, display_name, role, token_hash) VALUES (?, ?, ?, ?)", participantId, displayName, invite.role, "pending");
      this.ctx.storage.sql.exec("UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL", now, invite.id);
      this.audit("participant.joined", participantId, { role: invite.role });
    });
    this.ctx.storage.sql.exec("UPDATE participants SET token_hash = ? WHERE id = ?", await hashToken(token), participantId);
    await this.broadcastSnapshots();
    return json({ workspaceId: this.workspace().id, participantId, token, snapshot: this.snapshotFor(participantId) });
  }

  private async session(request: Request): Promise<Response> { const p = await this.authenticate(request); return json({ workspaceId: this.workspace().id, participantId: p.id, token: bearer(request), snapshot: this.snapshotFor(p.id) }); }
  private async snapshotResponse(request: Request): Promise<Response> { const p = await this.authenticate(request); return json(this.snapshotFor(p.id)); }

  private async connectWebSocket(request: Request): Promise<Response> {
    const protocols = (request.headers.get("sec-websocket-protocol") || "").split(",").map((v) => v.trim());
    if (protocols[0] !== "relay-v1" || !protocols[1]) throw new HttpError(401, "Private access token required");
    const p = await this.participantByToken(protocols[1]); if (!p) throw new HttpError(401, "Private access token is invalid");
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair); this.ctx.acceptWebSocket(server); server.serializeAttachment({ participantId: p.id } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "snapshot", snapshot: this.snapshotFor(p.id) }));
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "relay-v1" } });
  }

  private async createInvitation(request: Request): Promise<Response> {
    const p = await this.requireOwner(request); const { role } = await parseJson(request, createInvitationSchema); const token = randomToken(); const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO invitations VALUES (?, ?, ?, ?, ?, NULL, NULL)", crypto.randomUUID(), await hashToken(token), role, p.id, now + 30 * 86_400_000);
    const origin = request.headers.get("x-relay-origin") || "https://launch.fanpilot.app";
    return json({ invitationUrl: `${origin}/join/${this.workspace().id}#invite=${token}` });
  }

  private async rotateAccess(request: Request): Promise<Response> {
    const p = await this.authenticate(request); const token = randomToken(); this.ctx.storage.sql.exec("UPDATE participants SET token_hash = ? WHERE id = ?", await hashToken(token), p.id);
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment() as SocketAttachment | null; if (a?.participantId === p.id) ws.close(4003, "Access link rotated"); }
    return json({ workspaceId: this.workspace().id, participantId: p.id, token, snapshot: this.snapshotFor(p.id) });
  }

  private async updateFact(request: Request, factId: string): Promise<Response> {
    const p = await this.requireEditor(request); const input = await parseJson(request, factUpdateSchema); const current = this.factById(factId);
    if (!current) throw new HttpError(404, "Fact not found"); if (current.revision !== input.expectedRevision) throw new HttpError(409, "This fact changed. Review the latest version and try again");
    if (current.label === "Availability" && input.confirmed && /^not confirmed/i.test(input.value)) throw new HttpError(400, "Describe who can use the release and when before confirming availability");
    const nextRevision = current.revision + 1; const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO fact_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)", current.id, current.revision, current.label, current.value, current.excerpt, Number(current.confirmed), p.id, now);
      this.ctx.storage.sql.exec("UPDATE facts SET value = ?, confirmed = ?, revision = ?, source_kind = ?, updated_at = ? WHERE id = ?", input.value, Number(input.confirmed), nextRevision, input.value === current.value ? current.sourceKind : "owner", now, factId);
      this.invalidatePostsForFact(factId, current.value === input.value ? "Fact confirmation changed" : "Supporting fact changed", now);
      this.bump(); this.audit("fact.updated", p.id, { factId, revision: nextRevision });
    });
    await this.broadcastSnapshots(); return json(this.snapshotFor(p.id));
  }

  private async generate(request: Request): Promise<Response> {
    const p = await this.requireEditor(request); if (this.runningJob()) throw new HttpError(409, "An AI job is already running");
    const facts = this.facts(); if (!facts.length || facts.some((fact) => !fact.confirmed)) throw new HttpError(409, "Confirm every release fact before generating posts");
    const jobId = crypto.randomUUID(); const workflowId = `generation-${this.workspace().id}-${jobId}`; const now = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO jobs VALUES (?, 'generation', 'running', ?, NULL, ?, NULL)", jobId, workflowId, now);
    try { await this.env.CAMPAIGN_GENERATION_WORKFLOW.create({ id: workflowId, params: { workspaceId: this.workspace().id, jobId } }); }
    catch (error) { this.markJobFailed(jobId, message(error)); throw error; }
    await this.broadcastSnapshots(); return json({ jobId, snapshot: this.snapshotFor(p.id) }, { status: 202 });
  }

  private async updatePost(request: Request, postId: string): Promise<Response> {
    const p = await this.requireEditor(request); const input = await parseJson(request, postUpdateSchema); const post = this.postById(postId);
    if (!post) throw new HttpError(404, "Post not found"); if (post.revision !== input.expectedRevision) throw new HttpError(409, "This post changed. Your text is still in the editor; review the latest version before saving");
    if (post.publishedAt) throw new HttpError(409, "Published copy is preserved. Generate a correction instead");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO post_revisions VALUES (?, ?, ?, ?, ?)", post.id, post.revision, post.body, p.id, now);
      this.ctx.storage.sql.exec("UPDATE posts SET body = ?, revision = revision + 1, editorial_state = 'draft', updated_at = ? WHERE id = ?", input.body, now, postId);
      this.invalidateApproval(postId, "Post copy changed", now); this.bump(); this.audit("post.updated", p.id, { postId });
    });
    await this.broadcastSnapshots(); return json(this.snapshotFor(p.id));
  }

  private async approvePost(request: Request, postId: string): Promise<Response> {
    const p = await this.requireOwner(request); const post = this.postById(postId); if (!post) throw new HttpError(404, "Post not found");
    if (post.publishedAt) throw new HttpError(409, "This post is already published");
    const dependencies = post.dependencyIds.map((id) => this.factById(id));
    if (!dependencies.length || dependencies.some((fact) => !fact?.confirmed)) throw new HttpError(409, "Confirm every supporting fact before approval");
    const now = Date.now(); const fingerprint = dependencies.map((fact) => `${fact!.id}:${fact!.revision}`).sort().join("|");
    this.ctx.storage.transactionSync(() => {
      this.invalidateApproval(postId, "Superseded by a new approval", now);
      this.ctx.storage.sql.exec("INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)", crypto.randomUUID(), postId, post.revision, fingerprint, p.id, now);
      this.ctx.storage.sql.exec("UPDATE posts SET editorial_state = 'approved', updated_at = ? WHERE id = ?", now, postId); this.bump(); this.audit("post.approved", p.id, { postId, revision: post.revision });
    });
    this.updateCampaignStage(); await this.broadcastSnapshots(); return json(this.snapshotFor(p.id));
  }

  private async schedulePost(request: Request, postId: string): Promise<Response> {
    const p = await this.requireOwner(request); const { plannedAt } = await parseJson(request, schedulePostSchema); const post = this.postById(postId); if (!post) throw new HttpError(404, "Post not found");
    const needsReview = post.editorialState === "approved" && scheduleChangeNeedsReview(post.body, post.plannedAt, plannedAt); const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE posts SET planned_at = ?, editorial_state = ?, updated_at = ? WHERE id = ?", plannedAt, needsReview ? "needs_changes" : post.editorialState, now, postId);
      if (needsReview) this.invalidateApproval(postId, "Timing changed for relative-date copy", now); this.bump(); this.audit("post.scheduled", p.id, { postId, plannedAt, needsReview });
    });
    this.updateCampaignStage(); await this.scheduleNextAlarm(); await this.broadcastSnapshots(); return json(this.snapshotFor(p.id));
  }

  private async publishPost(request: Request, postId: string): Promise<Response> {
    const p = await this.requireOwner(request); const { publishedUrl } = await parseJson(request, publishPostSchema); const post = this.postById(postId); if (!post) throw new HttpError(404, "Post not found");
    if (post.editorialState !== "approved") throw new HttpError(409, "Approve the current post before recording publication"); if (post.publishedAt) return json(this.snapshotFor(p.id));
    const now = Date.now(); this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE posts SET published_at = ?, published_url = ?, updated_at = ? WHERE id = ?", now, publishedUrl || null, now, postId);
      this.ctx.storage.sql.exec("INSERT INTO publication_records VALUES (?, ?, ?, ?, ?, ?)", crypto.randomUUID(), postId, post.revision, publishedUrl || null, now, p.id);
      this.bump(); this.audit("post.published", p.id, { postId, publishedUrl: publishedUrl || null });
    });
    this.updateCampaignStage(); await this.broadcastSnapshots(); return json(this.snapshotFor(p.id));
  }

  private async updateSource(request: Request): Promise<Response> {
    const p = await this.requireOwner(request); if (this.runningJob()) throw new HttpError(409, "Wait for the current AI job to finish");
    const input = await parseJson(request, sourceUpdateSchema); const campaign = this.campaign();
    if (input.sourceBody === campaign.sourceBody && this.facts().length) return json(this.snapshotFor(p.id));
    const now = Date.now(); const hash = await sha256(input.sourceBody); const jobId = crypto.randomUUID(); const workflowId = `analysis-${this.workspace().id}-${jobId}`;
    this.ctx.storage.transactionSync(() => {
      for (const fact of this.facts()) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO fact_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)", fact.id, fact.revision, fact.label, fact.value, fact.excerpt, Number(fact.confirmed), p.id, now);
      this.ctx.storage.sql.exec("DELETE FROM facts");
      this.ctx.storage.sql.exec("UPDATE posts SET editorial_state = CASE WHEN published_at IS NULL THEN 'needs_changes' ELSE editorial_state END, correction_needed = CASE WHEN published_at IS NOT NULL THEN 1 ELSE correction_needed END, updated_at = ?", now);
      this.ctx.storage.sql.exec("UPDATE approvals SET invalidated_at = ?, invalidation_reason = 'Release source changed' WHERE invalidated_at IS NULL", now);
      this.ctx.storage.sql.exec("UPDATE campaigns SET source_kind = ?, source_url = ?, source_body = ?, source_checked_at = ?, stage = 'facts', question = NULL, updated_at = ? WHERE id = ?", input.sourceKind, input.sourceUrl || null, input.sourceBody, input.sourceCheckedAt, now, campaign.id);
      this.ctx.storage.sql.exec("INSERT INTO source_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), campaign.id, input.sourceKind, input.sourceUrl || null, input.sourceBody, hash, input.sourceCheckedAt);
      this.ctx.storage.sql.exec("INSERT INTO jobs VALUES (?, 'analysis', 'running', ?, NULL, ?, NULL)", jobId, workflowId, now); this.bump(); this.audit("source.updated", p.id, { sourceKind: input.sourceKind });
    });
    try { await this.env.RELEASE_ANALYSIS_WORKFLOW.create({ id: workflowId, params: { workspaceId: this.workspace().id, jobId } }); }
    catch (error) { this.markJobFailed(jobId, message(error)); }
    await this.broadcastSnapshots(); return json({ jobId, snapshot: this.snapshotFor(p.id) }, { status: 202 });
  }

  private async chat(request: Request): Promise<Response> {
    const p = await this.requireEditor(request); const input = await parseJson(request, chatSchema);
    if (this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE client_id = ?", input.clientId).one().count) return json(this.snapshotFor(p.id));
    const now = Date.now(); this.ctx.storage.sql.exec("INSERT INTO messages VALUES (?, ?, ?, 'user', ?, ?, ?)", crypto.randomUUID(), p.id, p.displayName, input.body, input.clientId, now);
    await this.broadcastSnapshots();
    const w = this.workspace(); const c = this.campaign();
    let answer: { body: string; source: "workers-ai" | "fallback" };
    try { answer = await answerClarification(this.env.AI, { jobId: crypto.randomUUID(), workspaceId: w.id, productName: w.productName, website: w.website, audience: w.audience, tone: w.tone, facts: this.facts(), allowFallback: c.allowFallback }, input.body); }
    catch { answer = { body: "I couldn't answer that just now. Your message is saved, and you can try again.", source: "fallback" }; }
    this.ctx.storage.sql.exec("INSERT INTO messages VALUES (?, NULL, 'Launch Relay', 'assistant', ?, NULL, ?)", crypto.randomUUID(), answer.body, Date.now());
    this.audit("chat.responded", null, { source: answer.source }); this.bump(); await this.broadcastSnapshots(); return json(this.snapshotFor(p.id));
  }

  private analysisInput(url: URL): Response {
    const job = this.requireJob(url.searchParams.get("jobId"), "analysis"); const workspace = this.workspace(); const campaign = this.campaign();
    return json({ jobId: job.id, workspaceId: workspace.id, productName: workspace.productName, audience: workspace.audience, sourceBody: campaign.sourceBody, allowFallback: campaign.allowFallback } satisfies AnalysisInput);
  }

  private async commitAnalysis(request: Request): Promise<Response> {
    const input = await parseJson(request, analysisCommitSchema); this.requireJob(input.jobId, "analysis"); const campaign = this.campaign(); const now = Date.now();
    const facts = input.facts.filter((fact) => campaign.sourceBody.includes(fact.excerpt)); if (!facts.length) throw new HttpError(422, "No extracted fact had a valid source excerpt");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM facts");
      for (const fact of facts) this.ctx.storage.sql.exec("INSERT INTO facts VALUES (?, ?, ?, ?, 'release', 0, 1, ?)", crypto.randomUUID(), fact.label, fact.value, fact.excerpt, now);
      this.ctx.storage.sql.exec("INSERT INTO facts VALUES (?, 'Availability', 'Not confirmed yet', 'Owner confirmation required', 'owner', 0, 1, ?)", crypto.randomUUID(), now);
      this.ctx.storage.sql.exec("UPDATE campaigns SET question = ?, stage = 'facts', updated_at = ? WHERE id = ?", input.question, now, campaign.id);
      this.completeJob(input.jobId, now); this.bump(); this.audit("analysis.completed", null, { source: input.source, factCount: facts.length + 1 });
    });
    await this.broadcastSnapshots(); return json({ ok: true });
  }

  private generationInput(url: URL): Response {
    const job = this.requireJob(url.searchParams.get("jobId"), "generation"); const w = this.workspace(); const c = this.campaign(); const facts = this.facts();
    if (!facts.length || facts.some((fact) => !fact.confirmed)) throw new HttpError(409, "Confirmed facts changed before generation started");
    return json({ jobId: job.id, workspaceId: w.id, productName: w.productName, website: w.website, audience: w.audience, tone: w.tone, facts, allowFallback: c.allowFallback } satisfies GenerationInput);
  }

  private async commitGeneration(request: Request): Promise<Response> {
    const input = await parseJson(request, generationCommitSchema); this.requireJob(input.jobId, "generation"); const facts = this.facts(); const allowed = new Set(facts.filter((f) => f.confirmed).map((f) => f.id));
    if (input.posts.some((post) => post.dependencyIds.some((id) => !allowed.has(id)))) throw new HttpError(422, "Generated posts referenced an unknown or unconfirmed fact");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM posts WHERE published_at IS NULL");
      for (const post of input.posts) {
        const id = crypto.randomUUID(); this.ctx.storage.sql.exec("INSERT INTO posts VALUES (?, ?, ?, ?, 1, 'draft', ?, NULL, NULL, NULL, 0, ?)", id, post.channel, post.purpose, post.body, JSON.stringify(post.dependencyIds), now);
        this.ctx.storage.sql.exec("INSERT INTO post_revisions VALUES (?, 1, ?, NULL, ?)", id, post.body, now);
      }
      this.ctx.storage.sql.exec("UPDATE campaigns SET stage = 'posts', updated_at = ?", now); this.completeJob(input.jobId, now); this.bump(); this.audit("generation.completed", null, { source: input.source, postCount: 3 });
    });
    await this.broadcastSnapshots(); return json({ ok: true });
  }

  private async failJob(request: Request): Promise<Response> { const body = await request.json<{ jobId?: string; error?: string }>(); if (!body.jobId) throw new HttpError(400, "Missing job ID"); this.markJobFailed(body.jobId, body.error || "AI job failed"); await this.broadcastSnapshots(); return json({ ok: true }); }

  private workspace(): WorkspaceInfo {
    const r = this.ctx.storage.sql.exec<any>("SELECT * FROM workspace LIMIT 1").toArray()[0]; if (!r) throw new HttpError(404, "Workspace not found");
    return { id: r.id, productName: r.product_name, website: r.website, audience: r.audience, tone: r.tone, timezone: r.timezone, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private campaign(): CampaignInfo & { allowFallback: boolean } {
    const r = this.ctx.storage.sql.exec<any>("SELECT * FROM campaigns LIMIT 1").one(); return { id: r.id, title: r.title, sourceKind: r.source_kind, sourceUrl: r.source_url, sourceBody: r.source_body, sourceCheckedAt: r.source_checked_at, stage: r.stage, question: r.question, paused: Boolean(r.paused), allowFallback: Boolean(r.allow_fallback) };
  }
  private participants(): Participant[] { return this.ctx.storage.sql.exec<ParticipantRow>("SELECT id, display_name, role FROM participants WHERE revoked_at IS NULL ORDER BY rowid").toArray().map((r) => ({ id: r.id, displayName: r.display_name, role: r.role })); }
  private participantById(id: string): Participant | null { const r = this.ctx.storage.sql.exec<ParticipantRow>("SELECT id, display_name, role FROM participants WHERE id = ? AND revoked_at IS NULL", id).toArray()[0]; return r ? { id: r.id, displayName: r.display_name, role: r.role } : null; }
  private facts(): ReleaseFact[] { return this.ctx.storage.sql.exec<FactRow>("SELECT * FROM facts ORDER BY rowid").toArray().map(mapFact); }
  private factById(id: string): ReleaseFact | null { const r = this.ctx.storage.sql.exec<FactRow>("SELECT * FROM facts WHERE id = ?", id).toArray()[0]; return r ? mapFact(r) : null; }
  private posts(): CampaignPost[] { return this.ctx.storage.sql.exec<PostRow>("SELECT * FROM posts ORDER BY CASE purpose WHEN 'announcement' THEN 0 ELSE 1 END, rowid").toArray().map(mapPost); }
  private postById(id: string): CampaignPost | null { const r = this.ctx.storage.sql.exec<PostRow>("SELECT * FROM posts WHERE id = ?", id).toArray()[0]; return r ? mapPost(r) : null; }
  private messages(): ChatMessage[] { return this.ctx.storage.sql.exec<any>("SELECT id, participant_name, kind, body, created_at FROM messages ORDER BY created_at, rowid").toArray().map((r) => ({ id: r.id, participantName: r.participant_name, kind: r.kind, body: r.body, createdAt: r.created_at })); }
  private snapshotFor(participantId: string): RelaySnapshot { const participant = this.participantById(participantId); if (!participant) throw new HttpError(401, "Access revoked"); return { workspace: this.workspace(), campaign: this.campaign(), participant, participants: this.participants(), facts: this.facts(), posts: this.posts(), messages: this.messages(), activeJob: this.activeJob() }; }

  private runningJob(): boolean { return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").one().count > 0; }
  private activeJob(): RelaySnapshot["activeJob"] { const r = this.ctx.storage.sql.exec<any>("SELECT id, kind, status, error FROM jobs ORDER BY created_at DESC LIMIT 1").toArray()[0]; return r && r.status !== "complete" ? { id: r.id, kind: r.kind, status: r.status, error: r.error } : null; }
  private requireJob(id: string | null, kind: string): any { const r = id ? this.ctx.storage.sql.exec<any>("SELECT * FROM jobs WHERE id = ? AND kind = ?", id, kind).toArray()[0] : null; if (!r || r.status !== "running") throw new HttpError(409, "AI job is no longer active"); return r; }
  private completeJob(id: string, now: number): void { this.ctx.storage.sql.exec("UPDATE jobs SET status = 'complete', completed_at = ? WHERE id = ?", now, id); }
  private markJobFailed(id: string, error: string): void { this.ctx.storage.sql.exec("UPDATE jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'running'", error.slice(0, 1_000), Date.now(), id); }

  private invalidatePostsForFact(factId: string, reason: string, now: number): void {
    for (const post of this.posts().filter((item) => item.dependencyIds.includes(factId))) {
      if (post.publishedAt) { this.ctx.storage.sql.exec("UPDATE posts SET correction_needed = 1, updated_at = ? WHERE id = ?", now, post.id); this.ctx.storage.sql.exec("INSERT INTO correction_tasks VALUES (?, ?, ?, ?, NULL)", crypto.randomUUID(), post.id, reason, now); }
      else this.ctx.storage.sql.exec("UPDATE posts SET editorial_state = 'needs_changes', updated_at = ? WHERE id = ?", now, post.id);
      this.invalidateApproval(post.id, reason, now);
    }
  }
  private invalidateApproval(postId: string, reason: string, now: number): void { this.ctx.storage.sql.exec("UPDATE approvals SET invalidated_at = ?, invalidation_reason = ? WHERE post_id = ? AND invalidated_at IS NULL", now, reason, postId); }
  private updateCampaignStage(): void { const posts = this.posts(); const stage = posts.length && posts.every((p) => p.publishedAt) ? "completed" : posts.length && posts.every((p) => p.editorialState === "approved" && p.plannedAt) ? "ready" : posts.length ? "posts" : "facts"; this.ctx.storage.sql.exec("UPDATE campaigns SET stage = ?, updated_at = ?", stage, Date.now()); }
  private async scheduleNextAlarm(): Promise<void> { const r = this.ctx.storage.sql.exec<{ planned_at: number }>("SELECT planned_at FROM posts WHERE published_at IS NULL AND planned_at IS NOT NULL AND planned_at > ? ORDER BY planned_at LIMIT 1", Date.now()).toArray()[0]; if (r) await this.ctx.storage.setAlarm(r.planned_at); else await this.ctx.storage.deleteAlarm(); }
  private bump(): void { this.ctx.storage.sql.exec("UPDATE workspace SET version = version + 1, updated_at = ?", Date.now()); }
  private audit(kind: string, actorId: string | null, data: unknown): void { this.ctx.storage.sql.exec("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?)", crypto.randomUUID(), kind, actorId, JSON.stringify(data), Date.now()); }
  private exists(): boolean { return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM workspace").one().count > 0; }

  private async authenticate(request: Request): Promise<Participant> { const token = bearer(request); if (!token) throw new HttpError(401, "Private access token required"); const p = await this.participantByToken(token); if (!p) throw new HttpError(401, "Private access token is invalid"); return p; }
  private async requireEditor(request: Request): Promise<Participant> { const p = await this.authenticate(request); if (p.role === "viewer") throw new HttpError(403, "Viewers cannot change this launch"); return p; }
  private async requireOwner(request: Request): Promise<Participant> { const p = await this.authenticate(request); if (p.role !== "owner") throw new HttpError(403, "Only the owner can do that"); return p; }
  private async participantByToken(token: string): Promise<Participant | null> { if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null; const r = this.ctx.storage.sql.exec<ParticipantRow>("SELECT id, display_name, role FROM participants WHERE token_hash = ? AND revoked_at IS NULL", await hashToken(token)).toArray()[0]; return r ? { id: r.id, displayName: r.display_name, role: r.role } : null; }
  private async invitationByToken(token: string): Promise<{ id: string; role: "editor" | "viewer" } | null> { const r = this.ctx.storage.sql.exec<any>("SELECT id, role FROM invitations WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", await hashToken(token), Date.now()).toArray()[0]; return r ?? null; }

  private async broadcastSnapshots(): Promise<void> { for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment() as SocketAttachment | null; if (!a) continue; try { ws.send(JSON.stringify({ type: "snapshot", snapshot: this.snapshotFor(a.participantId) })); } catch { ws.close(4003, "Access revoked"); } } }
}

function mapFact(r: FactRow): ReleaseFact { return { id: r.id, label: r.label, value: r.value, excerpt: r.excerpt, sourceKind: r.source_kind, confirmed: Boolean(r.confirmed), revision: r.revision, updatedAt: r.updated_at }; }
function mapPost(r: PostRow): CampaignPost { return { id: r.id, channel: r.channel, purpose: r.purpose, body: r.body, revision: r.revision, editorialState: r.editorial_state, dependencyIds: JSON.parse(r.dependency_ids), plannedAt: r.planned_at, publishedAt: r.published_at, publishedUrl: r.published_url, correctionNeeded: Boolean(r.correction_needed), updatedAt: r.updated_at }; }
function bearer(request: Request): string { return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || ""; }
function randomToken(): string { const b = crypto.getRandomValues(new Uint8Array(32)); return toBase64Url(b); }
async function hashToken(token: string): Promise<string> { return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))); }
async function sha256(value: string): Promise<string> { return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function toBase64Url(bytes: Uint8Array): string { let raw = ""; for (const b of bytes) raw += String.fromCharCode(b); return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function message(error: unknown): string { return error instanceof Error ? error.message : "Could not start AI job"; }
