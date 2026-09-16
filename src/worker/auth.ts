import type { AccountUser } from "../shared/types";
import type { Env } from "./env";
import { HttpError, json } from "./http";

const SESSION_COOKIE = "rally_account";
const MAGIC_LINK_LIFETIME_MS = 10 * 60 * 1_000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

export type AuthIntent =
  | { type: "create"; prompt: string }
  | { type: "join"; invitationToken: string }
  | { type: "restore"; roomId: string }
  | { type: "rooms" };

type ChallengeRow = {
  token_hash: string;
  email: string;
  display_name: string;
  intent_type: AuthIntent["type"];
  intent_json: string;
  expires_at: number;
  consumed_at: number | null;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
};

export interface ConsumedMagicLink {
  user: AccountUser;
  intent: AuthIntent;
  cookie: string;
}

export async function requestMagicLink(
  request: Request,
  env: Env,
  input: { email: string; displayName: string; intent: AuthIntent },
): Promise<Response> {
  const email = normalizeEmail(input.email);
  const now = Date.now();
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const recent = await env.AUTH_DB.prepare(
    "SELECT created_at FROM auth_challenges WHERE email = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(email).first<{ created_at: number }>();
  if (!local && recent && now - recent.created_at < 20_000) {
    throw new HttpError(429, "Please wait a moment before requesting another sign-in link");
  }

  const token = randomToken();
  const tokenHash = await hashToken(token);
  await env.AUTH_DB.prepare(
    `INSERT INTO auth_challenges
      (token_hash, email, display_name, intent_type, intent_json, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).bind(
    tokenHash,
    email,
    input.displayName,
    input.intent.type,
    JSON.stringify(input.intent),
    now + MAGIC_LINK_LIFETIME_MS,
    now,
  ).run();

  const magicLink = `${url.origin}/api/auth/verify?token=${token}`;

  if (!local) {
    if (!env.EMAIL) {
      await env.AUTH_DB.prepare("DELETE FROM auth_challenges WHERE token_hash = ?").bind(tokenHash).run();
      throw new HttpError(503, "Email sign-in is being configured. Please try again shortly.");
    }
    try {
      await env.EMAIL.send({
        to: email,
        from: "login@fanpilot.app",
        subject: "Your Rally sign-in link",
        html: magicLinkHtml(input.displayName, magicLink),
        text: `Hi ${input.displayName},\n\nOpen this link to continue to Rally:\n${magicLink}\n\nThis link expires in 10 minutes and can only be used once.`,
      });
    } catch (error) {
      await env.AUTH_DB.prepare("DELETE FROM auth_challenges WHERE token_hash = ?").bind(tokenHash).run();
      console.error("Could not send magic link", error);
      throw new HttpError(503, "Rally could not send that email. Please try again.");
    }
  }

  return json({ sent: true, ...(local ? { devMagicLink: magicLink } : {}) });
}

export async function consumeMagicLink(request: Request, env: Env, token: string): Promise<ConsumedMagicLink> {
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new HttpError(400, "That sign-in link is invalid");
  const tokenHash = await hashToken(token);
  const challenge = await env.AUTH_DB.prepare(
    `SELECT token_hash, email, display_name, intent_type, intent_json, expires_at, consumed_at
     FROM auth_challenges WHERE token_hash = ?`,
  ).bind(tokenHash).first<ChallengeRow>();
  if (!challenge || challenge.consumed_at || challenge.expires_at <= Date.now()) {
    throw new HttpError(401, "That sign-in link has expired or was already used");
  }

  const consumed = await env.AUTH_DB.prepare(
    "UPDATE auth_challenges SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
  ).bind(Date.now(), tokenHash, Date.now()).run();
  if (!consumed.meta.changes) throw new HttpError(401, "That sign-in link has expired or was already used");

  let user = await env.AUTH_DB.prepare(
    "SELECT id, email, display_name FROM users WHERE email = ?",
  ).bind(challenge.email).first<UserRow>();
  const now = Date.now();
  if (user) {
    await env.AUTH_DB.prepare(
      "UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?",
    ).bind(challenge.display_name, now, user.id).run();
    user = { ...user, display_name: challenge.display_name };
  } else {
    user = { id: crypto.randomUUID(), email: challenge.email, display_name: challenge.display_name };
    await env.AUTH_DB.prepare(
      "INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(user.id, user.email, user.display_name, now, now).run();
  }

  const sessionToken = randomToken();
  const sessionHash = await hashToken(sessionToken);
  await env.AUTH_DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(sessionHash, user.id, now + SESSION_LIFETIME_MS, now, now).run();

  return {
    user: toAccountUser(user),
    intent: JSON.parse(challenge.intent_json) as AuthIntent,
    cookie: sessionCookie(request, sessionToken, SESSION_LIFETIME_MS),
  };
}

export async function accountUser(request: Request, env: Env): Promise<AccountUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const now = Date.now();
  const row = await env.AUTH_DB.prepare(
    `SELECT users.id, users.email, users.display_name
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ?`,
  ).bind(tokenHash, now).first<UserRow>();
  if (!row) return null;
  await env.AUTH_DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  return toAccountUser(row);
}

export async function requireAccountUser(request: Request, env: Env): Promise<AccountUser> {
  const user = await accountUser(request, env);
  if (!user) throw new HttpError(401, "Sign in to continue");
  return user;
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) {
    await env.AUTH_DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?")
      .bind(Date.now(), await hashToken(token)).run();
  }
  return json({ ok: true }, { headers: { "set-cookie": expiredSessionCookie(request) } });
}

export function withSessionCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function redirectWithCookie(location: string, cookie: string): Response {
  return new Response(null, { status: 302, headers: { location, "set-cookie": cookie, "cache-control": "no-store" } });
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAccountUser(row: UserRow): AccountUser {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(request: Request, token: string, maxAgeMs: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1_000)}${secure}`;
}

function expiredSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function magicLinkHtml(displayName: string, magicLink: string): string {
  const name = escapeHtml(displayName);
  return `<!doctype html><html><body style="margin:0;background:#f7f4ee;font-family:Arial,sans-serif;color:#231f1a"><div style="max-width:520px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e6ded4;border-radius:18px"><h1 style="font-size:24px;margin:0 0 14px">Continue to Rally</h1><p style="line-height:1.55">Hi ${name}, click below to return to your planning room.</p><p style="margin:26px 0"><a href="${magicLink}" style="display:inline-block;padding:13px 20px;border-radius:11px;background:#6b4eff;color:#fff;text-decoration:none;font-weight:700">Open Rally</a></p><p style="font-size:13px;color:#746d64;line-height:1.5">This link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.</p></div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}
