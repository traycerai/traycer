/**
 * Independent regression coverage for the click-to-edit partial-diff attach fix.
 *
 * Unlike `diff-content-primitive.test.tsx` (which mocks `@pierre/diffs`) and
 * unlike `pierre-diffs-partial-diff-hydration.test.ts` (library-only, no React),
 * this suite mounts the real production `DiffContentPrimitive` against the real
 * unmocked `@pierre/diffs@1.3.1` parse/hydrate APIs.
 *
 * The React `<FileDiff>` leaf is instrumented (not replaced with a fake parse
 * pipeline) so we can observe the `FileDiffMetadata` objects the primitive
 * actually hands the library after pre-hydration. Attach is then proven against
 * those same objects via the real `FileDiff`/`Editor` classes: jsdom never
 * paints a `[contenteditable][role=textbox]` node (the highlighter/render path
 * only emits the editor global `<style>` tag here), so attach is asserted the
 * same way the library-level suite does - `Editor.applyEdits` succeeds rather
 * than throwing "Editor is not attached" / "Could not update render cache for
 * partial diff".
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  FileDiff as FileDiffCore,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import type { ReactNode } from "react";
import { DiffContentPrimitive } from "@/components/diff/diff-content-primitive";

const capturedFileDiffs: FileDiffMetadata[] = [];

vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...actual,
    FileDiff: (props: {
      readonly fileDiff: FileDiffMetadata;
      readonly edit?: boolean;
      readonly editorOptions?: EditorOptions<undefined>;
      readonly options?: unknown;
    }): ReactNode => {
      capturedFileDiffs.push(props.fileDiff);
      return (
        <div
          data-testid="instrumented-file-diff"
          data-edit={String(props.edit === true)}
          data-is-partial={String(props.fileDiff.isPartial)}
          data-type={props.fileDiff.type}
          data-name={props.fileDiff.name}
        />
      );
    },
  };
});

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light",
    themePreset: "neutral",
  }),
}));

// Same genuine jsdom gaps the library-level suite documents: canvas 2D +
// single-arg postMessage. Real browsers provide both.
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

const RENAME_PURE_PATCH = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;

const RENAME_CHANGED_PATCH = `diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
index 1111111..2222222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
 same
-old
+new
`;

const CHANGE_OLD: FileContents = {
  name: "src/app.ts",
  contents: "context before\nold line\ncontext after\n",
};
const CHANGE_NEW: FileContents = {
  name: "src/app.ts",
  contents: "context before\nnew line\ncontext after\n",
};

const EMPTY_EDITOR_OPTIONS: EditorOptions<undefined> = {};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function applyEditError(editor: Editor<undefined>): string | null {
  try {
    editor.applyEdits([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        newText: "X",
      },
    ]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function requireCapturedFileDiff(): FileDiffMetadata {
  expect(capturedFileDiffs.length).toBeGreaterThan(0);
  const latest = capturedFileDiffs.at(-1);
  if (latest === undefined)
    throw new Error("No FileDiff metadata was captured");
  return latest;
}

/**
 * Prove the real library accepts the metadata DiffContentPrimitive produced:
 * non-partial fileDiffs attach and survive a second fully-hydrated object for
 * the same file (the live→pinned swap shape).
 */
async function assertLibraryAcceptsHydratedDiff(
  first: FileDiffMetadata,
  second: FileDiffMetadata | null,
): Promise<void> {
  expect(first.isPartial).toBe(false);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = new FileDiffCore({}, undefined, true);
  instance.hydrate({ fileDiff: first, fileContainer: container });
  const editor = new Editor<undefined>({});
  const detach = editor.edit(instance);
  await wait(50);
  expect(applyEditError(editor)).toBeNull();
  if (second !== null) {
    expect(second.isPartial).toBe(false);
    instance.render({ fileDiff: second, forceRender: true });
    expect(applyEditError(editor)).toBeNull();
  }
  detach();
  container.remove();
}

/**
 * Prove the real library never attaches for a still-partial diff - the
 * "legitimately missing required side" case: no `contentEditable` surface
 * ever attaches, and applying an edit fails the same way it does for a
 * fresh, never-hydrated diff (`pierre-diffs-partial-diff-hydration.test.ts`'s
 * untracked/new-file case).
 */
