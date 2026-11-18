import type { Editor } from "@tiptap/core";

/**
 * Notion-style title line: seed a fresh hand-created artifact's body with an
 * empty level-1 heading (the title) followed by an empty paragraph (the
 * body), so the doc opens on a title the user types into and the tab title
 * follows via `useArtifactDocTitleFollow`.
 *
 * Seeds ONLY when the editor is empty - the caller gates this behind the
 * one-shot create-focus token, which is set exclusively by the manual "+"
 * create flow on the creating client, so no collaborator ever races in a
 * second heading. Returns whether it seeded, so the caller can decide where
 * to drop the caret.
 *
 * `setContent` (not `insertContent`) because the empty doc is a single empty
 * paragraph we want to replace wholesale; it emits an update so the new nodes
 * sync into the Y.Doc body fragment like any other edit.
 */
export function seedArtifactTitleHeading(editor: Editor): boolean {
  if (!editor.isEmpty) return false;
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "heading", attrs: { level: 1 } }, { type: "paragraph" }],
  });
  return true;
}
