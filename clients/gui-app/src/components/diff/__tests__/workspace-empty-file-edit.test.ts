import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";

/** `EmptyFileEditAffordance` sidesteps that by calling the adapter's shared `activateEmptyOrigin`, which only
 * flips `edit` to `true` - it does not (and structurally cannot) special-case empty content itself. */

// Captured as a descriptor (not a direct `.getContext` value reference) so restoring it later never reads as
// an unbound method extraction.
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
