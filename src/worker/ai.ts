import { aiExtractionSchema, aiProposalSetSchema } from "../shared/schemas";
import type {
  AiConstraint,
  AiExtraction,
  AiProposal,
  Constraint,
  Participant,
  Room,
} from "../shared/types";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

const extractionJsonSchema = {
  type: "object",
  properties: {
    constraints: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "date",
              "time",
              "location",
              "budget",
              "dietary",
              "accessibility",
              "attendance",
              "preference",
            ],
          },
          value: { type: "string" },
          strength: { type: "string", enum: ["hard", "soft"] },
        },
        required: ["type", "value", "strength"],
        additionalProperties: false,
      },
    },
    acknowledgement: { type: "string" },
    followUpQuestion: { type: ["string", "null"] },
  },
  required: ["constraints", "acknowledgement", "followUpQuestion"],
  additionalProperties: false,
} as const;

const proposalJsonSchema = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          when: { type: "string" },
          where: { type: "string" },
          cost: { type: "string" },
          notes: { type: "array", items: { type: "string" }, maxItems: 6 },
          tradeoffs: { type: "array", items: { type: "string" }, maxItems: 5 },
          score: { type: "number", minimum: 0, maximum: 100 },
        },
        required: ["title", "summary", "when", "where", "cost", "notes", "tradeoffs", "score"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
} as const;

function responseValue(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("response" in result)) {
    throw new Error("Workers AI returned an unexpected response");
  }
  const response = (result as { response: unknown }).response;
  if (typeof response === "string") return JSON.parse(response);
  return response;
}

export async function extractPlanningFacts(
  ai: Ai,
  message: string,
  participantName: string,
  existingConstraints: Constraint[],
): Promise<AiExtraction> {
  const existing = existingConstraints.map((constraint) => ({
    type: constraint.type,
    value: constraint.value,
    strength: constraint.strength,
    owner: constraint.participantName,
  }));

  try {
    const result = await ai.run(MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are Rally, a concise group planning coordinator. Extract only explicit planning facts from the newest message. Hard constraints make an option impossible; soft constraints are preferences. Do not duplicate existing facts. Acknowledge what changed in one sentence. Ask at most one targeted follow-up question, only when the message creates ambiguity that blocks planning.",
        },
        {
          role: "user",
          content: JSON.stringify({ participantName, message, existingConstraints: existing }),
        },
      ],
      response_format: { type: "json_schema", json_schema: extractionJsonSchema },
      max_tokens: 550,
      temperature: 0.1,
    });
    return aiExtractionSchema.parse(responseValue(result));
  } catch (error) {
    console.warn("Workers AI extraction failed; using deterministic fallback", error);
    return fallbackExtraction(message, participantName);
  }
}

export async function generatePlanningProposals(
  ai: Ai,
  room: Room,
  participants: Participant[],
  constraints: Constraint[],
): Promise<AiProposal[]> {
  const state = {
    event: room.prompt,
    participants: participants.map((participant) => ({
      name: participant.displayName,
      rsvp: participant.rsvpStatus,
    })),
    constraints: constraints.map((constraint) => ({
      owner: constraint.participantName,
      type: constraint.type,
      value: constraint.value,
      strength: constraint.strength,
    })),
  };

  try {
    const result = await ai.run(MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are Rally, a practical group planning coordinator. Produce exactly three distinct, plausible options. Every option must satisfy every hard constraint. Soft constraints affect the score and tradeoffs. Do not claim that a real reservation, price, address, or availability was verified. Clearly label assumptions. Keep every field concise.",
        },
        { role: "user", content: JSON.stringify(state) },
      ],
      response_format: { type: "json_schema", json_schema: proposalJsonSchema },
      max_tokens: 1_500,
      temperature: 0.35,
    });
    return aiProposalSetSchema.parse(responseValue(result)).proposals;
  } catch (error) {
    console.warn("Workers AI proposal generation failed; using deterministic fallback", error);
    return fallbackProposals(room, constraints);
  }
}

