/**
 * A counter per editor, bumped whenever the draft is replaced wholesale - submit's `clearContent`, or a programmatic `setContent`.
 */
import type { Editor } from "@tiptap/core";

const generations = new WeakMap<Editor, number>();

export function composerDraftGeneration(editor: Editor): number {
  return generations.get(editor) ?? 0;
}

export function bumpComposerDraftGeneration(editor: Editor): void {
  generations.set(editor, composerDraftGeneration(editor) + 1);
}