async function assertLibraryRejectsPartialDiff(
  fileDiff: FileDiffMetadata,
): Promise<void> {
  expect(fileDiff.isPartial).toBe(true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const instance = new FileDiffCore({}, undefined, true);
  instance.hydrate({ fileDiff, fileContainer: container });
  const editor = new Editor<undefined>({});
  const detach = editor.edit(instance);
  await wait(50);
  expect(applyEditError(editor)).toBe("Editor is not attached");
  detach();
  container.remove();
}

function renderPrimitive(args: {
  readonly patch: string;
  readonly cacheScope: string;
  readonly editSession:
    | {
        readonly oldFile: FileContents | null;
        readonly newFile: FileContents;
      }
    | undefined;
}): RenderResult {
  return render(
    <DiffContentPrimitive
      patch={args.patch}
      cacheScope={args.cacheScope}
      mode="unified"
      wordWrap={false}
      backgrounds
      lineNumbers
      indicatorStyle="bars"
      fileHeaders={false}
      isEmptyFile={false}
      editSession={
        args.editSession === undefined
          ? undefined
          : {
              editorOptions: EMPTY_EDITOR_OPTIONS,
              oldFile: args.editSession.oldFile,
              newFile: args.editSession.newFile,
            }
      }
    />,
  );
}

describe("<DiffContentPrimitive /> edit hydration (real @pierre/diffs)", () => {
  beforeEach(() => {
    capturedFileDiffs.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("pre-hydrates a change diff so the live→pinned parse swap still attaches", async () => {
    // Read path: partial metadata from parsePatchFiles. `useDiffsDiffHighlightReady`
    // primes its cache in an effect for this non-edit render (`enabled` is
    // true whenever there is no `editSession` yet), so the very first paint
    // can be `DiffHighlightLoading` with nothing captured yet - wait for the
    // highlight-ready transition instead of asserting synchronously.
    const live = renderPrimitive({
      patch: CHANGE_PATCH,
      cacheScope: "live-oid",
      editSession: undefined,
    });
    await waitFor(() => {
      expect(capturedFileDiffs).toHaveLength(1);
    });
    const liveDiff = requireCapturedFileDiff();
    expect(liveDiff.isPartial).toBe(true);
    expect(liveDiff.type).toBe("change");

    // Edit path: same patch body, different cacheScope (mirrors pinned vs live
    // identity / re-parse), with baseline files already loaded.
    capturedFileDiffs.length = 0;
    live.rerender(
      <DiffContentPrimitive
        patch={CHANGE_PATCH}
        cacheScope="pinned-oid"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editSession={{
          editorOptions: EMPTY_EDITOR_OPTIONS,
          oldFile: CHANGE_OLD,
          newFile: CHANGE_NEW,
        }}
      />,
    );
    expect(capturedFileDiffs).toHaveLength(1);
    const hydrated = requireCapturedFileDiff();
    expect(hydrated.isPartial).toBe(false);
    expect(hydrated.type).toBe("change");

    // A second re-parse with a third cache key + the SAME stable old/new file
    // object identities (what editableFiles preserves across keystrokes) must
    // also hand the library a non-partial model that attaches cleanly.
    const stableOld = CHANGE_OLD;
    const stableNew = CHANGE_NEW;
    capturedFileDiffs.length = 0;
    live.rerender(
      <DiffContentPrimitive
        patch={CHANGE_PATCH}
        cacheScope="pinned-oid-rerender"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editSession={{
          editorOptions: EMPTY_EDITOR_OPTIONS,
          oldFile: stableOld,
          newFile: stableNew,
        }}
      />,
    );
    const rehydrated = requireCapturedFileDiff();
    await assertLibraryAcceptsHydratedDiff(hydrated, rehydrated);
  });

  it("keeps a real non-empty change diff in FileDiff when host metadata incorrectly says zero bytes", () => {
    render(
      <DiffContentPrimitive
        patch={CHANGE_PATCH}
        cacheScope="host-zero-size-regression"
        mode="split"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        // This is the exact production boundary regression: the host used to
        // publish zero for every changed file. The parsed/hydrated diff is the
        // final authority and must keep this non-empty file in-place.
        isEmptyFile
        editSession={{
          editorOptions: EMPTY_EDITOR_OPTIONS,
          oldFile: CHANGE_OLD,
          newFile: CHANGE_NEW,
        }}
      />,
    );

    expect(capturedFileDiffs).toHaveLength(1);
    const fileDiffNode = document.querySelector(
      '[data-testid="instrumented-file-diff"]',
    );
    expect(fileDiffNode).toBeInstanceOf(HTMLElement);
    expect(fileDiffNode?.getAttribute("data-edit")).toBe("true");
    expect(requireCapturedFileDiff().type).toBe("change");
  });

  it("keeps the hydrated FileDiffMetadata identity stable when only editorOptions churn", () => {
    const oldFile = CHANGE_OLD;
    const newFile = CHANGE_NEW;
    const rendered = renderPrimitive({
      patch: CHANGE_PATCH,
      cacheScope: "stable-identity",
      editSession: { oldFile, newFile },
    });
    expect(capturedFileDiffs).toHaveLength(1);
    const first = requireCapturedFileDiff();

    // Fresh editorOptions object every render (production builds a new
    // editSession literal each time) - hydration must key on old/new identity,
    // not the session wrapper.
    capturedFileDiffs.length = 0;
    rendered.rerender(
      <DiffContentPrimitive
        patch={CHANGE_PATCH}
        cacheScope="stable-identity"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editSession={{
          editorOptions: { ...EMPTY_EDITOR_OPTIONS },
          oldFile,
          newFile,
        }}
      />,
    );
    expect(capturedFileDiffs).toHaveLength(1);
    expect(requireCapturedFileDiff()).toBe(first);
  });

  it("pre-hydrates rename-pure and rename-changed diffs", async () => {
    capturedFileDiffs.length = 0;
    renderPrimitive({
      patch: RENAME_PURE_PATCH,
      cacheScope: "rename-pure",
      editSession: {
        oldFile: null,
        newFile: { name: "new.ts", contents: "identical body\n" },
      },
    });
    expect(capturedFileDiffs).toHaveLength(1);
    const pure = requireCapturedFileDiff();
    expect(pure.type).toBe("rename-pure");
    // hydratePartialDiff clears isPartial and fills line arrays for pure
    // renames. The editor still refuses to attach when the patch carries zero
    // hunks (library behaviour independent of this fix) - so we only pin the
    // non-partial contract here, not applyEdits.
    expect(pure.isPartial).toBe(false);
    expect(pure.additionLines.length).toBeGreaterThan(0);

    capturedFileDiffs.length = 0;
    renderPrimitive({
      patch: RENAME_CHANGED_PATCH,
      cacheScope: "rename-changed",
      editSession: {
        oldFile: { name: "old.ts", contents: "same\nold\n" },
        newFile: { name: "new.ts", contents: "same\nnew\n" },
      },
    });
    expect(capturedFileDiffs).toHaveLength(1);
    const changed = requireCapturedFileDiff();
    expect(changed.type).toBe("rename-changed");
    expect(changed.isPartial).toBe(false);
    await assertLibraryAcceptsHydratedDiff(changed, null);
  });

  it("keeps a change/rename-changed diff partial and read-only when the required old side is missing", async () => {
    // `hydrateFileDiffForEdit` cannot hydrate a "change"/"rename-changed"
    // diff without an old side, so it must stay partial - a legitimately
    // missing required side (e.g. a race between the diff-type computation
    // and the content fetch) - rather than silently claim a working editor.
    // The real library never re-attempts hydration for a partial diff once
    // `edit` is true, so getting this wrong would permanently strand the
    // editor exactly like the original bug this whole fix closes.
    const change = renderPrimitive({
      patch: CHANGE_PATCH,
      cacheScope: "missing-old-side-change",
      editSession: { oldFile: null, newFile: CHANGE_NEW },
    });
    expect(capturedFileDiffs).toHaveLength(1);
    const changeFileDiff = requireCapturedFileDiff();
    expect(changeFileDiff.type).toBe("change");
    expect(changeFileDiff.isPartial).toBe(true);
    expect(
      change.container
        .querySelector('[data-testid="instrumented-file-diff"]')
        ?.getAttribute("data-edit"),
    ).toBe("false");
    await assertLibraryRejectsPartialDiff(changeFileDiff);
    change.unmount();

    capturedFileDiffs.length = 0;
    const renameChanged = renderPrimitive({
      patch: RENAME_CHANGED_PATCH,
      cacheScope: "missing-old-side-rename-changed",
      editSession: {
        oldFile: null,
        newFile: { name: "new.ts", contents: "same\nnew\n" },
      },
    });
    expect(capturedFileDiffs).toHaveLength(1);
    const renameFileDiff = requireCapturedFileDiff();
    expect(renameFileDiff.type).toBe("rename-changed");
    expect(renameFileDiff.isPartial).toBe(true);
    expect(
      renameChanged.container
        .querySelector('[data-testid="instrumented-file-diff"]')
        ?.getAttribute("data-edit"),
    ).toBe("false");
    await assertLibraryRejectsPartialDiff(renameFileDiff);
  });

  it("also pre-hydrates untracked/new diffs via parseDiffFromFile (isPartial false)", async () => {
    // The library's own loadDiffFiles path never hydrates type==="new"
    // (canHydrateDiff excludes it). This fix's synchronous path uses
    // parseDiffFromFile for new/deleted instead, which DOES clear isPartial.
    // That is a structural improvement over the pre-fix world for untracked
    // files - documented here rather than treated as out of scope.
    renderPrimitive({
      patch: NEW_FILE_PATCH,
      cacheScope: "new-file",
      editSession: {
        oldFile: null,
        newFile: {
          name: "src/fresh.ts",
          contents: "first line\nsecond line\n",
        },
      },
    });
    expect(capturedFileDiffs).toHaveLength(1);
    const fresh = requireCapturedFileDiff();
    expect(fresh.type).toBe("new");
    expect(fresh.isPartial).toBe(false);
    await assertLibraryAcceptsHydratedDiff(fresh, null);
  });

  it("hydrates independent multi-file edit surfaces without cross-talk", async () => {
    // Bundle view mounts one DiffContentPrimitive per file, each with its own
    // editSession. Two concurrent primitives must not share metadata identity
    // or leave either partial.
    const fileAOld: FileContents = {
      name: "a.ts",
      contents: "a-old\n",
    };
    const fileANew: FileContents = {
      name: "a.ts",
      contents: "a-new\n",
    };
    const fileBOld: FileContents = {
      name: "b.ts",
      contents: "b-old\n",
    };
    const fileBNew: FileContents = {
      name: "b.ts",
      contents: "b-new\n",
    };
    const patchA = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a-old
+a-new
`;
    const patchB = `diff --git a/b.ts b/b.ts
index 1111111..2222222 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-b-old
+b-new
`;

    render(
      <>
        <DiffContentPrimitive
          patch={patchA}
          cacheScope="bundle:a"
          mode="unified"
          wordWrap={false}
          backgrounds
          lineNumbers
          indicatorStyle="bars"
          fileHeaders={false}
          isEmptyFile={false}
          editSession={{
            editorOptions: EMPTY_EDITOR_OPTIONS,
            oldFile: fileAOld,
            newFile: fileANew,
          }}
        />
        <DiffContentPrimitive
          patch={patchB}
          cacheScope="bundle:b"
          mode="unified"
          wordWrap={false}
          backgrounds
          lineNumbers
          indicatorStyle="bars"
          fileHeaders={false}
          isEmptyFile={false}
          editSession={{
            editorOptions: EMPTY_EDITOR_OPTIONS,
            oldFile: fileBOld,
            newFile: fileBNew,
          }}
        />
      </>,
    );

    expect(capturedFileDiffs).toHaveLength(2);
    const [a, b] = capturedFileDiffs;
    expect(a.name).toBe("a.ts");
    expect(b.name).toBe("b.ts");
    expect(a.isPartial).toBe(false);
    expect(b.isPartial).toBe(false);
    expect(a).not.toBe(b);
    await assertLibraryAcceptsHydratedDiff(a, null);
    await assertLibraryAcceptsHydratedDiff(b, null);
  });
});
