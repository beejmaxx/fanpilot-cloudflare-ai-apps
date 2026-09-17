import { z } from "zod";

const displayName = z.string().trim().min(1).max(50);
const token = z.string().regex(/^[A-Za-z0-9_-]{40,100}$/);

export const createWorkspaceSchema = z.object({
  productName: z.string().trim().min(1).max(80),
  website: z.string().trim().url().max(500),
  audience: z.string().trim().min(2).max(300),
  tone: z.string().trim().min(2).max(200),
  timezone: z.string().trim().min(1).max(100),
  displayName,
  campaignTitle: z.string().trim().min(1).max(120),
  sourceKind: z.enum(["notes", "github"]),
  sourceBody: z.string().trim().max(20_000).default(""),
  sourceUrl: z.string().trim().max(500).default(""),
  turnstileToken: z.string().min(1).max(2_048),
});

export const initializeWorkspaceSchema = createWorkspaceSchema.omit({ turnstileToken: true }).extend({
  workspaceId: z.string().uuid(),
  sourceCheckedAt: z.number().int().positive(),
  allowFallback: z.boolean(),
});

export const invitationInfoSchema = z.object({ inviteToken: token });
export const joinWorkspaceSchema = z.object({ displayName, inviteToken: token });
export const createInvitationSchema = z.object({ role: z.enum(["editor", "viewer"]) });

export const factUpdateSchema = z.object({
  value: z.string().trim().min(1).max(1_000),
  confirmed: z.boolean(),
  expectedRevision: z.number().int().positive(),
});

export const postUpdateSchema = z.object({
  body: z.string().trim().min(1).max(3_000),
  expectedRevision: z.number().int().positive(),
});

export const schedulePostSchema = z.object({ plannedAt: z.number().int().positive().nullable() });
export const publishPostSchema = z.object({ publishedUrl: z.string().trim().url().max(1_000).optional() });
export const chatSchema = z.object({ body: z.string().trim().min(1).max(2_000), clientId: z.string().uuid() });
export const sourceUpdateSchema = z.object({
  sourceKind: z.enum(["notes", "github"]), sourceBody: z.string().trim().min(1).max(20_000),
  sourceUrl: z.string().trim().max(500).default(""), sourceCheckedAt: z.number().int().positive(),
});

export const analysisCommitSchema = z.object({
  jobId: z.string().uuid(), source: z.enum(["workers-ai", "fallback"]),
  question: z.string().max(500),
  facts: z.array(z.object({
    label: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(1_000),
    excerpt: z.string().trim().min(1).max(1_000),
  })).min(1).max(8),
});

export const generationCommitSchema = z.object({
  jobId: z.string().uuid(), source: z.enum(["workers-ai", "fallback"]),
  posts: z.array(z.object({
    channel: z.enum(["linkedin", "x"]),
    purpose: z.enum(["announcement", "feature-follow-up"]),
    body: z.string().trim().min(1).max(3_000),
    dependencyIds: z.array(z.string().uuid()).min(1).max(20),
  })).length(3),
});
