import type { AnalysisWorkflowParams, GenerationWorkflowParams } from "../shared/types";
import type { LaunchWorkspace } from "./room";

export interface Env {
  AI: Ai;
  LAUNCH_WORKSPACES: DurableObjectNamespace<LaunchWorkspace>;
  RELEASE_ANALYSIS_WORKFLOW: Workflow<AnalysisWorkflowParams>;
  CAMPAIGN_GENERATION_WORKFLOW: Workflow<GenerationWorkflowParams>;
  WORKSPACE_CREATION_RATE_LIMITER: RateLimit;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_EXPECTED_HOSTNAME?: string;
}
