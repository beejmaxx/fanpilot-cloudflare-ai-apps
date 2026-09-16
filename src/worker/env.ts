import type { RallyRoom } from "./room";
import type { ProposalWorkflowParams } from "../shared/types";

export interface Env {
  AI: Ai;
  RALLY_ROOMS: DurableObjectNamespace<RallyRoom>;
  PROPOSAL_WORKFLOW: Workflow<ProposalWorkflowParams>;
}
