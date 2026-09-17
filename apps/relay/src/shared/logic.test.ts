import { describe, expect, it } from "vitest";
import { dependencyFingerprint, isReadyToPost, scheduleChangeNeedsReview } from "./logic";
import type { CampaignPost, ReleaseFact } from "./types";

const fact: ReleaseFact = { id: "00000000-0000-4000-8000-000000000001", label: "Availability", value: "Today", excerpt: "Available today", sourceKind: "release", confirmed: true, revision: 1, updatedAt: 1 };
const post: CampaignPost = { id: "p", channel: "linkedin", purpose: "announcement", body: "Available today", revision: 1, editorialState: "approved", dependencyIds: [fact.id], plannedAt: 10, publishedAt: null, publishedUrl: null, correctionNeeded: false, updatedAt: 1 };

describe("campaign validity", () => {
  it("binds dependency fingerprints to confirmation and revisions", () => {
    expect(dependencyFingerprint([fact], [fact.id])).toBe(`${fact.id}:1:1`);
    expect(dependencyFingerprint([{ ...fact, revision: 2 }], [fact.id])).not.toBe(dependencyFingerprint([fact], [fact.id]));
  });
  it("only marks approved due posts with confirmed facts ready", () => {
    expect(isReadyToPost(post, [fact], 11)).toBe(true);
    expect(isReadyToPost(post, [{ ...fact, confirmed: false }], 11)).toBe(false);
    expect(isReadyToPost({ ...post, editorialState: "needs_changes" }, [fact], 11)).toBe(false);
  });
  it("requires review when relative timing copy is rescheduled", () => {
    expect(scheduleChangeNeedsReview("Available today", 10, 20)).toBe(true);
    expect(scheduleChangeNeedsReview("Available September 20", 10, 20)).toBe(false);
  });
});
