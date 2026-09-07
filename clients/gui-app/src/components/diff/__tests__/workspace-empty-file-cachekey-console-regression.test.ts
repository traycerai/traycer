import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";

/** `getLineCount` falls back to that same stale cache whenever the `file` object it's asked about isn't already
 * registered in the editor's own live-document cache (`textDocumentCache`, keyed by object identity. */
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

describe("@pierre/diffs cacheKey contract: a stable cacheKey across shrinking content throws (RESUME9 root cause)", () => {
  it("throws FileRenderer.processFileResult's 'Line doesnt exist' when content shrinks under a SAME cacheKey with no editor attached", async () => {
    const consoleErrors: unknown[][] = [];
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });

    try {
      const CACHE_KEY = "workspace-file-identity-key";
      const instance = new File({}, undefined, true);
      instance.hydrate({
        file: { name: "empty.txt", contents: "", cacheKey: CACHE_KEY },
        fileContainer: makeContainer(),
      });

      const editor = new Editor<undefined>({});
      const detach = editor.edit(instance);
      await new Promise((resolve) => setTimeout(resolve, 50));

      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "line one\nline two",
        },
      ]);
      // Mirrors the old (pre-fix) `WorkspaceFileRenderer`'s controlled re-render: a brand new `file` object echoing
      // what the editor just reported, under the same stable `cacheKey`.
      instance.render({
        file: {
          name: "empty.txt",
          contents: "line one\nline two",
          cacheKey: CACHE_KEY,
        },
      });
      detach();

      // The draft gets discarded back to the disk baseline (empty) once the editor is no longer attached to correct
      // the incoming snapshot.
      instance.render({
        file: { name: "empty.txt", contents: "", cacheKey: CACHE_KEY },
      });
      // The library schedules some of its own render/tokenize passes rather than always completing them
      // synchronously - give any of those a chance to run and surface the error before asserting.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      consoleErrorSpy.mockRestore();
    }

    expect(consoleErrors).toHaveLength(2);
    expect(consoleErrors[0]?.[0]).toBe(
      "FileRenderer.processFileResult: Line doesnt exist",
    );
    expect(consoleErrors[0]?.[1]).toMatchObject({
      name: "empty.txt",
      lineIndex: 1,
      lineNumber: 2,
    });
  });
});
