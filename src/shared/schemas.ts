import { z } from "zod";

export const createRoomSchema = z.object({
  prompt: z.string().trim().min(8).max(1_500),
  organizerName: z.string().trim().min(1).max(60),
});

export const joinRoomSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
});

export const magicLinkSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(60),
  intent: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create"), prompt: z.string().trim().min(8).max(1_500) }),
    z.object({ type: z.literal("join"), invitationToken: z.string().regex(/^[0-9a-f]{64}$/i) }),
    z.object({ type: z.literal("restore"), roomId: z.string().uuid() }),
    z.object({ type: z.literal("rooms") }),
  ]),
});

export const messageSchema = z.object({
  body: z.string().trim().min(1).max(2_000),
  clientId: z.string().uuid(),
});

export const voteSchema = z.object({
  proposalId: z.string().uuid(),
  value: z.union([z.literal(1), z.literal(-1)]),
  reason: z.string().trim().max(500).default(""),
});

export const finalizeSchema = z.object({
  proposalId: z.string().uuid(),
});

export const aiExtractionSchema = z.object({
  constraints: z
    .array(
      z.object({
        type: z.enum([
          "date",
          "time",
          "location",
          "budget",
          "dietary",
          "accessibility",
          "attendance",
          "preference",
        ]),
        value: z.string().trim().min(1).max(240),
        strength: z.enum(["hard", "soft"]),
      }),
    )
    .max(12),
  acknowledgement: z.string().trim().min(1).max(500),
  followUpQuestion: z.string().trim().max(500).nullable(),
});

export const aiProposalSetSchema = z.object({
  proposals: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(100),
        summary: z.string().trim().min(1).max(500),
        when: z.string().trim().min(1).max(120),
        where: z.string().trim().min(1).max(160),
        cost: z.string().trim().min(1).max(120),
        notes: z.array(z.string().trim().min(1).max(200)).max(6),
        tradeoffs: z.array(z.string().trim().min(1).max(240)).max(5),
        score: z.number().min(0).max(100),
      }),
    )
    .min(2)
    .max(3),
});
