import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { enforceDocumentCreationRateLimit } from "./rate-limit";

describe("document creation rate limit", () => {
  it("uses Cloudflare's trusted client address as the counter key", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    await enforceDocumentCreationRateLimit(new Request("https://editor.fanpilot.app/api/documents", {
      headers: { "CF-Connecting-IP": "203.0.113.8" },
    }), { DOCUMENT_CREATION_RATE_LIMITER: { limit } } as unknown as Env);
    expect(limit).toHaveBeenCalledWith({ key: "document-creation:203.0.113.8" });
  });

  it("returns 429 when the creation budget is exhausted", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    await expect(enforceDocumentCreationRateLimit(new Request("https://editor.fanpilot.app/api/documents"), {
      DOCUMENT_CREATION_RATE_LIMITER: { limit },
    } as unknown as Env)).rejects.toMatchObject({ status: 429 });
  });
});
