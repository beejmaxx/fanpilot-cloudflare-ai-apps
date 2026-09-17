import { z } from "zod";
import type { AnalysisInput, GenerationInput } from "../shared/types";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const analysisOutput = z.object({
  question: z.string().max(500),
  facts: z.array(z.object({ label: z.string().min(1).max(100), value: z.string().min(1).max(1_000), excerpt: z.string().min(1).max(1_000) })).min(1).max(8),
});
const generationOutput = z.object({
  posts: z.array(z.object({
    channel: z.enum(["linkedin", "x"]), purpose: z.enum(["announcement", "feature-follow-up"]),
    body: z.string().min(1).max(3_000), dependencyIds: z.array(z.string().uuid()).min(1).max(20),
  })).length(3),
});

export async function analyzeRelease(ai: Ai, input: AnalysisInput) {
  if (input.allowFallback) return { ...fallbackAnalysis(input), source: "fallback" as const };
  const prompt = `Extract only concrete product facts from these release notes. Every excerpt must be an exact substring of the notes. Do not infer customer availability from GitHub release status. Ask one short question about the highest-risk missing marketing detail. Product: ${input.productName}. Audience: ${input.audience}.\n\nRELEASE NOTES:\n${input.sourceBody}`;
  try {
    const result = await ai.run(MODEL, { messages: [{ role: "system", content: "Return valid JSON only." }, { role: "user", content: prompt }], response_format: { type: "json_object" }, max_tokens: 1_600 });
    const parsed = analysisOutput.parse(JSON.parse(modelText(result)));
    const facts = parsed.facts.filter((fact) => input.sourceBody.includes(fact.excerpt));
    if (!facts.length) throw new Error("No verifiable source excerpts");
    return { ...parsed, facts, source: "workers-ai" as const };
  } catch (error) {
    throw new Error(`Release analysis failed: ${error instanceof Error ? error.message : "invalid model response"}`);
  }
}

export async function generateCampaign(ai: Ai, input: GenerationInput) {
  if (input.allowFallback) return { ...fallbackGeneration(input), source: "fallback" as const };
  const factList = input.facts.map((fact) => `${fact.id} | ${fact.label}: ${fact.value}`).join("\n");
  const prompt = `Create exactly three accurate launch posts for ${input.productName}: LinkedIn announcement, X announcement (max 280 characters), and LinkedIn feature follow-up. Audience: ${input.audience}. Tone: ${input.tone}. Destination: ${input.website}. Use only these confirmed facts. Map every factual post to the UUIDs it uses.\n${factList}`;
  try {
    const result = await ai.run(MODEL, { messages: [{ role: "system", content: "Return valid JSON only." }, { role: "user", content: prompt }], response_format: { type: "json_object" }, max_tokens: 2_000 });
    const parsed = generationOutput.parse(JSON.parse(modelText(result)));
    const allowed = new Set(input.facts.map((fact) => fact.id));
    if (parsed.posts.some((post) => post.dependencyIds.some((id) => !allowed.has(id)))) throw new Error("Unknown fact dependency");
    return { ...parsed, source: "workers-ai" as const };
  } catch (error) {
    throw new Error(`Campaign generation failed: ${error instanceof Error ? error.message : "invalid model response"}`);
  }
}

export async function answerClarification(ai: Ai, input: GenerationInput, question: string): Promise<{ body: string; source: "workers-ai" | "fallback" }> {
  if (input.allowFallback) return { body: "Use the fact cards to record the confirmed answer. I will keep every generated post tied to those facts.", source: "fallback" };
  const facts = input.facts.map((fact) => `${fact.label}: ${fact.value} (${fact.confirmed ? "confirmed" : "unconfirmed"})`).join("\n");
  const prompt = `You are Launch Relay. Answer briefly and help the user clarify a software release. Do not invent facts or claim that GitHub publication proves customer availability. Product: ${input.productName}. Audience: ${input.audience}.\nFacts:\n${facts}\n\nUser: ${question}`;
  const result = await ai.run(MODEL, { messages: [{ role: "system", content: "Be concise, factual, and ask for confirmation when evidence is missing." }, { role: "user", content: prompt }], max_tokens: 400 });
  return { body: modelText(result).slice(0, 2_000), source: "workers-ai" };
}

function fallbackAnalysis(input: AnalysisInput) {
  const segments = input.sourceBody.split(/\n+|(?<=[.!?])\s+/).map((value) => value.trim()).filter((value) => value.length >= 12);
  const facts = (segments.length ? segments : [input.sourceBody]).slice(0, 4).map((excerpt, index) => ({ label: index === 0 ? "Release" : `Feature ${index}`, value: excerpt.slice(0, 500), excerpt: excerpt.slice(0, 1_000) }));
  return { question: "When can customers use this release, and is access limited in any way?", facts };
}

function fallbackGeneration(input: GenerationInput) {
  const facts = input.facts;
  const summary = facts.slice(0, 2).map((fact) => fact.value).join(" ");
  const ids = facts.map((fact) => fact.id);
  return { posts: [
    { channel: "linkedin" as const, purpose: "announcement" as const, body: `${input.productName} just shipped an update for ${input.audience}.\n\n${summary}\n\nSee what changed: ${input.website}`, dependencyIds: ids },
    { channel: "x" as const, purpose: "announcement" as const, body: `${input.productName} update: ${facts[0]?.value ?? summary}\n\n${input.website}`.slice(0, 280), dependencyIds: ids.slice(0, 1) },
    { channel: "linkedin" as const, purpose: "feature-follow-up" as const, body: `A closer look at the latest ${input.productName} release:\n\n${summary}\n\nBuilt for ${input.audience}. ${input.website}`, dependencyIds: ids },
  ] };
}

function modelText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "response" in result && typeof result.response === "string") return result.response;
  throw new Error("Missing model response");
}
