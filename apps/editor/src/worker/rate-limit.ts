import type { Env } from "./env";
import { HttpError } from "./http";

export async function enforceDocumentCreationRateLimit(request: Request, env: Env): Promise<void> {
  const clientKey = request.headers.get("CF-Connecting-IP") ?? "unknown-client";
  const { success } = await env.DOCUMENT_CREATION_RATE_LIMITER.limit({ key: `document-creation:${clientKey}` });
  if (!success) throw new HttpError(429, "Too many documents created. Please wait a minute and try again");
}
