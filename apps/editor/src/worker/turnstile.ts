import type { Env } from "./env";
import { HttpError } from "./http";

export const TURNSTILE_ACTION = "create-document";
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export function turnstileSiteKey(requestUrl: URL, env: Env): string {
  if (usesTestKeys(requestUrl)) return TURNSTILE_TEST_SITE_KEY;
  if (!env.TURNSTILE_SITE_KEY) throw new HttpError(503, "Browser verification is not configured");
  return env.TURNSTILE_SITE_KEY;
}

export async function verifyTurnstile(token: string, request: Request, env: Env): Promise<void> {
  const requestUrl = new URL(request.url);
  const local = usesTestKeys(requestUrl);
  const secret = local ? TURNSTILE_TEST_SECRET_KEY : env.TURNSTILE_SECRET_KEY;
  const expectedHostname = local ? undefined : (env.TURNSTILE_EXPECTED_HOSTNAME ?? requestUrl.hostname);
  if (!secret) throw new HttpError(503, "Browser verification is not configured");

  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  body.set("idempotency_key", crypto.randomUUID());
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) body.set("remoteip", remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, "Browser verification is temporarily unavailable. Please try again");
  }

  if (!response.ok) throw new HttpError(503, "Browser verification is temporarily unavailable. Please try again");

  let result: SiteverifyResponse;
  try {
    result = await response.json() as SiteverifyResponse;
  } catch {
    throw new HttpError(503, "Browser verification is temporarily unavailable. Please try again");
  }

  if (!result.success) throw new HttpError(403, "Browser verification failed. Please try again");
  // Cloudflare's dummy keys intentionally return a synthetic response without
  // the widget action. Production responses must match our creation action.
  if (!local && result.action !== TURNSTILE_ACTION) throw new HttpError(403, "Browser verification failed. Please try again");
  if (expectedHostname && result.hostname !== expectedHostname) {
    throw new HttpError(403, "Browser verification failed. Please try again");
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

function usesTestKeys(url: URL): boolean {
  return url.protocol === "http:" && isLocalHostname(url.hostname);
}
