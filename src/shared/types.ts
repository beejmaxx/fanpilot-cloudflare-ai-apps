export type RoomStage = "collecting" | "generating" | "voting" | "finalized";
export type ParticipantRole = "organizer" | "participant";
export type AiSource = "workers-ai" | "fallback";
export type ConstraintType =
  | "date"
  | "time"
  | "location"
  | "budget"
  | "dietary"
  | "accessibility"
  | "attendance"
  | "preference";
export type ConstraintStrength = "hard" | "soft";

export interface Room {
  id: string;
  title: string;
  prompt: string;
  stage: RoomStage;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
  finalizedProposalId: string | null;
  workflowStatus: "idle" | "running" | "complete" | "failed";
}

export interface Participant {
  id: string;
  displayName: string;
  role: ParticipantRole;
  rsvpStatus: "pending" | "yes" | "no" | "maybe";
  joinedAt: number;
  lastSeenAt: number;
}

export interface Message {
  id: string;
  participantId: string | null;
  participantName: string;
  kind: "user" | "agent" | "system";
  body: string;
  createdAt: number;
}

export interface Constraint {
  id: string;
  participantId: string | null;
  participantName: string;
  sourceMessageId: string | null;
  type: ConstraintType;
  value: string;
  strength: ConstraintStrength;
  status: "inferred" | "confirmed";
  createdAt: number;
  updatedAt: number;
}

export interface ProposalDetails {
  when: string;
  where: string;
  cost: string;
  notes: string[];
}

export interface Proposal {
  id: string;
  proposalSetId: string;
  title: string;
  summary: string;
  details: ProposalDetails;
  tradeoffs: string[];
  score: number;
  votes: number;
  createdAt: number;
}

export interface Vote {
  proposalId: string;
  participantId: string;
  value: 1 | -1;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoomSnapshot {
  room: Room;
  participants: Participant[];
  messages: Message[];
  constraints: Constraint[];
  proposals: Proposal[];
  votes: Vote[];
  eventSequence: number;
  aiUsage: {
    extraction: AiSource | null;
    proposals: AiSource | null;
  };
}

export interface Session {
  roomId: string;
  participantId: string;
  token?: string;
  role: ParticipantRole;
}

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
}

export interface RoomSummary {
  id: string;
  title: string;
  role: ParticipantRole;
  createdAt: number;
  updatedAt: number;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

export interface ProposalWorkflowParams {
  roomId: string;
  sourceStateVersion: number;
  workflowRunId: string;
  requestedBy: string;
}

export interface AiConstraint {
  type: ConstraintType;
  value: string;
  strength: ConstraintStrength;
}

export interface AiExtraction {
  constraints: AiConstraint[];
  acknowledgement: string;
  followUpQuestion: string | null;
}

export interface AiProposal {
  title: string;
  summary: string;
  when: string;
  where: string;
  cost: string;
  notes: string[];
  tradeoffs: string[];
  score: number;
}
