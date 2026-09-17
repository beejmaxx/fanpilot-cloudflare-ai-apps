import type { Env } from "./env";
import { HttpError } from "./http";

export const TURNSTILE_ACTION = "create-launch";
const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileSiteKey(url: URL, env: Env): string {
  if (isLocal(url)) return TEST_SITE_KEY;
  if (!env.TURNSTILE_SITE_KEY) throw new HttpError(503, "Browser verification is not configured");
  return env.TURNSTILE_SITE_KEY;
}

export async function verifyTurnstile(token: string, request: Request, env: Env): Promise<void> {
  const url = new URL(request.url);
  const local = isLocal(url);
  const secret = local ? TEST_SECRET_KEY : env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new HttpError(503, "Browser verification is not configured");
  const body = new FormData();
  body.set("secret", secret); body.set("response", token); body.set("idempotency_key", crypto.randomUUID());
  const ip = request.headers.get("CF-Connecting-IP"); if (ip) body.set("remoteip", ip);
  let response: Response;
  try { response = await fetch(VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5_000) }); }
  catch { throw new HttpError(503, "Browser verification is temporarily unavailable. Please try again"); }
  if (!response.ok) throw new HttpError(503, "Browser verification is temporarily unavailable. Please try again");
  const result = await response.json<{ success: boolean; hostname?: string; action?: string }>();
  if (!result.success || (!local && result.action !== TURNSTILE_ACTION)
    || (!local && result.hostname !== (env.TURNSTILE_EXPECTED_HOSTNAME ?? url.hostname))) {
    throw new HttpError(403, "Browser verification failed. Please try again");
  }
}

function isLocal(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname.endsWith(".localhost"));
}
