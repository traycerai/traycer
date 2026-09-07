import type { Editor } from "@tiptap/core";

/**
 * Seeds ONLY when the editor is empty - the caller gates this behind the one-shot create-focus token, which is set exclusively by the manual "+" create flow on the creating client, so no collaborator ever races in a second heading.
 */
export function seedArtifactTitleHeading(editor: Editor): boolean {
  if (!editor.isEmpty) return false;
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "heading", attrs: { level: 1 } }, { type: "paragraph" }],
  });
  return true;
}
