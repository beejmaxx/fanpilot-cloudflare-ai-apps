import { EditorState } from "@tiptap/pm/state";
import { Fragment, type Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import * as Y from "yjs";
import {
  initProseMirrorDoc,
  prosemirrorJSONToYDoc,
  updateYFragment,
  yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";
import { contentBlocks, markdownText, plainText } from "../shared/content";
import { editorSchema, templateContent } from "../shared/editor-schema";

export const CONTENT_FRAGMENT = "content";

export function createDocument(template: "blank" | "product-spec" | "proposal"): Y.Doc {
  return prosemirrorJSONToYDoc(editorSchema, templateContent(template), CONTENT_FRAGMENT);
}

export function documentJson(document: Y.Doc): JSONContent {
  return yXmlFragmentToProsemirrorJSON(document.getXmlFragment(CONTENT_FRAGMENT)) as JSONContent;
}

export function documentText(document: Y.Doc): string {
  return plainText(documentJson(document));
}

export function documentMarkdown(document: Y.Doc): string {
  return markdownText(documentJson(document));
}

export function blocks(document: Y.Doc) {
  return contentBlocks(documentJson(document));
}

export function richContentFingerprint(content: JSONContent): string {
  return textFingerprint(stableJson(content));
}

export function validateDocument(document: Y.Doc, limits: { maxCharacters: number; maxStateBytes: number }): void {
  const roots = [...document.share.keys()];
  if (roots.length !== 1 || roots[0] !== CONTENT_FRAGMENT) throw new Error("Document update contains an unsupported shared root");
  const json = documentJson(document);
  editorSchema.nodeFromJSON(json);
  const seen = new Set<string>();
  let blockCount = 0;
  walkJson(json, (node) => {
    if (node.type !== "paragraph" && node.type !== "heading") return;
    blockCount += 1;
    const id = node.attrs?.blockId;
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || seen.has(id)) {
      throw new Error("Every text block must have a unique ID");
    }
    seen.add(id);
  });
  if (!blockCount) throw new Error("Document must contain at least one text block");
  if (documentText(document).length > limits.maxCharacters) throw new Error("Document character limit reached");
  if (Y.encodeStateAsUpdate(document).byteLength > limits.maxStateBytes) throw new Error("Document storage limit reached");
}

export function replaceBlockText(document: Y.Doc, blockId: string, replacement: string, origin: unknown): boolean {
  const fragment = document.getXmlFragment(CONTENT_FRAGMENT);
  const { doc, meta } = initProseMirrorDoc(fragment, editorSchema);
  let targetPos = -1;
  let targetNode: ProseMirrorNode | null = null;
  doc.descendants((node, pos) => {
    if (node.attrs.blockId === blockId) {
      targetPos = pos;
      targetNode = node;
      return false;
    }
    return true;
  });
  if (!targetNode || targetPos < 0) return false;
  const node = targetNode as ProseMirrorNode;
  const replacementNode = node.type.create(node.attrs, replacement ? markedReplacement(node, replacement) : undefined, node.marks);
  const state = EditorState.create({ schema: editorSchema, doc });
  const next = state.tr.replaceWith(targetPos, targetPos + node.nodeSize, replacementNode).doc;
  document.transact(() => updateYFragment(document, fragment, next, meta), origin);
  return true;
}

function markedReplacement(node: ProseMirrorNode, replacement: string): Fragment {
  const oldTokens: Array<{ value: string; marks: readonly Mark[] }> = [];
  node.descendants((child) => {
    if (!child.isText || !child.text) return true;
    tokenize(child.text).forEach((value) => oldTokens.push({ value, marks: child.marks }));
    return false;
  });
  let oldCursor = 0;
  let hasMappedToken = false;
  const children = tokenize(replacement).map((value) => {
    let match = -1;
    if (/^\s+$/u.test(value)) {
      if (hasMappedToken && oldTokens[oldCursor]?.value === value) match = oldCursor;
    } else {
      for (let index = oldCursor; index < oldTokens.length; index += 1) {
        if (tokenKey(oldTokens[index].value) === tokenKey(value)) { match = index; break; }
      }
    }
    const marks = match >= 0 ? oldTokens[match].marks : [];
    if (match >= 0) {
      oldCursor = match + 1;
      if (!/^\s+$/u.test(value)) hasMappedToken = true;
    }
    return editorSchema.text(value, marks);
  });
  return Fragment.fromArray(children);
}

function tokenize(value: string): string[] {
  return value.match(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*|\p{N}+(?:[.,]\p{N}+)*|[^\s]|\s+/gu) ?? [];
}

function tokenKey(value: string): string {
  return /^[\p{L}\p{M}]/u.test(value) ? value.toLocaleLowerCase() : value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function walkJson(node: JSONContent, visit: (node: JSONContent) => void): void {
  visit(node);
  node.content?.forEach((child) => walkJson(child, visit));
}

export function textFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
