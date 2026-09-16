import type { ParticipantRole, RoomSnapshot, Session } from "../shared/types";

export interface SessionResponse extends Session {
  snapshot: RoomSnapshot;
}

export interface RecentRoom {
  roomId: string;
  title: string;
  role: ParticipantRole;
  participantName: string;
  updatedAt: number;
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const data = (await response.json().catch(() => ({ error: "Invalid server response" }))) as T & { error?: string };
  if (!response.ok) throw new ApiRequestError(data.error || `Request failed (${response.status})`, response.status);
  return data;
}

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export const api = {
  createRoom(prompt: string, organizerName: string) {
    return request<SessionResponse>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ prompt, organizerName }),
    });
  },

  invitation(roomId: string, invitationToken: string) {
    return request<{ roomId: string; title: string }>(`/api/rooms/${roomId}/invitation`, {
      method: "POST",
      body: JSON.stringify({ invitationToken }),
    });
  },

  joinRoom(roomId: string, displayName: string, invitationToken: string) {
    return request<SessionResponse>(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName, invitationToken }),
    });
  },

  resumeRoom(roomId: string, token: string) {
    return request<SessionResponse>(`/api/rooms/${roomId}/session`, {}, token);
  },

  createInvitation(session: Session) {
    return request<{ invitationUrl: string }>(
      `/api/rooms/${session.roomId}/invitations`,
      { method: "POST", body: "{}" },
      session.token,
    );
  },

  resetInvitations(session: Session) {
    return request<{ invitationUrl: string }>(
      `/api/rooms/${session.roomId}/invitations/reset`,
      { method: "POST", body: "{}" },
      session.token,
    );
  },

  renameParticipant(session: Session, displayName: string) {
    return request<RoomSnapshot>(
      `/api/rooms/${session.roomId}/participant`,
      { method: "PATCH", body: JSON.stringify({ displayName }) },
      session.token,
    );
  },

  rotateAccess(session: Session) {
    return request<SessionResponse>(
      `/api/rooms/${session.roomId}/participant/rotate-access`,
      { method: "POST", body: "{}" },
      session.token,
    );
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
const recentRoomsKey = "rally:recent-rooms";

export function saveSession(session: Session): void {
  localStorage.setItem(sessionKey(session.roomId), JSON.stringify(session));
}

export function loadSession(roomId: string): Session | null {
  const value = localStorage.getItem(sessionKey(roomId));
  if (!value) return null;
  try {
    const session = JSON.parse(value) as Session;
    return session.token ? session : null;
  } catch {
    localStorage.removeItem(sessionKey(roomId));
    return null;
  }
}

export function rememberRoom(session: Session, snapshot: RoomSnapshot): void {
  const participantName = snapshot.participants.find((item) => item.id === session.participantId)?.displayName ?? "You";
  const room: RecentRoom = {
    roomId: session.roomId,
    title: snapshot.room.title,
    role: session.role,
    participantName,
    updatedAt: Date.now(),
  };
  const rooms = loadRecentRooms().filter((item) => item.roomId !== session.roomId);
  localStorage.setItem(recentRoomsKey, JSON.stringify([room, ...rooms].slice(0, 12)));
}

export function loadRecentRooms(): RecentRoom[] {
  try {
    const value = JSON.parse(localStorage.getItem(recentRoomsKey) ?? "[]") as RecentRoom[];
    return Array.isArray(value) ? value.filter((item) => item?.roomId && item?.title) : [];
  } catch {
    localStorage.removeItem(recentRoomsKey);
    return [];
  }
}

export function personalRoomUrl(session: Session): string {
  return `${location.origin}/room/${session.roomId}#access=${session.token}`;
}

export function roomWebSocketUrl(session: Session): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/rooms/${session.roomId}/ws`;
}

export function roomWebSocketProtocols(session: Session): string[] {
  return ["rally", session.token];
}
