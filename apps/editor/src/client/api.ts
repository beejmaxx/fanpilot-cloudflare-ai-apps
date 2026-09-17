import type { CreateDocumentResponse, DocumentSnapshot, JoinDocumentResponse, ParticipantRole } from "../shared/types";

export async function turnstileConfig(): Promise<{ siteKey: string; action: string }> {
  return request("/api/turnstile");
}

export async function createDocument(input: { title: string; displayName: string; template: string; turnstileToken: string }): Promise<CreateDocumentResponse> {
  return request("/api/documents", { method: "POST", body: JSON.stringify(input) });
}

export async function invitationInfo(documentId: string, inviteToken: string): Promise<{ title: string; role: ParticipantRole }> {
  return request(`/api/documents/${documentId}/invitation-info`, { method: "POST", body: JSON.stringify({ inviteToken }) });
}

export async function joinDocument(documentId: string, input: { displayName: string; inviteToken: string }): Promise<JoinDocumentResponse> {
  return request(`/api/documents/${documentId}/join`, { method: "POST", body: JSON.stringify(input) });
}

export async function session(documentId: string, token: string): Promise<{ snapshot: DocumentSnapshot }> {
  return authed(documentId, token, "session");
}

export async function updateTitle(documentId: string, token: string, title: string): Promise<DocumentSnapshot> {
  return authed(documentId, token, "title", { method: "PATCH", body: JSON.stringify({ title }) });
}

export async function rename(documentId: string, token: string, displayName: string): Promise<DocumentSnapshot> {
  return authed(documentId, token, "participant", { method: "PATCH", body: JSON.stringify({ displayName }) });
}

export async function createInvite(documentId: string, token: string, role: "editor" | "viewer"): Promise<{ inviteToken: string }> {
  return authed(documentId, token, "invitations", { method: "POST", body: JSON.stringify({ role }) });
}

export async function createComment(documentId: string, token: string, blockId: string, body: string): Promise<DocumentSnapshot> {
  return authed(documentId, token, "comments", { method: "POST", body: JSON.stringify({ blockId, body }) });
}

export async function resolveComment(documentId: string, token: string, id: string, resolved: boolean): Promise<DocumentSnapshot> {
  return authed(documentId, token, `comments/${id}/resolve`, { method: "POST", body: JSON.stringify({ resolved }) });
}

export async function askAI(documentId: string, token: string, input: { instruction: string; scope: string; blockIds: string[] }): Promise<{ snapshot: DocumentSnapshot }> {
  return authed(documentId, token, "ai", { method: "POST", body: JSON.stringify(input) });
}

export async function decideSuggestion(documentId: string, token: string, id: string, decision: "accept" | "reject"): Promise<{ snapshot: DocumentSnapshot }> {
  return authed(documentId, token, `suggestions/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
}

export async function acceptAll(documentId: string, token: string, jobId: string): Promise<{ snapshot: DocumentSnapshot }> {
  return authed(documentId, token, "suggestions/accept-all", { method: "POST", body: JSON.stringify({ jobId }) });
}

export async function revertRevision(documentId: string, token: string, id: string): Promise<{ snapshot: DocumentSnapshot }> {
  return authed(documentId, token, `revisions/${id}/revert`, { method: "POST", body: "{}" });
}

export async function revokeParticipant(documentId: string, token: string, id: string): Promise<DocumentSnapshot> {
  return authed(documentId, token, `participants/${id}/revoke`, { method: "POST", body: "{}" });
}

export async function rotateAccess(documentId: string, token: string): Promise<{ accessToken: string }> {
  return authed(documentId, token, "participant/rotate-access", { method: "POST", body: "{}" });
}

export async function exportDocument(documentId: string, token: string, format: "markdown" | "text"): Promise<string> {
  const response = await fetch(`/api/documents/${documentId}/export?format=${format}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.text();
}

async function authed<T>(documentId: string, token: string, action: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return request(`/api/documents/${documentId}/${action}`, { ...init, headers });
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error ?? `Request failed (${response.status})`;
}
