import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  File,
  FileDiff,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";

/**
 * Real, unmocked `@pierre/diffs@1.3.1` proof for the empty-origin activation
 * affordance's Git-diff generalization.
 *
 * An empty untracked file's diff has zero hunks (nothing to show for an
 * empty new file), so `<FileDiff>` in read mode paints no clickable
 * line/token, matching the same `splitFileContents`-driven gap
 * `workspace-empty-file-edit.test.ts` proves for the workspace-file source
 * surface. Unlike the workspace case, `<FileDiff>`/`Editor` also never
 * *attaches* for this input (proven below) - the library's render-sync
 * completion logic looks for a `codeElement`/`contentEl` in the DOM and
 * silently gives up when a zero-hunk diff renders neither, permanently
 * stranding the editor. `DiffContentPrimitive` therefore renders a plain
 * `<File>` instead of `<FileDiff>` once editing starts for a confirmed-empty
 * file (see `emptyFileEditSession` in `diff-content-primitive.tsx`) - there
 * is genuinely nothing to diff for a brand-new empty file anyway. This suite
 * proves both halves: `FileDiff` cannot attach for this input, and `File`
 * can, using the exact `FileContents` shape `DiffContentPrimitive` passes as
 * `emptyFileEditSession.newFile`.
 */
// Both patches are restored in `afterAll`: an unrestored `window.postMessage`
// override leaks into every other test file Vitest schedules onto the same
// worker for the rest of the run (React's scheduler falls back to
// `postMessage` for task scheduling in jsdom, so a forced-origin wrapper left
// in place silently corrupts an unrelated test's retry/scheduling timing -
// see `workspace-empty-file-edit.test.ts` for the incident this traced back
// to).
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

describe("empty untracked Git-diff editor attach (real @pierre/diffs library)", () => {
  it("parses the host's empty-untracked patch as the confirmed zero-hunk new-file shape", () => {
    const parsed = parsePatchFiles(
      `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 000000000..e69de29bb
`,
      "empty-untracked-host-patch",
    );
    const fileDiff = parsed[0]?.files[0];

    expect(fileDiff.type).toBe("new");
    expect(fileDiff.hunks).toHaveLength(0);
    expect(fileDiff.additionLines).toHaveLength(0);
    expect(fileDiff.deletionLines).toHaveLength(0);
  });

  it("parseDiffFromFile(null, empty newFile) produces a full, non-partial diff", () => {
    const fileDiff = parseDiffFromFile(null, {
      name: "empty.txt",
      contents: "",
    });
    expect(fileDiff.isPartial).toBe(false);
    expect(fileDiff.type).toBe("new");
  });

  it("does NOT attach an editor via FileDiff for an empty new-file diff - the reason DiffContentPrimitive renders File instead", async () => {
    const fileDiff = parseDiffFromFile(null, {
      name: "empty-filediff-attach.txt",
      contents: "",
    });
    const instance = new FileDiff({}, undefined, true);
    instance.hydrate({ fileDiff, fileContainer: makeContainer() });

    const editor = new Editor<undefined>({});
    const detach = editor.edit(instance);
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    }).toThrow("Editor is not attached");

    detach();
  });

  it("attaches a real, edit-accepting editor via File for an empty new-file diff", async () => {
    const instance = new File({}, undefined, true);
    instance.hydrate({
      file: { name: "empty-file-attach.txt", contents: "" },
      fileContainer: makeContainer(),
    });

    const editor = new Editor<undefined>({});
    const detach = editor.edit(instance);
    await new Promise((resolve) => setTimeout(resolve, 50));

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

  it("typing the first character into a previously-empty untracked file reports the new content through onChange", async () => {
    const changes: string[] = [];
    const instance = new File({}, undefined, true);
    instance.hydrate({
      file: { name: "empty-file-typing.txt", contents: "" },
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
