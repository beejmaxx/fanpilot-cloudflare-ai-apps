import { describe, expect, it } from "vitest";
import type { Constraint, Room } from "../shared/types";
import { fallbackExtraction, fallbackProposals } from "./ai";

describe("local AI fallbacks", () => {
  it("separates hard constraints from preferences", () => {
    const result = fallbackExtraction(
      "I can only make it after 7:30 PM, and I need a vegetarian main. Quiet would be nice.",
      "Mei Lin",
    );

    expect(result.constraints).toEqual(
      expect.arrayContaining([
        { type: "time", value: "after 7:30 PM", strength: "hard" },
        { type: "dietary", value: "vegetarian", strength: "hard" },
        { type: "preference", value: "quiet", strength: "soft" },
      ]),
    );
  });

  it("carries hard requirements into every fallback proposal", () => {
    const room: Room = {
      id: crypto.randomUUID(),
      title: "Birthday dinner",
      prompt: "Plan a birthday dinner",
      stage: "generating",
      stateVersion: 3,
      createdAt: 1,
      updatedAt: 1,
      finalizedProposalId: null,
      workflowStatus: "running",
    };
    const constraint: Constraint = {
      id: crypto.randomUUID(),
      participantId: crypto.randomUUID(),
      participantName: "Mei Lin",
      sourceMessageId: crypto.randomUUID(),
      type: "dietary",
      value: "vegetarian main",
      strength: "hard",
      status: "inferred",
      createdAt: 1,
      updatedAt: 1,
    };

    const proposals = fallbackProposals(room, [constraint]);
    expect(proposals).toHaveLength(3);
    expect(proposals.every((proposal) => proposal.notes.includes("Must support: vegetarian main"))).toBe(true);
  });
});
