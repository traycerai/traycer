import { describe, it, expect, beforeAll } from "vitest";
import { FileDiff, parsePatchFiles } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";

/**
 * Documents (against the real, unmocked @pierre/diffs@1.3.1 library) the
 * exact contract our diff-editing integration depends on:
 *
 * `parsePatchFiles()` always returns a `FileDiffMetadata` marked
 * `isPartial: true`. `@pierre/diffs` only attempts to hydrate a partial diff
 * once, at the moment an editor first attaches (`FileDiff.attachEditor` ->
 * `loadFilesIfNecessary`), and only for `change`/`rename-changed`/
 * `rename-pure` types. Handing it a *different* partial `FileDiffMetadata`
 * object for the same file afterward - which is exactly what re-parsing the
 * same patch produces - is "treated as a new partial render model" per the
 * library's own `FileDiffMetadata.isPartial` docs: the replacement never
 * gets a hydration attempt and stays partial forever.
 *
 * This is the mechanism behind the Diffs "click token to edit" bug: the
 * editor's content element only gets `contentEditable`/`role=textbox` set
 * inside `Editor.__syncRenderView`, which itself refuses to run against a
 * partial diff - so a stranded partial diff means the editor never attaches
 * a real editable surface, silently (no thrown render error, no page
 * error - `attachEditor`'s fire-and-forget hydration promise just never
 * resolves against the object anything still references).
 *
 * `DiffContentPrimitive` (see `hydrateFileDiffForEdit` in
 * diff-content-primitive.tsx) avoids this entirely by hydrating synchronously
 * before `edit` ever flips true, so `@pierre/diffs` never sees a partial
 * diff during an edit session.
 */

// jsdom has no canvas engine; @pierre/diffs' Editor needs a working 2D
// context for text metrics, and its tokenizer schedules work through a
// single-argument `window.postMessage` call that jsdom's stricter (2-arg)
// implementation rejects. Real browsers always have both - these shims only
// close jsdom-specific gaps so the real attach/edit code path can run. A fake
// 2D context can't structurally satisfy `CanvasRenderingContext2D`, so this
// replaces the descriptor directly rather than casting through it.
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    }),
  });
  const realPostMessage = window.postMessage.bind(window);
  window.postMessage = ((message: unknown) =>
    realPostMessage(message, "*")) as typeof window.postMessage;
});

const CHANGE_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 context before
-old line
+new line
 context after
