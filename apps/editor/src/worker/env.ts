import type { DocumentRoom } from "./room";
import type { AiEditWorkflowParams } from "../shared/types";

export interface Env {
  AI: Ai;
  DOCUMENT_ROOMS: DurableObjectNamespace<DocumentRoom>;
  AI_EDIT_WORKFLOW: Workflow<AiEditWorkflowParams>;
  DOCUMENT_CREATION_RATE_LIMITER: RateLimit;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_EXPECTED_HOSTNAME?: string;
}
