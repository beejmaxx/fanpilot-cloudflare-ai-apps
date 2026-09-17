import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubRelease, parseGitHubSourceUrl } from "./source";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub release discovery", () => {
  it("accepts repository and exact release URLs while rejecting unrelated paths", () => {
    expect(parseGitHubSourceUrl("https://github.com/cloudflare/workers-sdk")).toEqual({ owner: "cloudflare", repository: "workers-sdk" });
    expect(parseGitHubSourceUrl("https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.1.0")).toEqual({ owner: "cloudflare", repository: "workers-sdk", tag: "wrangler@4.1.0" });
    expect(() => parseGitHubSourceUrl("https://example.com/cloudflare/workers-sdk")).toThrow(/public GitHub repository/);
    expect(() => parseGitHubSourceUrl("https://github.com/cloudflare/workers-sdk/issues/1")).toThrow(/public GitHub repository/);
  });

  it("selects the latest non-draft release with useful notes from a repository", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { tag_name: "v3", draft: true, body: "hidden" },
      { tag_name: "v2", body: "" },
      { name: "Version 1", tag_name: "v1", body: "Added durable launches.", html_url: "https://github.com/acme/widget/releases/tag/v1" },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const source = await fetchGitHubRelease("https://github.com/acme/widget");
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/acme/widget/releases?per_page=10", expect.any(Object));
    expect(source.body).toContain("Added durable launches.");
    expect(source.url).toBe("https://github.com/acme/widget/releases/tag/v1");
  });

  it("keeps exact release selection stable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ tag_name: "v1.2.3", body: "Fixed the import flow.", html_url: "https://github.com/acme/widget/releases/tag/v1.2.3" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const source = await fetchGitHubRelease("https://github.com/acme/widget/releases/tag/v1.2.3");
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/acme/widget/releases/tags/v1.2.3", expect.any(Object));
    expect(source.body).toContain("Fixed the import flow.");
  });
});
