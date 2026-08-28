import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";
import { EMPTY_ORIGIN_AFFORDANCE_TEST_ID } from "@/components/diff/empty-origin-edit-affordance";

const captured = vi.hoisted(() => ({
  overflows: [] as Array<"wrap" | "scroll">,
  // Mount lifecycle only (useEffect []). Renders may fire more often.
  mountCount: 0,
  unmountCount: 0,
  lastEdit: null as boolean | null,
  editRenderHistory: [] as boolean[],
  lastUnsafeCSS: null as string | null,
  pool: null as null | {
    setRenderOptions: Mock;
    primeDiffHighlightCache: Mock;
    primeFileHighlightCache: Mock;
  },
  lastFileProps: null as null | {
    readonly file: { readonly name: string; readonly contents: string };
    readonly edit?: boolean;
  },
}));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: (patch: string) => [
    {
      files: [
        patch.length === 0
          ? {
              name: "src/app.ts",
              type: "new",
              hunks: [],
              additionLines: [],
              deletionLines: [],
            }
          : {
              name: "src/app.ts",
              type: "change",
              hunks: [{}],
              additionLines: ["new"],
              deletionLines: ["old"],
            },
      ],
    },
  ],
}));

vi.mock("@pierre/diffs/react", () => ({
  EditProvider: (props: {
    readonly children: ReactNode;
    readonly createEditor: unknown;
  }) => props.children,
  useWorkerPool: () => captured.pool ?? undefined,
  FileDiff: (props: {
    readonly edit?: boolean;
    readonly options: {
      readonly overflow: "wrap" | "scroll";
      readonly unsafeCSS: string;
    };
  }) => <MockFileDiff {...props} />,
  File: (props: {
    readonly file: { readonly name: string; readonly contents: string };
    readonly edit?: boolean;
  }) => {
    captured.lastFileProps = props;
    return (
      <div data-testid="mock-file" data-edit={String(props.edit === true)} />
    );
  },
}));

function MockFileDiff(props: {
  readonly edit?: boolean;
  readonly options: {
    readonly overflow: "wrap" | "scroll";
    readonly unsafeCSS: string;
  };
}): ReactNode {
  const DiffsContainer = "diffs-container" as "div";
  captured.editRenderHistory.push(props.edit === true);
  useEffect(() => {
    captured.overflows.push(props.options.overflow);
    captured.lastEdit = props.edit === true;
    captured.lastUnsafeCSS = props.options.unsafeCSS;
  }, [props.edit, props.options.overflow, props.options.unsafeCSS]);

  useEffect(() => {
    captured.mountCount += 1;
    return () => {
      captured.unmountCount += 1;
    };
  }, []);

  return (
    // Diffs mounts a custom element; keep the same tag so remount checks
    // observe real host-node identity across read → edit.
    <DiffsContainer
      data-testid="file-diff"
      data-edit={String(props.edit === true)}
    />
  );
}

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light",
    themePreset: "neutral",
  }),
}));

