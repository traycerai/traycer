import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";

/**
 * Real, unmocked `@pierre/diffs@1.3.1` proof for RESUME9's root cause: a
 * real certification E2E session activated an empty workspace file, typed a
 * second line, then the file's content reverted back toward empty (a
 * pointer-activation sub-test's draft getting discarded before a
 * keyboard-activation sub-test reused the same file identity) - and the
 * library threw inside its own `FileRenderer.processFileResult` ("Line
 * doesnt exist {lineIndex: 1, lineNumber: 2}"), reported from
 * `FileRenderer.renderFile -> File.renderPreparedFile -> File.render`.
 *
 * Root cause, confirmed against the real library's source
 * (`FileRenderer.isLineCacheForFile`, `getOrCreateLineCache`,
 * `getLineCount`): "Explicit keys may share cached lines across equivalent
 * file objects" - once a `file.cacheKey` is set, `getOrCreateLineCache`
 * skips comparing `contents` entirely and keeps returning whatever
 * line-split it cached the FIRST time that cacheKey was seen, for as long as
 * the underlying `FileRenderer` lives. `getLineCount` falls back to that
 * same stale cache whenever the `file` object it's asked about isn't already
 * registered in the editor's own live-document cache (`textDocumentCache`,
 * keyed by object identity - never true for a freshly-built `file` object
 * once the editor has detached, since nothing re-registers it).
 *
 * `WorkspaceFileRenderer` used to build `<File file={...}>` from a `useMemo`
 * keyed on the LIVE `content` prop but a STABLE identity-based `cacheKey`
 * (constant for the whole file's lifetime, not content-versioned) - exactly
 * the pattern the library's own contract warns against. This suite proves
 * that pattern is genuinely unsafe directly against the real
 * `File`/`FileRenderer` pair (grow to two lines under a cacheKey, then
 * render fewer lines under that SAME cacheKey once the editor is no longer
 * attached to correct the incoming snapshot) - the reason
 * `WorkspaceFileRenderer` no longer sets `file.cacheKey` at all (see
 * `workspace-file-empty-multiline-console-regression.test.tsx` for the fix
 * proved at the component level).
 */
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

      // First content this previously-empty file ever gets spans two lines -
      // the exact "0 lines -> multiple lines" jump the E2E session hit.
      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "line one\nline two",
        },
      ]);
      // Mirrors the OLD (pre-fix) `WorkspaceFileRenderer`'s controlled
      // re-render: a BRAND NEW `file` object echoing what the editor just
      // reported, under the SAME stable `cacheKey`.
      instance.render({
        file: {
          name: "empty.txt",
          contents: "line one\nline two",
          cacheKey: CACHE_KEY,
        },
      });
      detach();

      // The draft gets discarded back to the disk baseline (empty) once the
      // editor is no longer attached to correct the incoming snapshot -
      // matching a pointer-activation sub-test's unsaved draft being reset
      // before a keyboard-activation sub-test reuses the same identity.
      instance.render({
        file: { name: "empty.txt", contents: "", cacheKey: CACHE_KEY },
      });
      // The library schedules some of its own render/tokenize passes rather
      // than always completing them synchronously - give any of those a
      // chance to run and surface the error before asserting.
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
