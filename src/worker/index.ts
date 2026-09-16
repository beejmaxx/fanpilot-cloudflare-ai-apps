import { createRoomSchema } from "../shared/schemas";
import type { Env } from "./env";
import { errorResponse, HttpError, json, parseJson } from "./http";
export { RallyRoom } from "./room";
export { ProposalWorkflow } from "./workflow";

const roomIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "rally", model: "llama-3.3-70b-instruct-fp8-fast" });
      }

      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const input = await parseJson(request, createRoomSchema);
        const roomId = crypto.randomUUID();
        return env.RALLY_ROOMS.getByName(roomId).fetch("https://room.internal/initialize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, roomId }),
        });
      }

      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const roomId = validRoomId(match[1]);
        const action = match[2] || "snapshot";
        const allowed = new Set([
          "join", "session", "identity", "snapshot", "ws", "message", "generate", "vote", "finalize",
          "invitation", "invitations", "invitations/reset", "participant", "participant/rotate-access",
        ]);
        if (!allowed.has(action)) throw new HttpError(404, "Room action not found");
        const headers = new Headers(request.headers);
        // Version overrides select the edge Worker only. Forwarding this control
        // header into a Durable Object subrequest causes Cloudflare to reject it.
        headers.delete("Cloudflare-Workers-Version-Overrides");
        headers.set("x-rally-origin", url.origin);
        return env.RALLY_ROOMS.getByName(roomId).fetch(new Request(`https://room.internal/${action}${url.search}`, {
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

function validRoomId(value: string): string {
  const roomId = decodeURIComponent(value);
  if (!roomIdPattern.test(roomId)) throw new HttpError(400, "Invalid room ID");
  return roomId;
}