`;

const NEW_FILE_PATCH = `diff --git a/src/fresh.ts b/src/fresh.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/fresh.ts
@@ -0,0 +1,2 @@
+first line
+second line
`;

function makeContainer(): HTMLDivElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("@pierre/diffs partial-diff hydration contract (real, unmocked library)", () => {
  it("baseline: a single stable partial diff hydrates via loadDiffFiles and edits apply cleanly", async () => {
    const parsed = parsePatchFiles(CHANGE_PATCH, "control-key");
    const fileDiff = parsed.flatMap((group) => group.files)[0];
    expect(fileDiff.isPartial).toBe(true);

    const instance = new FileDiff({}, undefined, true);
    instance.hydrate({ fileDiff, fileContainer: makeContainer() });
    instance.setOptions({
      ...instance.options,
      loadDiffFiles: () =>
        Promise.resolve({
          oldFile: {
            name: "src/app.ts",
            contents: "context before\nold line\ncontext after\n",
          },
          newFile: {
            name: "src/app.ts",
            contents: "context before\nnew line\ncontext after\n",
          },
        }),
    });

    const editor = new Editor<undefined>({});
    const detach = editor.edit(instance);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fileDiff.isPartial).toBe(false);
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

  it("a fresh partial object for the same file, swapped in before hydration resolves, permanently strands the editor without ever attaching", async () => {
    const liveFileDiff = parsePatchFiles(CHANGE_PATCH, "swap-key-live").flatMap(
      (group) => group.files,
    )[0];
    const pinnedFileDiff = parsePatchFiles(
      CHANGE_PATCH,
      "swap-key-pinned",
    ).flatMap((group) => group.files)[0];
    expect(liveFileDiff).not.toBe(pinnedFileDiff);

    const instance = new FileDiff({}, undefined, true);
    instance.hydrate({
      fileDiff: liveFileDiff,
      fileContainer: makeContainer(),
    });
    instance.setOptions({
      ...instance.options,
      loadDiffFiles: () =>
        Promise.resolve({
          oldFile: {
            name: "src/app.ts",
            contents: "context before\nold line\ncontext after\n",
          },
          newFile: {
            name: "src/app.ts",
            contents: "context before\nnew line\ncontext after\n",
          },
        }),
    });

    const editor = new Editor<undefined>({});
    const detach = editor.edit(instance);
    // Mirrors DiffContentPrimitive re-rendering with a *different* fileDiff
    // object in the same tick `edit` flips true - e.g. `displayedGitDiff()`
    // switching `props.patch` from the live query diff to the pinned diff,
    // which invalidates the parse memo and produces a brand-new object.
    instance.render({ fileDiff: pinnedFileDiff, forceRender: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(liveFileDiff.isPartial).toBe(true);
    expect(pinnedFileDiff.isPartial).toBe(true);
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

  it("a fresh partial object swapped in *after* a successful attach breaks every later edit with the literal render-cache error", async () => {
    const firstFileDiff = parsePatchFiles(
      CHANGE_PATCH,
      "post-attach-key-1",
    ).flatMap((group) => group.files)[0];

    const instance = new FileDiff({}, undefined, true);
    instance.hydrate({
      fileDiff: firstFileDiff,
      fileContainer: makeContainer(),
    });
    instance.setOptions({
      ...instance.options,
      loadDiffFiles: () =>
        Promise.resolve({
          oldFile: {
            name: "src/app.ts",
            contents: "context before\nold line\ncontext after\n",
          },
          newFile: {
            name: "src/app.ts",
            contents: "context before\nnew line\ncontext after\n",
          },
        }),
    });

    const editor = new Editor<undefined>({});
    const detach = editor.edit(instance);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstFileDiff.isPartial).toBe(false);

    // The editor genuinely attached and a first edit applies cleanly.
    expect(() => {
      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "A",
        },
      ]);
    }).not.toThrow();

    // A *later* re-render hands the instance a brand-new fileDiff object for
    // the same file - e.g. DiffContentPrimitive's parse memo recomputing.
    const secondFileDiff = parsePatchFiles(
      CHANGE_PATCH,
      "post-attach-key-2",
    ).flatMap((group) => group.files)[0];
    expect(secondFileDiff.isPartial).toBe(true);
    instance.render({ fileDiff: secondFileDiff, forceRender: true });

    expect(() => {
      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "B",
        },
      ]);
    }).toThrow("Could not update render cache for partial diff");

    detach();
  });

  it("an untracked/new file's diff is never hydrated at all - loadDiffFiles is never called and the editor never attaches", async () => {
    const fileDiff = parsePatchFiles(NEW_FILE_PATCH, "new-file-key").flatMap(
      (group) => group.files,
    )[0];
    expect(fileDiff.type).toBe("new");
    expect(fileDiff.isPartial).toBe(true);

    const instance = new FileDiff({}, undefined, true);
    instance.hydrate({ fileDiff, fileContainer: makeContainer() });
    let loadDiffFilesCalled = false;
    instance.setOptions({
      ...instance.options,
      loadDiffFiles: () => {
        loadDiffFilesCalled = true;
        return Promise.resolve({
          oldFile: null,
          newFile: {
            name: "src/fresh.ts",
            contents: "first line\nsecond line\n",
          },
        });
      },
    });

    const editor = new Editor<undefined>({});
    const detach = editor.edit(instance);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loadDiffFilesCalled).toBe(false);
    expect(fileDiff.isPartial).toBe(true);
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
});
