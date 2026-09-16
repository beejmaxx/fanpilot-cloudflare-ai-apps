import { createRoomSchema, magicLinkSchema } from "../shared/schemas";
import type { AccountUser, Participant, RoomSummary, Session } from "../shared/types";
import {
  accountUser,
  consumeMagicLink,
  hashToken,
  logout,
  randomToken,
  redirectWithCookie,
  requestMagicLink,
  requireAccountUser,
  type AuthIntent,
} from "./auth";
import type { Env } from "./env";
import { errorResponse, HttpError, json, parseJson } from "./http";
export { RallyRoom } from "./room";
export { ProposalWorkflow } from "./workflow";

const roomIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invitationPattern = /^[0-9a-f]{64}$/i;

type SessionResponse = Session & { snapshot: import("../shared/types").RoomSnapshot };
type InvitationRow = {
  token_hash: string;
  room_id: string;
  title: string;
  expires_at: number;
  max_uses: number | null;
  use_count: number;
  revoked_at: number | null;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "rally", model: "llama-3.3-70b-instruct-fp8-fast" });
      }

      if (url.pathname === "/api/auth/magic-link" && request.method === "POST") {
        const input = await parseJson(request, magicLinkSchema);
        if (input.intent.type === "join") await validInvitation(env, input.intent.invitationToken);
        return await requestMagicLink(request, env, input);
      }
      if (url.pathname === "/api/auth/verify" && request.method === "GET") {
        const result = await consumeMagicLink(request, env, url.searchParams.get("token") ?? "");
        return redirectWithCookie(await completeIntent(env, result.user, result.intent), result.cookie);
      }
      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        return json({ user: await accountUser(request, env) });
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return await logout(request, env);

      if (url.pathname === "/api/account/rooms" && request.method === "GET") {
        const user = await requireAccountUser(request, env);
        const result = await env.AUTH_DB.prepare(
          `SELECT rooms.id, rooms.title, room_memberships.role, rooms.created_at, rooms.updated_at
           FROM room_memberships JOIN rooms ON rooms.id = room_memberships.room_id
           WHERE room_memberships.user_id = ? ORDER BY rooms.updated_at DESC`,
        ).bind(user.id).all<{ id: string; title: string; role: RoomSummary["role"]; created_at: number; updated_at: number }>();
        return json({ rooms: result.results.map((row) => ({
          id: row.id, title: row.title, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at,
        })) satisfies RoomSummary[] });
      }

      const invitationMatch = url.pathname.match(/^\/api\/invitations\/([0-9a-f]{64})(?:\/(accept))?$/i);
      if (invitationMatch) {
        const token = invitationMatch[1];
        if (request.method === "GET" && !invitationMatch[2]) {
          const invitation = await validInvitation(env, token);
          return json({ roomId: invitation.room_id, title: invitation.title });
        }
        if (request.method === "POST" && invitationMatch[2] === "accept") {
          return json(await acceptInvitation(env, await requireAccountUser(request, env), token));
        }
      }

      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const input = await parseJson(request, createRoomSchema);
        return await createRoom(env, input, await accountUser(request, env));
      }

      const invitationCreateMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/invitations$/);
      if (invitationCreateMatch && request.method === "POST") {
        return await createInvitation(request, env, validRoomId(invitationCreateMatch[1]));
      }

      const resumeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/account-session$/);
      if (resumeMatch && request.method === "GET") {
        const roomId = validRoomId(resumeMatch[1]);
        const user = await requireAccountUser(request, env);
        await requireMembership(env, roomId, user.id);
        const response = await roomFetch(env, roomId, "/account-session", request, user);
        if (response.ok) await touchMembership(env, roomId, user.id);
        return response;
      }

      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const roomId = validRoomId(match[1]);
        const action = match[2] || "snapshot";
        const allowed = new Set(["join", "snapshot", "ws", "message", "generate", "vote", "finalize"]);
        if (!allowed.has(action)) throw new HttpError(404, "Room action not found");
        const user = action === "join" ? null : await accountUser(request, env);
        return await roomFetch(env, roomId, `/${action}${url.search}`, request, user);
      }

      return json({ error: "API route not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;

async function completeIntent(env: Env, user: AccountUser, intent: AuthIntent): Promise<string> {
  if (intent.type === "create") {
    const response = await createRoom(env, { prompt: intent.prompt, organizerName: user.displayName }, user);
    if (!response.ok) throw new HttpError(response.status, "Could not create the planning room");
    const created = await response.json<SessionResponse>();
    return `/room/${created.roomId}`;
  }
  if (intent.type === "join") return `/room/${(await acceptInvitation(env, user, intent.invitationToken)).roomId}`;
  if (intent.type === "restore") return `/room/${intent.roomId}`;
  return "/rooms";
}

async function createRoom(env: Env, input: { prompt: string; organizerName: string }, user: AccountUser | null): Promise<Response> {
  const roomId = crypto.randomUUID();
  const headers = new Headers({ "content-type": "application/json" });
  if (user) headers.set("x-rally-user-id", user.id);
  const response = await env.RALLY_ROOMS.getByName(roomId).fetch("https://room.internal/initialize", {
    method: "POST", headers, body: JSON.stringify({ ...input, roomId }),
  });
  if (!response.ok || !user) return response;
  const payload = await response.clone().json<SessionResponse>();
  const now = Date.now();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare("INSERT INTO rooms (id, title, organizer_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(roomId, payload.snapshot.room.title, user.id, now, now),
    env.AUTH_DB.prepare(
      "INSERT INTO room_memberships (room_id, user_id, participant_id, role, joined_at, last_seen_at) VALUES (?, ?, ?, 'organizer', ?, ?)",
    ).bind(roomId, user.id, payload.participantId, now, now),
  ]);
  return response;
}

async function createInvitation(request: Request, env: Env, roomId: string): Promise<Response> {
  const user = await accountUser(request, env);
  let createdBy: string | null = null;
  let title: string;
  if (user) {
    const membership = await requireMembership(env, roomId, user.id);
    if (membership.role !== "organizer") throw new HttpError(403, "Only the organizer can invite people");
    createdBy = user.id;
    title = (await env.AUTH_DB.prepare("SELECT title FROM rooms WHERE id = ?").bind(roomId).first<{ title: string }>())?.title ?? "Planning room";
  } else {
    const identityResponse = await roomFetch(env, roomId, "/identity", request, null);
    if (!identityResponse.ok) return identityResponse;
    const participant = await identityResponse.json<Participant>();
    if (participant.role !== "organizer") throw new HttpError(403, "Only the organizer can invite people");
    const snapshotResponse = await roomFetch(env, roomId, "/snapshot", request, null);
    const snapshot = await snapshotResponse.json<import("../shared/types").RoomSnapshot>();
    title = snapshot.room.title;
    const now = Date.now();
    await env.AUTH_DB.prepare("INSERT OR IGNORE INTO rooms (id, title, organizer_user_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)")
      .bind(roomId, title, now, now).run();
  }
  const token = randomToken();
  const now = Date.now();
  await env.AUTH_DB.prepare(
    "INSERT INTO invitations (token_hash, room_id, created_by_user_id, expires_at, max_uses, use_count, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?)",
  ).bind(await hashToken(token), roomId, createdBy, now + 30 * 24 * 60 * 60 * 1_000, now).run();
  return json({ invitationUrl: `${new URL(request.url).origin}/join/${token}`, title });
}

async function validInvitation(env: Env, token: string): Promise<InvitationRow> {
  if (!invitationPattern.test(token)) throw new HttpError(404, "Invitation not found");
  const row = await env.AUTH_DB.prepare(
    `SELECT invitations.token_hash, invitations.room_id, rooms.title, invitations.expires_at,
      invitations.max_uses, invitations.use_count, invitations.revoked_at
     FROM invitations JOIN rooms ON rooms.id = invitations.room_id WHERE invitations.token_hash = ?`,
  ).bind(await hashToken(token)).first<InvitationRow>();
  if (!row || row.revoked_at || row.expires_at <= Date.now() || (row.max_uses !== null && row.use_count >= row.max_uses)) {
    throw new HttpError(404, "This invitation is invalid or has expired");
  }
  return row;
}

async function acceptInvitation(env: Env, user: AccountUser, token: string): Promise<SessionResponse> {
  const invitation = await validInvitation(env, token);
  const existing = await env.AUTH_DB.prepare("SELECT participant_id FROM room_memberships WHERE room_id = ? AND user_id = ?")
    .bind(invitation.room_id, user.id).first<{ participant_id: string }>();
  const response = await env.RALLY_ROOMS.getByName(invitation.room_id).fetch("https://room.internal/join", {
    method: "POST",
    headers: { "content-type": "application/json", "x-rally-user-id": user.id },
    body: JSON.stringify({ displayName: user.displayName }),
  });
  if (!response.ok) throw new HttpError(response.status, "Could not join this room");
  const joined = await response.json<SessionResponse>();
  const now = Date.now();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(
      `INSERT INTO room_memberships (room_id, user_id, participant_id, role, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET participant_id = excluded.participant_id, role = excluded.role, last_seen_at = excluded.last_seen_at`,
    ).bind(invitation.room_id, user.id, joined.participantId, joined.role, now, now),
    ...(existing ? [] : [env.AUTH_DB.prepare("UPDATE invitations SET use_count = use_count + 1 WHERE token_hash = ?").bind(invitation.token_hash)]),
    env.AUTH_DB.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(now, invitation.room_id),
  ]);
  return joined;
}

