import type { RoomSnapshot, Session } from "../shared/types";

interface SessionResponse extends Session {
  snapshot: RoomSnapshot;
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const data = (await response.json().catch(() => ({ error: "Invalid server response" }))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const api = {
  createRoom(prompt: string, organizerName: string) {
    return request<SessionResponse>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ prompt, organizerName }),
    });
  },

  joinRoom(roomId: string, displayName: string) {
    return request<SessionResponse>(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName }),
    });
  },

  getSnapshot(session: Session) {
    return request<RoomSnapshot>(`/api/rooms/${session.roomId}/snapshot`, {}, session.token);
  },

  sendMessage(session: Session, body: string, clientId: string) {
    return request<RoomSnapshot>(
      `/api/rooms/${session.roomId}/message`,
      { method: "POST", body: JSON.stringify({ body, clientId }) },
      session.token,
    );
  },

  async generateProposals(session: Session) {
    const result = await request<{ snapshot: RoomSnapshot }>(
      `/api/rooms/${session.roomId}/generate`,
      { method: "POST", body: "{}" },
      session.token,
    );
    return result.snapshot;
  },

  vote(session: Session, proposalId: string) {
    return request<RoomSnapshot>(
      `/api/rooms/${session.roomId}/vote`,
      { method: "POST", body: JSON.stringify({ proposalId, value: 1, reason: "" }) },
      session.token,
    );
  },

  finalize(session: Session, proposalId: string) {
    return request<RoomSnapshot>(
      `/api/rooms/${session.roomId}/finalize`,
      { method: "POST", body: JSON.stringify({ proposalId }) },
      session.token,
    );
  },
};

const sessionKey = (roomId: string) => `rally:session:${roomId}`;

export function saveSession(session: Session): void {
  localStorage.setItem(sessionKey(session.roomId), JSON.stringify(session));
}

export function loadSession(roomId: string): Session | null {
  const value = localStorage.getItem(sessionKey(roomId));
  if (!value) return null;
  try {
    return JSON.parse(value) as Session;
  } catch {
    localStorage.removeItem(sessionKey(roomId));
    return null;
  }
}

export function roomWebSocketUrl(session: Session): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/rooms/${session.roomId}/ws`;
}
