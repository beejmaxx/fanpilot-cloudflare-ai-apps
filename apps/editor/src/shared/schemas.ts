import { z } from "zod";

const displayName = z.string().trim().min(1).max(50);
const token = z.string().regex(/^[A-Za-z0-9_-]{40,100}$/);

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  displayName,
  template: z.enum(["blank", "product-spec", "proposal"]).default("blank"),
  turnstileToken: z.string().min(1).max(2_048),
});

export const initializeDocumentSchema = createDocumentSchema
  .omit({ turnstileToken: true })
  .extend({ documentId: z.string().uuid() });

export const joinDocumentSchema = z.object({
  displayName,
  inviteToken: token,
});

export const invitationInfoSchema = z.object({ inviteToken: token });

export const createInvitationSchema = z.object({ role: z.enum(["editor", "viewer"]) });

export const renameParticipantSchema = z.object({ displayName });

export const updateTitleSchema = z.object({ title: z.string().trim().min(1).max(120) });

export const commentSchema = z.object({
  blockId: z.string().uuid(),
  body: z.string().trim().min(1).max(2_000),
});

export const resolveCommentSchema = z.object({ resolved: z.boolean() });

export const aiRequestSchema = z.object({
  instruction: z.string().trim().min(1).max(2_000),
  scope: z.enum(["selection", "document", "advice"]),
  blockIds: z.array(z.string().uuid()).max(40).default([]),
});

export const suggestionDecisionSchema = z.object({
  decision: z.enum(["accept", "reject"]),
});

export const acceptAllSchema = z.object({ jobId: z.string().uuid() });

export const workflowCommitSchema = z.object({
  jobId: z.string().uuid(),
  source: z.enum(["workers-ai", "fallback"]),
  answer: z.string().max(8_000),
  changes: z.array(z.object({
    blockId: z.string().uuid(),
    replacement: z.string().max(10_000),
    rationale: z.string().max(1_000),
  })).max(40),
});
