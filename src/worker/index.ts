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
        const stub = env.RALLY_ROOMS.getByName(roomId);
        return stub.fetch("https://room.internal/initialize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, roomId }),
        });
      }

      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const roomId = decodeURIComponent(match[1]);
        if (!roomIdPattern.test(roomId)) throw new HttpError(400, "Invalid room ID");
        const action = match[2] || "snapshot";
        const allowed = new Set(["join", "snapshot", "ws", "message", "generate", "vote", "finalize"]);
        if (!allowed.has(action)) throw new HttpError(404, "Room action not found");
        const stub = env.RALLY_ROOMS.getByName(roomId);
        const internalUrl = new URL(`https://room.internal/${action}`);
        internalUrl.search = url.search;
        return stub.fetch(new Request(internalUrl, request));
      }

      return json({ error: "API route not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
