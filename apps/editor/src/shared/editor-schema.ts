import { getSchema, type JSONContent } from "@tiptap/core";
import UniqueID, { generateUniqueIds } from "@tiptap/extension-unique-id";
import StarterKit from "@tiptap/starter-kit";

export const blockTypes = ["paragraph", "heading"];

export const starterKit = StarterKit.configure({ undoRedo: false });
export const uniqueId = UniqueID.configure({
  attributeName: "blockId",
  types: ["paragraph", "heading"],
});
export const editorExtensions = [starterKit, uniqueId];
export const editorSchema = getSchema(editorExtensions);

export function withBlockIds(content: JSONContent): JSONContent {
  return generateUniqueIds(content, editorExtensions);
}

export function templateContent(template: "blank" | "product-spec" | "proposal"): JSONContent {
  if (template === "product-spec") {
    return withBlockIds({
      type: "doc",
      content: [
        heading("Problem", 2),
        paragraph("What problem are we solving, and for whom?"),
        heading("Goals", 2),
        bullet("Describe the outcome this work should achieve."),
        heading("Proposed approach", 2),
        paragraph("Explain the approach, key decisions, and tradeoffs."),
        heading("Open questions", 2),
        bullet("List what the team still needs to decide."),
      ],
    });
  }
  if (template === "proposal") {
    return withBlockIds({
      type: "doc",
      content: [
        heading("Summary", 2),
        paragraph("State the proposal and why it matters."),
        heading("Context", 2),
        paragraph("Describe the current situation and constraints."),
        heading("Recommendation", 2),
        paragraph("Describe what should happen next."),
      ],
    });
  }
  return withBlockIds({ type: "doc", content: [paragraph("")] });
}

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: text ? [{ type: "text", text }] : undefined };
}

function heading(text: string, level: number): JSONContent {
  return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}

function bullet(text: string): JSONContent {
  return {
    type: "bulletList",
    content: [{ type: "listItem", content: [paragraph(text)] }],
  };
}
