import { expect, type APIRequestContext } from "@playwright/test";
import type { RoomSnapshot, Session } from "../src/shared/types";

export interface SessionResponse extends Session {
  snapshot: RoomSnapshot;
}

export async function createRoom(
  request: APIRequestContext,
  organizerName = "Alice",
): Promise<SessionResponse> {
  const response = await request.post("/api/rooms", {
    data: {
      organizerName,
      prompt: "Plan a birthday dinner in Shanghai next Saturday for six people under ¥300 each.",
    },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<SessionResponse>;
}

export async function joinRoom(
  request: APIRequestContext,
  roomId: string,
  displayName = "Bob",
): Promise<SessionResponse> {
  const response = await request.post(`/api/rooms/${roomId}/join`, { data: { displayName } });
  expect(response.status()).toBe(200);
  return response.json() as Promise<SessionResponse>;
}

export async function snapshot(
  request: APIRequestContext,
  session: Session,
): Promise<RoomSnapshot> {
  const response = await request.get(`/api/rooms/${session.roomId}/snapshot`, {
    headers: auth(session),
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<RoomSnapshot>;
}

export async function sendMessage(
  request: APIRequestContext,
  session: Session,
  body: string,
): Promise<RoomSnapshot> {
  const response = await request.post(`/api/rooms/${session.roomId}/message`, {
    headers: auth(session),
    data: { body, clientId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<RoomSnapshot>;
}

export async function generateAndWait(
  request: APIRequestContext,
  organizer: Session,
): Promise<RoomSnapshot> {
  const response = await request.post(`/api/rooms/${organizer.roomId}/generate`, {
    headers: auth(organizer),
    data: {},
  });
  expect(response.status()).toBe(202);

  await expect.poll(async () => (await snapshot(request, organizer)).room.stage, {
    timeout: 20_000,
    intervals: [100, 250, 500],
  }).toBe("voting");
  return snapshot(request, organizer);
}

export function auth(session: Pick<Session, "token">): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

export function waitForSocketSnapshot(
  roomId: string,
  token: string,
): Promise<{ socket: WebSocket; snapshot: RoomSnapshot }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:4173/api/rooms/${roomId}/ws`, ["rally", token]);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for WebSocket snapshot"));
    }, 10_000);

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as { type: string; snapshot?: RoomSnapshot };
      if (payload.type !== "snapshot" || !payload.snapshot) return;
      clearTimeout(timer);
      resolve({ socket, snapshot: payload.snapshot });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection failed"));
    });
  });
}
