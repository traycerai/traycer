import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import {
  DiffContentFrame,
  DiffContentPrimitive,
} from "@/components/diff/diff-content-primitive";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";

const captured = vi.hoisted(() => ({
  overflows: [] as Array<"wrap" | "scroll">,
  // Mount lifecycle only (useEffect []). Renders may fire more often.
  mountCount: 0,
  unmountCount: 0,
  lastEdit: null as boolean | null,
  lastUnsafeCSS: null as string | null,
  pool: null as null | {
    setRenderOptions: Mock;
    primeDiffHighlightCache: Mock;
    primeFileHighlightCache: Mock;
  },
}));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: () => [
    {
      files: [{ name: "src/app.ts" }],
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
}));

function MockFileDiff(props: {
  readonly edit?: boolean;
  readonly options: {
    readonly overflow: "wrap" | "scroll";
    readonly unsafeCSS: string;
  };
}): ReactNode {
  const DiffsContainer = "diffs-container" as "div";
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
    captured.lastUnsafeCSS = null;
    captured.pool = null;
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
        editAdapter={editAdapter}
      />,
    );

    const readContainer = document.querySelector("diffs-container");
    expect(readContainer).toBeInstanceOf(HTMLElement);
    // StrictMode may double-invoke mount effects; require at least one live mount.
    expect(captured.mountCount).toBeGreaterThan(0);
    const mountsBeforeEdit = captured.mountCount;
    const unmountsBeforeEdit = captured.unmountCount;
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
    expect(captured.lastEdit).toBe(true);
    expect(editContainer?.getAttribute("data-edit")).toBe("true");
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
  };
}
