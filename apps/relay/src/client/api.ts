import type { RelaySnapshot, WorkspaceSession } from "../shared/types";

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error || `Request failed (${response.status})`);
  return data;
}

export const body = (value: unknown) => JSON.stringify(value);
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export function createWorkspace(input: unknown): Promise<WorkspaceSession> { return api("/api/workspaces", { method: "POST", body: body(input) }); }
export function session(id: string, token: string): Promise<WorkspaceSession> { return api(`/api/workspaces/${id}/session`, {}, token); }
export function snapshot(id: string, token: string): Promise<RelaySnapshot> { return api(`/api/workspaces/${id}/snapshot`, {}, token); }
