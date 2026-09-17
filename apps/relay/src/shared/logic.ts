import type { CampaignPost, ReleaseFact } from "./types";

export function dependencyFingerprint(facts: ReleaseFact[], ids: string[]): string {
  return ids.slice().sort().map((id) => {
    const fact = facts.find((item) => item.id === id);
    return fact ? `${fact.id}:${fact.revision}:${Number(fact.confirmed)}` : `${id}:missing`;
  }).join("|");
}

export function isReadyToPost(post: CampaignPost, facts: ReleaseFact[], now = Date.now()): boolean {
  if (post.editorialState !== "approved" || !post.plannedAt || post.plannedAt > now || post.publishedAt) return false;
  return post.dependencyIds.every((id) => facts.some((fact) => fact.id === id && fact.confirmed));
}

export function scheduleChangeNeedsReview(body: string, previous: number | null, next: number | null): boolean {
  if (previous === next) return false;
  return /\b(today|tomorrow|tonight|this (morning|afternoon|evening|week|month))\b/i.test(body);
}
