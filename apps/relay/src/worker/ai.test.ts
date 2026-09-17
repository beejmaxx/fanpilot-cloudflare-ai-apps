import { describe, expect, it, vi } from "vitest";
import { analyzeRelease, generateCampaign } from "./ai";

describe("Workers AI response handling", () => {
  it("accepts structured response objects from release analysis", async () => {
    const sourceBody = "Launch Relay now discovers GitHub releases from a repository URL.";
    const ai = { run: vi.fn().mockResolvedValue({ response: { question: "When is it available?", facts: [{ label: "GitHub discovery", value: "Discovers releases from repository URLs", excerpt: sourceBody }] } }) } as unknown as Ai;
    const result = await analyzeRelease(ai, { jobId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), productName: "Launch Relay", audience: "Small teams", sourceBody, allowFallback: false });
    expect(result.source).toBe("workers-ai");
    expect(result.facts).toHaveLength(1);
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ response_format: expect.objectContaining({ type: "json_schema" }) }));
  });

  it("accepts structured response objects from campaign generation", async () => {
    const fact = { id: crypto.randomUUID(), label: "Release", value: "Repository discovery shipped", excerpt: "Repository discovery shipped", sourceKind: "release" as const, confirmed: true, revision: 1, updatedAt: Date.now() };
    const posts = [
      { channel: "linkedin", purpose: "announcement", body: "Repository discovery shipped.", dependencyIds: [fact.id] },
      { channel: "x", purpose: "announcement", body: "Repository discovery shipped.", dependencyIds: [fact.id] },
      { channel: "linkedin", purpose: "feature-follow-up", body: "A closer look at repository discovery.", dependencyIds: [fact.id] },
    ];
    const ai = { run: vi.fn().mockResolvedValue({ response: { posts } }) } as unknown as Ai;
    const result = await generateCampaign(ai, { jobId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), productName: "Launch Relay", website: "https://launch.fanpilot.app", audience: "Small teams", tone: "Clear", facts: [fact], allowFallback: false });
    expect(result.source).toBe("workers-ai");
    expect(result.posts).toHaveLength(3);
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ response_format: expect.objectContaining({ type: "json_schema" }) }));
  });
});