async function requireMembership(env: Env, roomId: string, userId: string): Promise<{ role: Session["role"] }> {
  const membership = await env.AUTH_DB.prepare("SELECT role FROM room_memberships WHERE room_id = ? AND user_id = ?")
    .bind(roomId, userId).first<{ role: Session["role"] }>();
  if (!membership) throw new HttpError(403, "You are not a member of this room. Ask the organizer for an invitation link.");
  return membership;
}

async function touchMembership(env: Env, roomId: string, userId: string): Promise<void> {
  const now = Date.now();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare("UPDATE room_memberships SET last_seen_at = ? WHERE room_id = ? AND user_id = ?").bind(now, roomId, userId),
    env.AUTH_DB.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(now, roomId),
  ]);
}

function validRoomId(value: string): string {
  const roomId = decodeURIComponent(value);
  if (!roomIdPattern.test(roomId)) throw new HttpError(400, "Invalid room ID");
  return roomId;
}

async function roomFetch(env: Env, roomId: string, path: string, request: Request, user: AccountUser | null): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("x-rally-user-id");
  headers.delete("x-rally-display-name");
  if (user) {
    headers.set("x-rally-user-id", user.id);
    headers.set("x-rally-display-name", encodeURIComponent(user.displayName));
  }
  return env.RALLY_ROOMS.getByName(roomId).fetch(new Request(`https://room.internal${path}`, {
    method: request.method, headers, body: request.body,
  }));
}
