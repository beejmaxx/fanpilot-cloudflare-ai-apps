export interface SavedDocument {
  id: string;
  title: string;
  participantId: string;
  token: string;
  updatedAt: number;
}

const RECENT_KEY = "draft:recent-documents";

export function saveDocument(document: SavedDocument): void {
  const recent = recentDocuments().filter((item) => item.id !== document.id);
  localStorage.setItem(RECENT_KEY, JSON.stringify([document, ...recent].slice(0, 12)));
}

export function recentDocuments(): SavedDocument[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as SavedDocument[];
    return Array.isArray(value) ? value.filter((item) => item.id && item.token) : [];
  } catch {
    return [];
  }
}

export function savedDocument(id: string): SavedDocument | null {
  return recentDocuments().find((item) => item.id === id) ?? null;
}

export function forgetDocument(id: string): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentDocuments().filter((item) => item.id !== id)));
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(`draft:pending:${id}:`)) localStorage.removeItem(key);
  }
}