export function fallbackExtraction(message: string, participantName: string): AiExtraction {
  const constraints: AiConstraint[] = [];
  const normalized = message.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();

  const date = normalized.match(/\b(this |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (date) constraints.push({ type: "date", value: date[0], strength: "hard" });

  const time = normalized.match(/\b(?:after|before|around|at|from)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i);
  if (time) constraints.push({ type: "time", value: time[0].trim(), strength: /only|can't|cannot|must/.test(lower) ? "hard" : "soft" });

  const budget = normalized.match(/(?:[$€£¥]\s?\d+(?:\s*[-–]\s*[$€£¥]?\d+)?|\d+\s*(?:usd|eur|gbp|rmb|yuan)(?:\s*(?:each|per person))?)/i);
  if (budget) constraints.push({ type: "budget", value: budget[0], strength: /under|maximum|max|can't exceed|no more than/.test(lower) ? "hard" : "soft" });

  const people = normalized.match(/\b\d+\s+(?:people|persons|guests|friends|of us)\b/i);
  if (people) constraints.push({ type: "attendance", value: people[0], strength: "hard" });

  const dietaryTerms = ["vegetarian", "vegan", "halal", "kosher", "gluten-free", "gluten free", "nut allergy", "allergy"];
  for (const term of dietaryTerms) {
    if (lower.includes(term)) constraints.push({ type: "dietary", value: term, strength: "hard" });
  }

  const accessibilityTerms = ["wheelchair", "step-free", "step free", "accessible", "hearing loop"];
  for (const term of accessibilityTerms) {
    if (lower.includes(term)) constraints.push({ type: "accessibility", value: term, strength: "hard" });
  }

  const preferenceTerms = ["quiet", "outdoor", "indoors", "casual", "fancy", "family-friendly", "pet-friendly"];
  for (const term of preferenceTerms) {
    if (lower.includes(term)) constraints.push({ type: "preference", value: term, strength: "soft" });
  }

  const locationMatch = normalized.match(/\b(?:near|around|in)\s+([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,3})/u);
  if (locationMatch) constraints.push({ type: "location", value: locationMatch[0], strength: "soft" });

  return {
    constraints,
    acknowledgement: constraints.length
      ? `Thanks, ${participantName}. I added ${constraints.length === 1 ? "that detail" : `${constraints.length} planning details`} to the shared plan.`
      : `Thanks, ${participantName}. I added your note to the conversation.`,
    followUpQuestion: null,
  };
}

export function fallbackProposals(room: Room, constraints: Constraint[]): AiProposal[] {
  const valueFor = (type: Constraint["type"], fallback: string) =>
    constraints.find((constraint) => constraint.type === type)?.value ?? fallback;
  const when = `${valueFor("date", "The agreed date")} · ${valueFor("time", "Time to confirm")}`;
  const where = valueFor("location", "A convenient central location");
  const cost = valueFor("budget", "Within the group's stated budget");
  const requirements = constraints
    .filter((constraint) => constraint.strength === "hard")
    .slice(0, 4)
    .map((constraint) => `Must support: ${constraint.value}`);

  return [
    {
      title: "Best overall fit",
      summary: `A balanced version of “${room.title}” that prioritizes every confirmed requirement.`,
      when,
      where,
      cost,
      notes: [...requirements, "Venue or activity availability still needs verification"],
      tradeoffs: ["Optimizes for consensus over novelty"],
      score: 92,
    },
    {
      title: "Easy and flexible",
      summary: "A low-friction option with room to adjust timing and headcount.",
      when,
      where,
      cost,
      notes: [...requirements, "Choose a flexible cancellation policy where possible"],
      tradeoffs: ["May feel less distinctive than the top option"],
      score: 84,
    },
    {
      title: "Something memorable",
      summary: "A more distinctive plan that preserves the hard constraints while accepting a small convenience tradeoff.",
      when,
      where,
      cost,
      notes: [...requirements, "Confirm the tradeoff with the group before booking"],
      tradeoffs: ["May require slightly more travel or coordination"],
      score: 76,
    },
  ];
}
