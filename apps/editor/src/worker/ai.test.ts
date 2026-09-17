import { describe, expect, it } from "vitest";
import type { AiJobSnapshot } from "../shared/types";
import { generateEdits } from "./ai";

const snapshot: AiJobSnapshot = {
  documentId: crypto.randomUUID(),
  title: "Test",
  jobId: crypto.randomUUID(),
  instruction: "Make it clearer",
  scope: "selection",
  requesterName: "Writer",
  sourceSequence: 1,
  blocks: [{ id: crypto.randomUUID(), type: "paragraph", text: "A useful sentence.", fingerprint: "abc" }],
  allowFallback: false,
};

describe("AI fallback policy", () => {
  it("surfaces model errors in production", async () => {
    const ai = { run: () => Promise.reject(new Error("model unavailable")) } as unknown as Ai;
    await expect(generateEdits(ai, snapshot, false)).rejects.toThrow("model unavailable");
  });

  it("uses deterministic output only when local fallback is explicitly allowed", async () => {
    const ai = { run: () => Promise.reject(new Error("model unavailable")) } as unknown as Ai;
    const result = await generateEdits(ai, { ...snapshot, allowFallback: true }, true);
    expect(result.source).toBe("fallback");
    expect(result.changes).toHaveLength(1);
  });
});