describe("<DiffContentPrimitive />", () => {
  beforeEach(() => {
    captured.overflows = [];
    captured.mountCount = 0;
    captured.unmountCount = 0;
    captured.lastEdit = null;
    captured.editRenderHistory = [];
    captured.lastUnsafeCSS = null;
    captured.pool = null;
    captured.lastFileProps = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("honors wordWrap=false for content-sized diffs", () => {
    render(
      <DiffContentFrame
        sizing="content"
        banner={null}
        scrollContainerRef={null}
        onScroll={null}
        fileIdentity={null}
      >
        <DiffContentPrimitive
          patch="@@ -1 +1 @@\n-old\n+new\n"
          cacheScope="test"
          mode="unified"
          wordWrap={false}
          backgrounds
          lineNumbers
          indicatorStyle="bars"
          fileHeaders={false}
          isEmptyFile={false}
        />
      </DiffContentFrame>,
    );

    expect(captured.overflows.at(-1)).toBe("scroll");
    expect(captured.lastUnsafeCSS).toContain(
      "[data-interactive-lines] [data-line] {\n    cursor: text;",
    );
  });

  it("keeps the same diffs-container host node across read → edit", () => {
    const editAdapter = createEditAdapter();
    const rendered = render(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="stable"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editAdapter={editAdapter}
      />,
    );

    const readContainer = document.querySelector("diffs-container");
    expect(readContainer).toBeInstanceOf(HTMLElement);
    // StrictMode may double-invoke mount effects; require at least one live mount.
    expect(captured.mountCount).toBeGreaterThan(0);
    const mountsBeforeEdit = captured.mountCount;
    const unmountsBeforeEdit = captured.unmountCount;
    const rendersBeforeEdit = captured.editRenderHistory.length;
    expect(captured.lastEdit).toBe(false);

    rendered.rerender(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="stable"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editAdapter={editAdapter}
        editSession={{
          editorOptions: editAdapter.editorOptions,
          oldFile: { name: "src/app.ts", contents: "old\n" },
          newFile: { name: "src/app.ts", contents: "new\n" },
        }}
      />,
    );

    const editContainer = document.querySelector("diffs-container");
    expect(editContainer).toBe(readContainer);
    // No replacement: host identity stable and no additional mount/unmount cycle.
    expect(captured.mountCount).toBe(mountsBeforeEdit);
    expect(captured.unmountCount).toBe(unmountsBeforeEdit);
    expect(captured.editRenderHistory.slice(rendersBeforeEdit)).toEqual([true]);
    expect(captured.lastEdit).toBe(true);
    expect(editContainer?.getAttribute("data-edit")).toBe("true");
  });

  it("keeps the same host read-only until the hydrated worker cache is ready, then enables edit", async () => {
    let resolvePrime: (() => void) | null = null;
    const primePromise = new Promise<void>((resolve) => {
      resolvePrime = resolve;
    });
    captured.pool = {
      setRenderOptions: vi.fn(() => Promise.resolve()),
      primeDiffHighlightCache: vi.fn(() => primePromise),
      primeFileHighlightCache: vi.fn(() => Promise.resolve()),
    };
    const editAdapter = createEditAdapter();
    render(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="cold-edit-cache"
        mode="split"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editAdapter={editAdapter}
        editSession={{
          editorOptions: editAdapter.editorOptions,
          oldFile: { name: "src/app.ts", contents: "old\n" },
          newFile: { name: "src/app.ts", contents: "new\n" },
        }}
      />,
    );

    const host = screen.getByTestId("file-diff");
    expect(host.getAttribute("data-edit")).toBe("false");
    expect(captured.pool.primeDiffHighlightCache).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePrime?.();
      await primePromise;
    });

    await waitFor(() => {
      expect(host.getAttribute("data-edit")).toBe("true");
    });
    expect(screen.getByTestId("file-diff")).toBe(host);
    expect(captured.lastUnsafeCSS).toContain("traycer-edit-cache-ready");
  });

  it("ignores a late worker result for a superseded edit target", async () => {
    let resolveFirst: (() => void) | null = null;
    let resolveSecond: (() => void) | null = null;
    const firstPrime = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPrime = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const primeDiffHighlightCache = vi
      .fn()
      .mockReturnValueOnce(firstPrime)
      .mockReturnValueOnce(secondPrime);
    captured.pool = {
      setRenderOptions: vi.fn(() => Promise.resolve()),
      primeDiffHighlightCache,
      primeFileHighlightCache: vi.fn(() => Promise.resolve()),
    };
    const editAdapter = createEditAdapter();
    const firstNewFile = { name: "src/app.ts", contents: "new\n" };
    const rendered = render(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="serial-edit-cache"
        mode="split"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editAdapter={editAdapter}
        editSession={{
          editorOptions: editAdapter.editorOptions,
          oldFile: { name: "src/app.ts", contents: "old\n" },
          newFile: firstNewFile,
        }}
      />,
    );
    const host = screen.getByTestId("file-diff");
    expect(host.getAttribute("data-edit")).toBe("false");

    rendered.rerender(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="serial-edit-cache"
        mode="split"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editAdapter={editAdapter}
        editSession={{
          editorOptions: editAdapter.editorOptions,
          oldFile: { name: "src/app.ts", contents: "old\n" },
          newFile: { name: "src/app.ts", contents: "newer\n" },
        }}
      />,
    );
    expect(primeDiffHighlightCache).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirst?.();
      await firstPrime;
    });
    expect(host.getAttribute("data-edit")).toBe("false");

    await act(async () => {
      resolveSecond?.();
      await secondPrime;
    });
    await waitFor(() => {
      expect(host.getAttribute("data-edit")).toBe("true");
    });
    expect(screen.getByTestId("file-diff")).toBe(host);
  });

  it("gates FileDiff until primeDiffHighlightCache resolves with token transformer options", async () => {
    let resolvePrime: (() => void) | null = null;
    const primePromise = new Promise<void>((resolve) => {
      resolvePrime = resolve;
    });
    const setRenderOptions = vi.fn(() => Promise.resolve());
    const primeDiffHighlightCache = vi.fn(() => primePromise);
    captured.pool = {
      setRenderOptions,
      primeDiffHighlightCache,
      primeFileHighlightCache: vi.fn(() => Promise.resolve()),
    };

    render(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="gate"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
      />,
    );

    expect(screen.getByTestId("diff-highlighting")).toBeTruthy();
    expect(document.querySelector("diffs-container")).toBeNull();
    expect(captured.mountCount).toBe(0);

    await waitFor(() => {
      expect(primeDiffHighlightCache).toHaveBeenCalled();
    });
    expect(setRenderOptions).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrime?.();
      await primePromise;
    });

    await waitFor(() => {
      expect(document.querySelector("diffs-container")).toBeTruthy();
    });
    expect(screen.queryByTestId("diff-highlighting")).toBeNull();
    expect(captured.mountCount).toBeGreaterThan(0);
    expect(captured.unmountCount).toBeLessThan(captured.mountCount);
  });

  it("keeps the mounted diff visible while a later patch prewarms", async () => {
    const firstPrime = Promise.resolve();
    const laterPrime = new Promise<void>(() => undefined);
    const primeDiffHighlightCache = vi
      .fn()
      .mockReturnValueOnce(firstPrime)
      .mockReturnValueOnce(laterPrime);
    captured.pool = {
      setRenderOptions: vi.fn(() => Promise.resolve()),
      primeDiffHighlightCache,
      primeFileHighlightCache: vi.fn(() => Promise.resolve()),
    };
    const rendered = render(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="rollover"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
      />,
    );
    const firstHost = await screen.findByTestId("file-diff");
    const mountsBefore = captured.mountCount;
    const unmountsBefore = captured.unmountCount;

    rendered.rerender(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+newer\n"
        cacheScope="rollover"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
      />,
    );

    expect(screen.queryByTestId("diff-highlighting")).toBeNull();
    expect(screen.getByTestId("file-diff")).toBe(firstHost);
    expect(captured.mountCount).toBe(mountsBefore);
    expect(captured.unmountCount).toBe(unmountsBefore);
    await waitFor(() => {
      expect(primeDiffHighlightCache).toHaveBeenCalledTimes(2);
    });
  });
});

