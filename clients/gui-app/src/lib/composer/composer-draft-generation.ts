/**
 * A counter per editor, bumped whenever the draft is replaced wholesale -
 * submit's `clearContent`, or a programmatic `setContent`.
 *
 * Async work started against a draft (today: the cross-host browser-tab
 * screenshot, which lands well after the pick) must not write into whatever
 * draft happens to be in the editor when it resolves. `editor.isDestroyed` is
 * not enough: the editor survives a send, so a capture in flight at submit
 * time would drop its image into the NEXT, empty message. Read the generation
 * when the work starts, compare before writing, and drop the write if it moved.
 *
 * A `WeakMap` so an unmounted editor's entry goes away with it.
 */
import type { Editor } from "@tiptap/core";

const generations = new WeakMap<Editor, number>();

export function composerDraftGeneration(editor: Editor): number {
  return generations.get(editor) ?? 0;
}

export function bumpComposerDraftGeneration(editor: Editor): void {
  generations.set(editor, composerDraftGeneration(editor) + 1);
}
