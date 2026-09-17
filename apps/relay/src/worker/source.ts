import { HttpError } from "./http";

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:releases\/tag\/(.+)|releases)\/?)?$/;

interface GitHubRelease {
  name?: string;
  tag_name?: string;
  body?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
}

export function parseGitHubSourceUrl(value: string): { owner: string; repository: string; tag?: string } {
  const match = value.trim().replace(/\/$/, "").match(GITHUB_URL);
  if (!match) throw new HttpError(400, "Use a public GitHub repository or release URL, such as https://github.com/cloudflare/workers-sdk");
  const [, owner, repository, encodedTag] = match;
  if (!encodedTag) return { owner, repository };
  try { return { owner, repository, tag: decodeURIComponent(encodedTag) }; }
  catch { throw new HttpError(400, "The GitHub release tag is invalid"); }
}

export async function fetchGitHubRelease(value: string): Promise<{ body: string; url: string; checkedAt: number }> {
  const { owner, repository, tag } = parseGitHubSourceUrl(value);
  const repoApi = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  if (!tag) {
    const feedRelease = await fetchLatestReleaseFeed(owner, repository);
    if (feedRelease) return feedRelease;
  }
  const endpoint = tag ? `${repoApi}/releases/tags/${encodeURIComponent(tag)}` : `${repoApi}/releases?per_page=10`;
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: { accept: "application/vnd.github+json", "user-agent": "launch-relay" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    console.warn("GitHub release fetch failed", error instanceof Error ? error.message : "Unknown fetch error");
    throw new HttpError(503, "GitHub could not be reached. Paste the release notes instead");
  }
  if (response.status >= 300 && response.status < 400) throw new HttpError(502, "GitHub returned an unexpected redirect");
  if (response.status === 404) throw new HttpError(404, `That public GitHub ${tag ? "release" : "repository"} was not found. Paste the release notes instead`);
  if (response.status === 403 || response.status === 429) throw new HttpError(503, "GitHub's public API limit was reached. Paste the release notes instead");
  if (!response.ok) throw new HttpError(502, "GitHub could not provide that release. Paste the release notes instead");
  const result = await response.json<GitHubRelease | GitHubRelease[]>();
  const data = Array.isArray(result)
    ? result.find((release) => !release.draft && Boolean(release.body?.trim()))
    : result;
  if (!data) return fetchTaggedChangelog(owner, repository, repoApi);
  const body = [data.name || data.tag_name, data.body, data.prerelease ? "GitHub marks this as a prerelease." : "GitHub marks this as a published release."]
    .filter(Boolean).join("\n\n").slice(0, 20_000);
  if (!data.body?.trim()) throw new HttpError(422, "That release has no notes. Use the repository URL to let Relay find another release, or paste release notes");
  return { body, url: data.html_url || value, checkedAt: Date.now() };
}

async function fetchLatestReleaseFeed(owner: string, repository: string): Promise<{ body: string; url: string; checkedAt: number } | null> {
  const feedUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases.atom`;
  let response: Response;
  try { response = await fetch(feedUrl, { headers: { accept: "application/atom+xml", "user-agent": "launch-relay" }, redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
  catch (error) {
    console.warn("GitHub release feed fetch failed", error instanceof Error ? error.message : "Unknown fetch error");
    return null;
  }
  if (response.status >= 300 && response.status < 400) throw new HttpError(502, "GitHub returned an unexpected release-feed redirect");
  if (response.status === 404) throw new HttpError(404, "That public GitHub repository was not found. Paste the release notes instead");
  if (!response.ok) return null;
  const xml = (await response.text()).slice(0, 1_000_000);
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;
  const title = decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "Latest release").trim();
  const href = decodeEntities(entry.match(/<link\s+rel="alternate"\s+type="text\/html"\s+href="([^"]+)"\s*\/?\s*>/)?.[1] || "");
  const encodedContent = entry.match(/<content\s+type="html">([\s\S]*?)<\/content>/)?.[1] || "";
  const releaseText = htmlToText(decodeEntities(encodedContent)).slice(0, 19_000).trim();
  if (!href || !releaseText) return null;
  const parsed = parseGitHubSourceUrl(href);
  if (parsed.owner !== owner || parsed.repository !== repository || !parsed.tag) throw new HttpError(502, "GitHub returned an invalid release-feed link");
  return { body: [title, releaseText, "GitHub marks this as a published release."].join("\n\n").slice(0, 20_000), url: href, checkedAt: Date.now() };
}

function htmlToText(value: string): string {
  return decodeEntities(value
    .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<\s*li(?:\s[^>]*)?>/gi, "- ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const number = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()] || entity;
  });
}

async function fetchTaggedChangelog(owner: string, repository: string, repoApi: string): Promise<{ body: string; url: string; checkedAt: number }> {
  const tagsResponse = await githubFetch(`${repoApi}/tags?per_page=1`);
  const tags = await tagsResponse.json<Array<{ name?: string }>>();
  const tag = tags[0]?.name;
  if (!tag) throw new HttpError(422, "This repository has no published releases or tags with usable notes. Paste a changelog instead");
  const rootResponse = await githubFetch(`${repoApi}/contents?ref=${encodeURIComponent(tag)}`);
  const files = await rootResponse.json<Array<{ name?: string; download_url?: string | null }>>();
  const changelog = files.find((file) => /^(changelog|changes|history|release-notes)(\.[a-z0-9_-]+)?$/i.test(file.name || "") && file.download_url);
  if (!changelog?.download_url) throw new HttpError(422, `Relay found tag ${tag}, but no release notes or root changelog. Paste the notes instead`);
  const rawUrl = new URL(changelog.download_url);
  if (rawUrl.protocol !== "https:" || rawUrl.hostname !== "raw.githubusercontent.com") throw new HttpError(502, "GitHub returned an invalid changelog location");
  const raw = await fetch(changelog.download_url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (raw.status >= 300 && raw.status < 400) throw new HttpError(502, "GitHub returned an unexpected changelog redirect");
  if (!raw.ok) throw new HttpError(502, "GitHub could not provide the repository changelog. Paste the notes instead");
  const changelogBody = (await raw.text()).slice(0, 19_000).trim();
  if (!changelogBody) throw new HttpError(422, "The repository changelog is empty. Paste release notes instead");
  return {
    body: [`Latest repository tag: ${tag}`, `Changelog at ${tag}:`, changelogBody].join("\n\n").slice(0, 20_000),
    url: `https://github.com/${owner}/${repository}/tree/${encodeURIComponent(tag)}`,
    checkedAt: Date.now(),
  };
}

async function githubFetch(endpoint: string): Promise<Response> {
  let response: Response;
  try { response = await fetch(endpoint, { headers: { accept: "application/vnd.github+json", "user-agent": "launch-relay" }, redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
  catch (error) {
    console.warn("GitHub repository fetch failed", error instanceof Error ? error.message : "Unknown fetch error");
    throw new HttpError(503, "GitHub could not be reached. Paste the release notes instead");
  }
  if (response.status >= 300 && response.status < 400) throw new HttpError(502, "GitHub returned an unexpected redirect");
  if (response.status === 404) throw new HttpError(404, "That public GitHub repository was not found. Paste the release notes instead");
  if (response.status === 403 || response.status === 429) throw new HttpError(503, "GitHub's public API limit was reached. Paste the release notes instead");
  if (!response.ok) throw new HttpError(502, "GitHub could not provide that repository. Paste the release notes instead");
  return response;
}

export function isLocalRequest(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}
