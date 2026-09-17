export type ParticipantRole = "owner" | "editor" | "viewer";
export type PanelName = "ai" | "comments" | "history" | "share";
export type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export type SuggestionStatus = "pending" | "accepted" | "rejected" | "stale";

export interface DocumentInfo {
  id: string;
  title: string;
  contentSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface Participant {
  id: string;
  displayName: string;
  role: ParticipantRole;
  joinedAt: number;
  lastSeenAt: number;
}

export interface ChatMessage {
  id: string;
  participantId: string | null;
  participantName: string;
  kind: "user" | "assistant" | "system";
  body: string;
  jobId: string | null;
  createdAt: number;
}

export interface Comment {
  id: string;
  blockId: string;
  participantId: string;
  participantName: string;
  body: string;
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Suggestion {
  id: string;
  jobId: string;
  blockId: string;
  beforeText: string;
  afterText: string;
  beforeFingerprint: string;
  rationale: string;
  status: SuggestionStatus;
  requesterName: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface Revision {
  id: string;
  label: string;
  actorName: string;
  createdAt: number;
  exportText: string;
  canRevert: boolean;
}

export interface DocumentSnapshot {
  document: DocumentInfo;
  participant: Participant;
  participants: Participant[];
  chatMessages: ChatMessage[];
  comments: Comment[];
  suggestions: Suggestion[];
  revisions: Revision[];
  activeJob: { id: string; status: JobStatus } | null;
}

export interface CreateDocumentResponse {
  documentId: string;
  accessToken: string;
  participantId: string;
  snapshot: DocumentSnapshot;
}

export interface JoinDocumentResponse extends CreateDocumentResponse {}

export interface AiEditWorkflowParams {
  documentId: string;
  jobId: string;
}

export interface CapturedBlock {
  id: string;
  type: string;
  text: string;
  fingerprint: string;
}

export interface AiJobSnapshot {
  documentId: string;
  title: string;
  jobId: string;
  instruction: string;
  scope: "selection" | "document" | "advice";
  requesterName: string;
  sourceSequence: number;
  blocks: CapturedBlock[];
  allowFallback: boolean;
}
