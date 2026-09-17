import { createWorkspaceSchema, sourceUpdateSchema } from "../shared/schemas";
import type { Env } from "./env";
import { errorResponse, HttpError, json, parseJson } from "./http";
import { fetchGitHubRelease, isLocalRequest } from "./source";
import { TURNSTILE_ACTION, turnstileSiteKey, verifyTurnstile } from "./turnstile";

export { LaunchWorkspace } from "./room";
export { CampaignGenerationWorkflow, ReleaseAnalysisWorkflow } from "./workflow";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, service: "launch-relay", model: "llama-3.3-70b-instruct-fp8-fast" });
      if (url.pathname === "/api/turnstile" && request.method === "GET") return json({ siteKey: turnstileSiteKey(url, env), action: TURNSTILE_ACTION });
      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const input = await parseJson(request, createWorkspaceSchema);
        await verifyTurnstile(input.turnstileToken, request, env);
        const key = request.headers.get("CF-Connecting-IP") ?? "unknown-client";
        if (!(await env.WORKSPACE_CREATION_RATE_LIMITER.limit({ key: `relay-create:${key}` })).success) throw new HttpError(429, "Too many workspaces created. Please wait a minute and try again");
        const source = input.sourceKind === "github" ? await fetchGitHubRelease(input.sourceUrl) : { body: input.sourceBody, url: "", checkedAt: Date.now() };
        if (!source.body.trim()) throw new HttpError(400, "Add release notes or a public GitHub repository or release URL");
        const workspaceId = crypto.randomUUID();
        return env.LAUNCH_WORKSPACES.getByName(workspaceId).fetch("https://relay.internal/initialize", {
          method: "POST", headers: { "content-type": "application/json", "x-relay-origin": url.origin },
          body: JSON.stringify({ ...input, sourceBody: source.body, sourceUrl: source.url, sourceCheckedAt: source.checkedAt, workspaceId, allowFallback: isLocalRequest(url) }),
        });
      }
      const match = url.pathname.match(/^\/api\/workspaces\/([^/]+)(?:\/(.*))?$/);
      if (!match) return json({ error: "API route not found" }, { status: 404 });
      const workspaceId = validId(match[1]);
      let action = match[2] || "snapshot";
      let requestBody: BodyInit | null = request.body;
      const headers = new Headers(request.headers);
      headers.delete("Cloudflare-Workers-Version-Overrides");
      headers.set("x-relay-origin", url.origin);
      if (action === "source" && request.method === "POST") {
        const input = await parseJson(request, sourceUpdateSchema.omit({ sourceBody: true, sourceCheckedAt: true }).extend({ sourceBody: sourceUpdateSchema.shape.sourceBody.optional(), sourceCheckedAt: sourceUpdateSchema.shape.sourceCheckedAt.optional() }));
        const source = input.sourceKind === "github" ? await fetchGitHubRelease(input.sourceUrl) : { body: input.sourceBody || "", url: "", checkedAt: Date.now() };
        requestBody = JSON.stringify({ sourceKind: input.sourceKind, sourceBody: source.body, sourceUrl: source.url, sourceCheckedAt: source.checkedAt });
        headers.set("content-type", "application/json");
      }
      if (!allowed(action)) throw new HttpError(404, "Workspace action not found");
      return env.LAUNCH_WORKSPACES.getByName(workspaceId).fetch(new Request(`https://relay.internal/${action}${url.search}`, { method: request.method, headers, body: requestBody }));
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<Env>;

function validId(value: string): string { const id = decodeURIComponent(value); if (!idPattern.test(id)) throw new HttpError(400, "Invalid workspace ID"); return id; }
function allowed(action: string): boolean {
  return ["invitation-info", "join", "session", "snapshot", "ws", "invitations", "participant/rotate-access", "generate", "source", "chat"].includes(action)
    || /^facts\/[^/]+$/.test(action) || /^posts\/[^/]+$/.test(action)
    || /^posts\/[^/]+\/(approve|schedule|publish)$/.test(action);
}
