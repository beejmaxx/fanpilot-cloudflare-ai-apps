import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { editorSchema, withBlockIds } from "../shared/editor-schema";
import { blocks, CONTENT_FRAGMENT, createDocument, documentJson, replaceBlockText, richContentFingerprint, textFingerprint, validateDocument } from "./y-document";

describe("collaborative document model", () => {
  it("creates stable IDs and survives binary persistence", () => {
    const original = createDocument("product-spec");
    const before = blocks(original);
    expect(before.length).toBeGreaterThan(4);
    expect(new Set(before.map((block) => block.id)).size).toBe(before.length);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(original));
    expect(documentJson(restored)).toEqual(documentJson(original));
  });

  it("converges independent client updates", () => {
    const canonical = createDocument("blank");
    const alice = clone(canonical);
    const bob = clone(canonical);
    alice.getMap("test").set("alice", "one");
    bob.getMap("test").set("bob", "two");
    Y.applyUpdate(canonical, Y.encodeStateAsUpdate(alice, Y.encodeStateVector(canonical)));
    Y.applyUpdate(canonical, Y.encodeStateAsUpdate(bob, Y.encodeStateVector(canonical)));
    const final = Y.encodeStateAsUpdate(canonical);
    Y.applyUpdate(alice, final);
    Y.applyUpdate(bob, final);
    expect(alice.getMap("test").toJSON()).toEqual({ alice: "one", bob: "two" });
    expect(Y.encodeStateVector(alice)).toEqual(Y.encodeStateVector(bob));
  });

  it("replaces one block through the existing Yjs fragment", () => {
    const document = createDocument("proposal");
    const original = blocks(document);
    const target = original[1];
    const untouched = original[3];
    const stateBefore = Y.encodeStateVector(document);

    expect(replaceBlockText(document, target.id, "A clearer summary.", { kind: "test" })).toBe(true);
    const after = blocks(document);
    expect(after.find((block) => block.id === target.id)?.text).toBe("A clearer summary.");
    expect(after.find((block) => block.id === untouched.id)?.text).toBe(untouched.text);
    expect(Y.encodeStateAsUpdate(document, stateBefore).length).toBeGreaterThan(0);
  });

  it("detects stale target text", () => {
    expect(textFingerprint("first version")).not.toBe(textFingerprint("second version"));
    expect(textFingerprint("same")).toBe(textFingerprint("same"));
  });

  it("fingerprints rich content and detects formatting-only changes", () => {
    const content = withBlockIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Important words" }] }] });
    const plain = content.content![0];
    const bold = { ...plain, content: [{ type: "text", text: "Important words", marks: [{ type: "bold" }] }] };
    expect(richContentFingerprint(plain)).not.toBe(richContentFingerprint(bold));
  });

  it("preserves marks on unchanged words during a targeted rewrite", () => {
    const content = withBlockIds({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "Ship ", marks: [{ type: "bold" }] },
          { type: "text", text: "the proposal today." },
        ],
      }],
    });
    const document = prosemirrorJSONToYDoc(editorSchema, content, CONTENT_FRAGMENT);
    const target = blocks(document)[0];
    expect(replaceBlockText(document, target.id, "Clearly ship the proposal today.", { kind: "test" })).toBe(true);
    const rewritten = blocks(document)[0].json;
    const markedText = (rewritten.content ?? []).filter((node) => node.marks?.some((mark) => mark.type === "bold")).map((node) => node.text).join("");
    expect(markedText.toLowerCase()).toContain("ship");
    expect(blocks(document)[0].text).toBe("Clearly ship the proposal today.");
  });

  it("rejects unsupported shared roots", () => {
    const document = createDocument("blank");
    document.getMap("unexpected").set("payload", "not editor content");
    expect(() => validateDocument(document, { maxCharacters: 20_000, maxStateBytes: 2_000_000 })).toThrow("unsupported shared root");
  });
});

function clone(document: Y.Doc): Y.Doc {
  const result = new Y.Doc();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(document));
  return result;
}
