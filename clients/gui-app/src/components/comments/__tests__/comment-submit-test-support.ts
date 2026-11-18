import { act } from "@testing-library/react";
import { Editor } from "@tiptap/core";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A promise the test settles by hand. Holding a submission open is how these
 * suites stand in for "the host has not answered yet", which is the window the
 * duplicate submit lives in.
 */
export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/**
 * Tiptap leaves the live editor on the ProseMirror root as `dom.editor`, which
 * is how a test reaches the composer's real editor without the component
 * exposing one just for tests.
 */
export function composerEditors(): ReadonlyArray<Editor> {
  const roots = document.querySelectorAll(
    '[data-slot="comment-composer-editor"]',
  );
  return Array.from(roots).map((root) => {
    if ("editor" in root && root.editor instanceof Editor) return root.editor;
    throw new Error("comment composer root carries no Tiptap editor");
  });
}

export function composerEditorAt(index: number): Editor {
  const editor = composerEditors().at(index);
  if (editor === undefined) {
    throw new Error(`no comment composer editor at index ${String(index)}`);
  }
  return editor;
}

export function typeIntoEditor(editor: Editor, text: string): void {
  act(() => {
    editor.commands.insertContent(text);
  });
}

/** Lets promise continuations and the React updates they trigger settle. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
