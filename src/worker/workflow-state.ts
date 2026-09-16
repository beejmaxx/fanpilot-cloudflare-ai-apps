import type { Room } from "../shared/types";

export function isCurrentWorkflowResult(
  room: Pick<Room, "stateVersion" | "stage">,
  sourceStateVersion: number,
): boolean {
  return room.stateVersion === sourceStateVersion && room.stage === "generating";
}
