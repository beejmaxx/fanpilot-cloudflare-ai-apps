import { createDocumentSchema } from "../shared/schemas";
import type { Env } from "./env";
import { errorResponse, HttpError, json, parseJson } from "./http";
import { enforceDocumentCreationRateLimit } from "./rate-limit";
import { TURNSTILE_ACTION, turnstileSiteKey, verifyTurnstile } from "./turnstile";

export { DocumentRoom } from "./room";
export { AiEditWorkflow } from "./workflow";

const documentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "draft", model: "llama-3.3-70b-instruct-fp8-fast" });
      }
      if (url.pathname === "/api/turnstile" && request.method === "GET") {
        return json({ siteKey: turnstileSiteKey(url, env), action: TURNSTILE_ACTION });
      }
      if (url.pathname === "/api/documents" && request.method === "POST") {
        const input = await parseJson(request, createDocumentSchema);
        await verifyTurnstile(input.turnstileToken, request, env);
        await enforceDocumentCreationRateLimit(request, env);
        const documentId = crypto.randomUUID();
        return env.DOCUMENT_ROOMS.getByName(documentId).fetch("https://document.internal/initialize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: input.title, displayName: input.displayName, template: input.template, documentId }),
        });
      }
      const match = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const documentId = validDocumentId(match[1]);
        const action = match[2] || "snapshot";
        if (!allowedAction(action)) throw new HttpError(404, "Document action not found");
        const headers = new Headers(request.headers);
        headers.delete("Cloudflare-Workers-Version-Overrides");
        headers.set("x-draft-origin", url.origin);
        return env.DOCUMENT_ROOMS.getByName(documentId).fetch(new Request(`https://document.internal/${action}${url.search}`, {
          method: request.method,
          headers,
          body: request.body,
        }));
      }
      return json({ error: "API route not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;

function validDocumentId(value: string): string {
  const id = decodeURIComponent(value);
  if (!documentIdPattern.test(id)) throw new HttpError(400, "Invalid document ID");
  return id;
}

function allowedAction(action: string): boolean {
  return [
    "invitation-info", "join", "session", "snapshot", "ws", "title", "participant",
    "participant/rotate-access", "invitations", "comments", "ai", "export", "suggestions/accept-all",
  ].includes(action) || /^comments\/[^/]+\/resolve$/.test(action) || /^suggestions\/[^/]+\/decision$/.test(action)
    || /^revisions\/[^/]+\/revert$/.test(action) || /^participants\/[^/]+\/revoke$/.test(action);
}
