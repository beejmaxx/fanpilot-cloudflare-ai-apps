import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Constraint, Participant, ProposalWorkflowParams, Room } from "../shared/types";
import { generatePlanningProposals } from "./ai";
import type { Env } from "./env";

interface WorkflowSnapshot {
  room: Room;
  participants: Participant[];
  constraints: Constraint[];
}

export class ProposalWorkflow extends WorkflowEntrypoint<Env, ProposalWorkflowParams> {
  async run(event: WorkflowEvent<ProposalWorkflowParams>, step: WorkflowStep): Promise<{ proposalCount: number }> {
    const { roomId, sourceStateVersion, workflowRunId } = event.payload;
    const stub = this.env.RALLY_ROOMS.getByName(roomId);

    try {
      const snapshot = await step.do("load versioned room state", async () => {
        const response = await stub.fetch(
          `https://room.internal/internal/workflow-snapshot?stateVersion=${sourceStateVersion}`,
        );
        if (!response.ok) throw new Error(`Could not load room state (${response.status})`);
        return response.json<WorkflowSnapshot>();
      });

      const proposals = await step.do(
        "generate constraint-aware proposals",
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" } },
        () => generatePlanningProposals(this.env.AI, snapshot.room, snapshot.participants, snapshot.constraints),
      );

      await step.do("commit proposals if room is unchanged", async () => {
        const response = await stub.fetch("https://room.internal/internal/workflow-commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowRunId, sourceStateVersion, proposals }),
        });
        if (!response.ok) throw new Error(`Could not commit proposals (${response.status})`);
        return { committed: true };
      });

      return { proposalCount: proposals.length };
    } catch (error) {
      await stub.fetch("https://room.internal/internal/workflow-failed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowRunId,
          error: error instanceof Error ? error.message : "Unknown workflow error",
        }),
      });
      throw error;
    }
  }
}
