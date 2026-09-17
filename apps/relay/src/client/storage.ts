export interface SavedWorkspace { id: string; productName: string; token: string; participantId: string; updatedAt: number; }
const KEY = "relay:recent-workspaces";

export function recent(): SavedWorkspace[] { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } }
export function save(item: SavedWorkspace): void { const next = [item, ...recent().filter((v) => v.id !== item.id)].slice(0, 8); localStorage.setItem(KEY, JSON.stringify(next)); }
export function find(id: string): SavedWorkspace | undefined { return recent().find((value) => value.id === id); }
export function forget(id: string): void { localStorage.setItem(KEY, JSON.stringify(recent().filter((value) => value.id !== id))); }
