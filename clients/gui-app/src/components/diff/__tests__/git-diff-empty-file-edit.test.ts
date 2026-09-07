import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  File,
  FileDiff,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";

/** Unlike the workspace case, `<FileDiff>`/`Editor` also never *attaches* for this input (proven below). */
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