describe("<DiffContentPrimitive /> empty-origin behavior", () => {
  beforeEach(() => {
    captured.overflows = [];
    captured.mountCount = 0;
    captured.unmountCount = 0;
    captured.lastEdit = null;
    captured.editRenderHistory = [];
    captured.lastUnsafeCSS = null;
    captured.pool = null;
    captured.lastFileProps = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the empty-origin affordance for an empty file with an unattached adapter, and activates on click", () => {
    const editAdapter = createEditAdapter();
    render(
      <DiffContentPrimitive
        patch=""
        cacheScope="empty"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile
        editAdapter={editAdapter}
      />,
    );

    const affordance = screen.getByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID);
    fireEvent.click(affordance);
    expect(editAdapter.activateEmptyOrigin).toHaveBeenCalledTimes(1);
    // No editSession yet: still the read-only diff pipeline, not <File>.
    expect(screen.queryByTestId("mock-file")).toBeNull();
  });

  it("does not render the affordance once the adapter reports a real editor attached", () => {
    const editAdapter = { ...createEditAdapter(), attached: true };
    render(
      <DiffContentPrimitive
        patch=""
        cacheScope="empty-attached"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile
        editAdapter={editAdapter}
      />,
    );

    expect(screen.queryByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID)).toBeNull();
  });

  it("does not render the affordance when the file is not empty", () => {
    const editAdapter = createEditAdapter();
    render(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="non-empty"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile={false}
        editAdapter={editAdapter}
      />,
    );

    expect(screen.queryByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID)).toBeNull();
  });

  it("keeps a non-empty diff mounted in place when host size metadata incorrectly says zero", () => {
    const editAdapter = createEditAdapter();
    const rendered = render(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="bad-zero-size-hint"
        mode="split"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile
        editAdapter={editAdapter}
      />,
    );

    const readContainer = screen.getByTestId("file-diff");
    expect(screen.queryByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID)).toBeNull();

    rendered.rerender(
      <DiffContentPrimitive
        patch="@@ -1 +1 @@\n-old\n+new\n"
        cacheScope="bad-zero-size-hint"
        mode="split"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile
        editAdapter={editAdapter}
        editSession={{
          editorOptions: editAdapter.editorOptions,
          oldFile: { name: "src/app.ts", contents: "old\n" },
          newFile: { name: "src/app.ts", contents: "new\n" },
        }}
      />,
    );

    expect(screen.getByTestId("file-diff")).toBe(readContainer);
    expect(readContainer.getAttribute("data-edit")).toBe("true");
    expect(screen.queryByTestId("mock-file")).toBeNull();
  });

  it("renders <File> (not <FileDiff>) once an editSession is set for an empty file, with the caret-1:0 editorOptions and new-file identity", () => {
    // A real editor has already attached (editSession only exists once
    // activation completed) - the affordance must stay hidden here too.
    const editAdapter = { ...createEditAdapter(), attached: true };
    render(
      <DiffContentPrimitive
        patch=""
        cacheScope="empty-editing"
        mode="unified"
        wordWrap={false}
        backgrounds
        lineNumbers
        indicatorStyle="bars"
        fileHeaders={false}
        isEmptyFile
        editAdapter={editAdapter}
        editSession={{
          editorOptions: editAdapter.editorOptions,
          oldFile: null,
          newFile: { name: "untracked.txt", contents: "" },
        }}
      />,
    );

    expect(screen.queryByTestId("file-diff")).toBeNull();
    expect(screen.queryByTestId(EMPTY_ORIGIN_AFFORDANCE_TEST_ID)).toBeNull();
    const fileNode = screen.getByTestId("mock-file");
    expect(fileNode.getAttribute("data-edit")).toBe("true");
    expect(captured.lastFileProps?.file).toEqual({
      name: "untracked.txt",
      contents: "",
    });
  });
});

function createEditAdapter(): DiffClickToEditAdapter {
  return {
    fileOptions: {
      enableTokenInteractionsOnWhitespace: true,
      onLineClick: vi.fn(),
      onLineEnter: vi.fn(),
      onTokenClick: vi.fn(),
      onTokenEnter: vi.fn(),
    },
    diffOptions: {
      enableTokenInteractionsOnWhitespace: true,
      onLineClick: vi.fn(),
      onLineEnter: vi.fn(),
      onTokenClick: vi.fn(),
      onTokenEnter: vi.fn(),
    },
    editorOptions: {},
    onKeyDownCapture: vi.fn(),
    onPointerDownCapture: vi.fn(),
    cancelPendingActivation: vi.fn(),
    activateEmptyOrigin: vi.fn(),
    attached: false,
  };
}
