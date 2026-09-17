import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AiEditWorkflowParams, AiJobSnapshot } from "../shared/types";
import { generateEdits } from "./ai";
import type { Env } from "./env";

export class AiEditWorkflow extends WorkflowEntrypoint<Env, AiEditWorkflowParams> {
  async run(event: WorkflowEvent<AiEditWorkflowParams>, step: WorkflowStep): Promise<{ suggestionCount: number }> {
    const { documentId, jobId } = event.payload;
    const room = this.env.DOCUMENT_ROOMS.getByName(documentId);
    try {
      const snapshot = await step.do("load immutable document snapshot", async () => {
        const response = await room.fetch(`https://document.internal/internal/ai-job?jobId=${encodeURIComponent(jobId)}`);
        if (!response.ok) throw new Error(`Could not load AI job (${response.status})`);
        return response.json<AiJobSnapshot>();
      });
      const generation = await step.do(
        "generate reviewable edits",
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" } },
        () => generateEdits(this.env.AI, snapshot, snapshot.allowFallback),
      );
      await step.do("commit proposals without changing the document", async () => {
        const response = await room.fetch("https://document.internal/internal/ai-commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, source: generation.source, answer: generation.answer, changes: generation.changes }),
        });
        if (!response.ok) throw new Error(`Could not commit AI suggestions (${response.status})`);
        return { committed: true };
      });
      return { suggestionCount: generation.changes.length };
    } catch (error) {
      await room.fetch("https://document.internal/internal/ai-failed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, error: error instanceof Error ? error.message : "Unknown AI workflow error" }),
      });
      throw error;
    }
  }
}
