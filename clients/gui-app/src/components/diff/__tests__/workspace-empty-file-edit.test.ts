import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";

/**
 * Real, unmocked `@pierre/diffs@1.3.1` proof for the empty-workspace-file
 * activation affordance's core assumption: `splitFileContents` (the
 * library's own line-splitting helper) returns zero lines for an empty
 * string, so `<File>` in read mode paints no clickable line/token at all -
 * the entire click-to-edit path in `use-diff-click-to-edit.ts` is gated on
 * the library's own `onLineClick`/`onTokenClick` callbacks, which can never
 * fire without a rendered line. `EmptyFileEditAffordance` sidesteps that by
 * calling the adapter's shared `activateEmptyOrigin`, which only flips
 * `edit` to `true` - it does not (and structurally cannot) special-case
 * empty content itself. This suite proves that flip is sufficient: once
 * `edit` is true, `File`/`Editor` attach and accept edits against an empty
 * file exactly as they would for any other file, with no separate
 * empty-content code path needed anywhere in the library boundary.
 */

// jsdom has no canvas engine; @pierre/diffs' Editor needs a working 2D
// context for text metrics, and its tokenizer schedules work through a
// single-argument `window.postMessage` call that jsdom's stricter (2-arg)
// implementation rejects. Real browsers always have both - these shims only
// close jsdom-specific gaps so the real attach/edit code path can run.
//
// Both patches are restored in `afterAll`: an unrestored `window.postMessage`
// override leaks into every other test file Vitest schedules onto the same
// worker for the rest of the run (React's scheduler falls back to
// `postMessage` for task scheduling in jsdom, so a forced-origin wrapper left
// in place silently corrupted an unrelated notifications hook test's retry
// timing until this was traced down).
// Captured as a descriptor (not a direct `.getContext` value reference) so
// restoring it later never reads as an unbound method extraction.
const originalGetContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
let originalPostMessage: typeof window.postMessage;
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    }),
  });
  originalPostMessage = window.postMessage.bind(window);
  const realPostMessage = originalPostMessage;
  window.postMessage = ((message: unknown) =>
    realPostMessage(message, "*")) as typeof window.postMessage;
});

afterAll(() => {
  if (originalGetContextDescriptor !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContextDescriptor,
    );
  }
  window.postMessage = originalPostMessage;
});

function makeContainer(): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("empty-file editor attach (real @pierre/diffs library)", () => {
  it("attaches a real, edit-accepting editor for a fully empty file", async () => {
    const instance = new File({}, undefined, true);
    instance.hydrate({
      file: { name: "empty.txt", contents: "" },
      fileContainer: makeContainer(),
    });

    const editor = new Editor<undefined>({});
    const detach = editor.edit(instance);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Attach succeeded: the editor accepts an edit at the origin caret
    // instead of throwing "Editor is not attached".
    expect(() => {
      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "X",
        },
      ]);
    }).not.toThrow();

    detach();
  });

  it("typing the first character into a previously-empty file reports the new content through onChange", async () => {
    const changes: string[] = [];
    const instance = new File({}, undefined, true);
    instance.hydrate({
      file: { name: "empty.txt", contents: "" },
      fileContainer: makeContainer(),
    });

    const editor = new Editor<undefined>({
      onChange: (changedFile) => {
        changes.push(changedFile.contents);
      },
    });
    const detach = editor.edit(instance);
    await new Promise((resolve) => setTimeout(resolve, 50));

    editor.applyEdits([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        newText: "X",
      },
    ]);

    expect(changes).toContain("X");
    detach();
  });
});
