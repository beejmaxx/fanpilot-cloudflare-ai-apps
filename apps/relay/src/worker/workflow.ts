import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AnalysisInput, AnalysisWorkflowParams, GenerationInput, GenerationWorkflowParams } from "../shared/types";
import { analyzeRelease, generateCampaign } from "./ai";
import type { Env } from "./env";

export class ReleaseAnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {
  async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep): Promise<{ factCount: number }> {
    const { workspaceId, jobId } = event.payload;
    const stub = this.env.LAUNCH_WORKSPACES.getByName(workspaceId);
    try {
      const input = await step.do("load release snapshot", async () => responseJson<AnalysisInput>(await stub.fetch(`https://relay.internal/internal/analysis-input?jobId=${jobId}`)));
      const result = await step.do("extract release facts", { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" }, () => analyzeRelease(this.env.AI, input));
      await step.do("commit release facts", async () => ensureOk(await stub.fetch("https://relay.internal/internal/analysis-commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, ...result }) })));
      return { factCount: result.facts.length };
    } catch (error) {
      await stub.fetch("https://relay.internal/internal/job-failed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, error: message(error) }) });
      throw error;
    }
  }
}

export class CampaignGenerationWorkflow extends WorkflowEntrypoint<Env, GenerationWorkflowParams> {
  async run(event: WorkflowEvent<GenerationWorkflowParams>, step: WorkflowStep): Promise<{ postCount: number }> {
    const { workspaceId, jobId } = event.payload;
    const stub = this.env.LAUNCH_WORKSPACES.getByName(workspaceId);
    try {
      const input = await step.do("load confirmed campaign brief", async () => responseJson<GenerationInput>(await stub.fetch(`https://relay.internal/internal/generation-input?jobId=${jobId}`)));
      const result = await step.do("draft launch campaign", { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "45 seconds" }, () => generateCampaign(this.env.AI, input));
      await step.do("commit campaign posts", async () => ensureOk(await stub.fetch("https://relay.internal/internal/generation-commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, ...result }) })));
      return { postCount: result.posts.length };
    } catch (error) {
      await stub.fetch("https://relay.internal/internal/job-failed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, error: message(error) }) });
      throw error;
    }
  }
}

async function responseJson<T>(response: Response): Promise<T> { await ensureOk(response); return response.json<T>(); }
async function ensureOk(response: Response): Promise<void> { if (!response.ok) throw new Error((await response.json<{ error?: string }>()).error || `Request failed (${response.status})`); }
function message(error: unknown): string { return (error instanceof Error ? error.message : "Workflow failed").slice(0, 1_000); }
