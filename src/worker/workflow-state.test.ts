import { describe, expect, it } from "vitest";
import type { Room } from "../shared/types";
import { isCurrentWorkflowResult } from "./workflow-state";

const room = {
  stage: "generating",
  stateVersion: 7,
} satisfies Pick<Room, "stage" | "stateVersion">;

describe("workflow result guards", () => {
  it("accepts the result only for the generating state version", () => {
    expect(isCurrentWorkflowResult(room, 7)).toBe(true);
  });

  it("rejects stale versions and rooms that have moved on", () => {
    expect(isCurrentWorkflowResult(room, 6)).toBe(false);
    expect(isCurrentWorkflowResult({ ...room, stage: "collecting" }, 7)).toBe(false);
    expect(isCurrentWorkflowResult({ ...room, stage: "voting" }, 7)).toBe(false);
  });
});
