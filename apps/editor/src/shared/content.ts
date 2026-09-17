import type { JSONContent } from "@tiptap/core";

export interface ContentBlock {
  id: string;
  type: string;
  text: string;
  json: JSONContent;
}

export function contentBlocks(doc: JSONContent): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  walk(doc, blocks);
  return blocks;
}

function walk(node: JSONContent, blocks: ContentBlock[]): void {
  const blockId = typeof node.attrs?.blockId === "string" ? node.attrs.blockId : null;
  if (blockId && (node.type === "paragraph" || node.type === "heading" || node.type === "listItem")) {
    blocks.push({ id: blockId, type: node.type, text: textOf(node), json: node });
  }
  node.content?.forEach((child) => walk(child, blocks));
}

export function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return node.content?.map(textOf).join("") ?? "";
}

export function plainText(doc: JSONContent): string {
  return contentBlocks(doc).map((block) => block.text).filter(Boolean).join("\n\n");
}

export function markdownText(doc: JSONContent): string {
  const lines: string[] = [];
  for (const node of doc.content ?? []) {
    if (node.type === "heading") {
      lines.push(`${"#".repeat(Number(node.attrs?.level ?? 2))} ${textOf(node)}`);
    } else if (node.type === "bulletList" || node.type === "orderedList") {
      (node.content ?? []).forEach((item, index) => lines.push(`${node.type === "bulletList" ? "-" : `${index + 1}.`} ${textOf(item)}`));
    } else {
      lines.push(textOf(node));
    }
  }
  return lines.filter(Boolean).join("\n\n");
}
