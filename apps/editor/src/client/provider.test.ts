import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { restorePendingUpdates } from "./provider";

describe("pending collaborative updates", () => {
  it("restores queued local updates into a fresh document before reconnect", () => {
    const edited = new Y.Doc();
    edited.getText("draft").insert(0, "offline work");
    const update = Y.encodeStateAsUpdate(edited);
    const fresh = new Y.Doc();

    restorePendingUpdates(fresh, [{ id: crypto.randomUUID(), update: toBase64(update) }], "pending-recovery");

    expect(fresh.getText("draft").toString()).toBe("offline work");
  });
});

function toBase64(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}
