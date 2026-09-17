export type ParticipantRole = "owner" | "editor" | "viewer";
export type JobKind = "analysis" | "generation";
export type JobStatus = "running" | "complete" | "failed";
export type EditorialState = "draft" | "needs_changes" | "approved";

export interface WorkspaceInfo {
  id: string;
  productName: string;
  website: string;
  audience: string;
  tone: string;
  timezone: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignInfo {
  id: string;
  title: string;
  sourceKind: "notes" | "github";
  sourceUrl: string | null;
  sourceBody: string;
  sourceCheckedAt: number;
  stage: "facts" | "posts" | "ready" | "completed";
  question: string | null;
  paused: boolean;
}

export interface Participant {
  id: string;
  displayName: string;
  role: ParticipantRole;
}

export interface ReleaseFact {
  id: string;
  label: string;
  value: string;
  excerpt: string;
  sourceKind: "release" | "owner";
  confirmed: boolean;
  revision: number;
  updatedAt: number;
}

export interface CampaignPost {
  id: string;
  channel: "linkedin" | "x";
  purpose: "announcement" | "feature-follow-up";
  body: string;
  revision: number;
  editorialState: EditorialState;
  dependencyIds: string[];
  plannedAt: number | null;
  publishedAt: number | null;
  publishedUrl: string | null;
  correctionNeeded: boolean;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  participantName: string;
  kind: "user" | "assistant";
  body: string;
  createdAt: number;
}

export interface RelaySnapshot {
  workspace: WorkspaceInfo;
  campaign: CampaignInfo;
  participant: Participant;
  participants: Participant[];
  facts: ReleaseFact[];
  posts: CampaignPost[];
  messages: ChatMessage[];
  activeJob: { id: string; kind: JobKind; status: JobStatus; error: string | null } | null;
}

export interface WorkspaceSession {
  workspaceId: string;
  participantId: string;
  token: string;
  snapshot: RelaySnapshot;
}

export interface AnalysisWorkflowParams { workspaceId: string; jobId: string; }
export interface GenerationWorkflowParams { workspaceId: string; jobId: string; }

export interface AnalysisInput {
  jobId: string;
  workspaceId: string;
  productName: string;
  audience: string;
  sourceBody: string;
  allowFallback: boolean;
}

export interface GenerationInput {
  jobId: string;
  workspaceId: string;
  productName: string;
  website: string;
  audience: string;
  tone: string;
  facts: ReleaseFact[];
  allowFallback: boolean;
}
