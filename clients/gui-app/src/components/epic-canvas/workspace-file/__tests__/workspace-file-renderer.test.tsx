import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";

const highlightPool = vi.hoisted(() => ({
  pool: undefined as
    | undefined
    | {
        setRenderOptions: Mock;
        primeFileHighlightCache: Mock;
        primeDiffHighlightCache: Mock;
      },
  // Mount lifecycle only (useEffect []). Renders may fire more often.
  mountCount: 0,
  unmountCount: 0,
  lastEdit: null as boolean | null,
  lastOverflow: null as string | null,
}));

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("@pierre/diffs/react", () => ({
  useWorkerPool: () => highlightPool.pool,
  // Stable provider boundary: always present in read and edit mode.
  EditProvider: (props: { readonly children: ReactNode }) => props.children,
  File: (props: {
    readonly edit: boolean;
    readonly file: { readonly contents: string };
    readonly options: {
      readonly overflow?: string;
      readonly onPostRender?: (
        node: HTMLElement,
        instance: unknown,
        phase: string,
      ) => void;
    };
  }) => <MockDiffsFile {...props} />,
}));

import { WorkspaceFileRenderer } from "../workspace-file-renderer";

function MockDiffsFile(props: {
  readonly edit: boolean;
  readonly file: { readonly contents: string };
  readonly options: {
    readonly overflow?: string;
    readonly onPostRender?: (
      node: HTMLElement,
      instance: unknown,
      phase: string,
    ) => void;
  };
}): ReactNode {
  const DiffsContainer = "diffs-container" as "div";
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    highlightPool.lastOverflow = props.options.overflow ?? null;
  }, [props.options.overflow]);

  useEffect(() => {
    highlightPool.lastEdit = props.edit;
  }, [props.edit]);

  useEffect(() => {
    highlightPool.mountCount += 1;
    return () => {
      highlightPool.unmountCount += 1;
    };
  }, []);

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (node === null) return;
    if (node.shadowRoot === null) {
      node.attachShadow({ mode: "open" });
    }
    const content = document.createElement("div");
    content.setAttribute("data-content", "");
    content.textContent = props.file.contents;
    if (props.edit) {
      content.contentEditable = "true";
      content.role = "textbox";
      content.ariaMultiLine = "true";
    }
    node.shadowRoot?.replaceChildren(content);
    props.options.onPostRender?.(node, undefined, "render");
  }, [props.edit, props.file.contents, props.options]);

  return <DiffsContainer ref={hostRef as never} />;
}

beforeEach(() => {
  highlightPool.pool = undefined;
  highlightPool.mountCount = 0;
  highlightPool.unmountCount = 0;
  highlightPool.lastEdit = null;
  highlightPool.lastOverflow = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<WorkspaceFileRenderer />", () => {
  // Unwrapped, Diffs gives its code area a horizontal scroll box of its own,
  // nested inside the tile's vertical one - the pair a touch drag feeds at the
  // same time. Wrapping is what removes that box, so the two must not drift
  // apart: this asserts the prop reaches the library option that decides it.
  it("selects the Diffs overflow mode that matches the requested wrapping", async () => {
    const editAdapter = createEditAdapter(vi.fn(), undefined);
    const tree = (wordWrap: boolean): ReactNode => (
      <WorkspaceFileRenderer
        content={"const value = 1;\n"}
        fileName="source.ts"
        language="typescript"
        editing={false}
        editAdapter={editAdapter}
        wordWrap={wordWrap}
        revealLine={null}
        revealNonce={null}
        findTarget={null}
        onRevealConsumed={vi.fn()}
        fileIdentity={null}
      />
    );
    const rendered = render(tree(false));
    await waitFor(() => {
      expect(highlightPool.lastOverflow).toBe("scroll");
    });

    rendered.rerender(tree(true));
    await waitFor(() => {
      expect(highlightPool.lastOverflow).toBe("wrap");
    });
  });

  it("keeps the same diffs-container DOM node across read → edit", async () => {
    const onChange = vi.fn();
    const editAdapter = createEditAdapter(onChange, undefined);
    const rendered = render(
      <WorkspaceFileRenderer
        content={"const value = 1;\n"}
        fileName="source.ts"
        language="typescript"
        editing={false}
        editAdapter={editAdapter}
        wordWrap={false}
        revealLine={null}
        revealNonce={null}
        findTarget={null}
        onRevealConsumed={vi.fn()}
        fileIdentity={null}
      />,
    );

    await waitFor(() => {
      const source =
        activeDiffsContainer()?.shadowRoot?.querySelector("[data-content]");
      expect(source?.textContent).toContain("const value = 1;");
      expect(source?.getAttribute("contenteditable")).not.toBe("true");
    });

    const readContainer = activeDiffsContainer();
    expect(readContainer).toBeInstanceOf(HTMLElement);
    expect(highlightPool.mountCount).toBeGreaterThan(0);
    const mountsBeforeEdit = highlightPool.mountCount;
    const unmountsBeforeEdit = highlightPool.unmountCount;
    expect(highlightPool.lastEdit).toBe(false);

    rendered.rerender(
      <WorkspaceFileRenderer
        content={"const value = 1;\n"}
        fileName="source.ts"
        language="typescript"
        editing
        editAdapter={editAdapter}
        wordWrap={false}
        revealLine={null}
        revealNonce={null}
        findTarget={null}
        onRevealConsumed={vi.fn()}
        fileIdentity={null}
      />,
    );

    await waitFor(() => {
      const editor =
        activeDiffsContainer()?.shadowRoot?.querySelector("[data-content]");
      expect(editor).toBeInstanceOf(HTMLElement);
      if (!(editor instanceof HTMLElement)) return;
      expect(editor.contentEditable).toBe("true");
      expect(editor.role).toBe("textbox");
      expect(editor.ariaMultiLine).toBe("true");
    });

    expect(activeDiffsContainer()).toBe(readContainer);
    // No replacement across the transition: same host, no extra mount cycle.
    expect(highlightPool.mountCount).toBe(mountsBeforeEdit);
    expect(highlightPool.unmountCount).toBe(unmountsBeforeEdit);
    expect(highlightPool.lastEdit).toBe(true);
  });

  it("stamps the host's stable file identity for cross-surface find/navigation", () => {
    const editAdapter = createEditAdapter(vi.fn(), undefined);
    const { container } = render(
      <WorkspaceFileRenderer
        content={"const value = 1;\n"}
        fileName="source.ts"
        language="typescript"
        editing={false}
        editAdapter={editAdapter}
        wordWrap={false}
        revealLine={null}
        revealNonce={null}
        findTarget={null}
        onRevealConsumed={vi.fn()}
        fileIdentity={{
          findFilePath: "src/source.ts",
          bundleFindFileId: "workspace-file:host-A:/work/repo:src/source.ts",
        }}
      />,
    );
    const host = container.querySelector("[data-diffs-host]");
    expect(host?.getAttribute("data-diff-find-file")).toBe("src/source.ts");
    expect(host?.getAttribute("data-bundle-diff-file-id")).toBe(
      "workspace-file:host-A:/work/repo:src/source.ts",
    );
  });

  describe("empty-file activation affordance", () => {
    it("renders an accessible, cursor-text affordance for empty content when not yet attached", () => {
      render(
        <WorkspaceFileRenderer
          content=""
          fileName="empty.txt"
          language="plaintext"
          editing={false}
          editAdapter={createEditAdapter(vi.fn(), undefined)}
          wordWrap={false}
          revealLine={null}
          revealNonce={null}
          findTarget={null}
          onRevealConsumed={vi.fn()}
          fileIdentity={null}
        />,
      );

      const affordance = screen.getByRole("button", {
        name: "Empty file — click or press Enter to edit",
      });
      expect(affordance).toBeTruthy();
      expect(affordance.tabIndex).toBe(0);
      expect(affordance.className).toContain("cursor-text");
    });

    it("does not render the affordance for non-empty content", () => {
      render(
        <WorkspaceFileRenderer
          content={"const value = 1;\n"}
          fileName="source.ts"
          language="typescript"
          editing={false}
          editAdapter={createEditAdapter(vi.fn(), undefined)}
          wordWrap={false}
          revealLine={null}
          revealNonce={null}
          findTarget={null}
          onRevealConsumed={vi.fn()}
          fileIdentity={null}
        />,
      );

      expect(screen.queryByTestId("empty-origin-edit-affordance")).toBeNull();
    });

    it("does not render the affordance once the adapter reports attached, even for empty content", () => {
      render(
        <WorkspaceFileRenderer
          content=""
          fileName="empty.txt"
          language="plaintext"
          editing
          editAdapter={createEditAdapter(vi.fn(), {
            activateEmptyOrigin: vi.fn(),
            attached: true,
          })}
          wordWrap={false}
          revealLine={null}
          revealNonce={null}
          findTarget={null}
          onRevealConsumed={vi.fn()}
          fileIdentity={null}
        />,
      );

      expect(screen.queryByTestId("empty-origin-edit-affordance")).toBeNull();
    });

    it("activates on click", () => {
      const activateEmptyOrigin = vi.fn();
      render(
        <WorkspaceFileRenderer
          content=""
          fileName="empty.txt"
          language="plaintext"
          editing={false}
          editAdapter={createEditAdapter(vi.fn(), {
            activateEmptyOrigin,
            attached: false,
          })}
          wordWrap={false}
          revealLine={null}
          revealNonce={null}
          findTarget={null}
          onRevealConsumed={vi.fn()}
          fileIdentity={null}
        />,
      );

      fireEvent.click(screen.getByTestId("empty-origin-edit-affordance"));
      expect(activateEmptyOrigin).toHaveBeenCalledTimes(1);
    });

    it("activates on Enter and on Space, and ignores every other key", () => {
      const activateEmptyOrigin = vi.fn();
      render(
        <WorkspaceFileRenderer
          content=""
          fileName="empty.txt"
          language="plaintext"
          editing={false}
          editAdapter={createEditAdapter(vi.fn(), {
            activateEmptyOrigin,
            attached: false,
          })}
          wordWrap={false}
          revealLine={null}
          revealNonce={null}
          findTarget={null}
          onRevealConsumed={vi.fn()}
          fileIdentity={null}
        />,
      );

      const affordance = screen.getByTestId("empty-origin-edit-affordance");
      fireEvent.keyDown(affordance, { key: "Tab" });
      expect(activateEmptyOrigin).not.toHaveBeenCalled();
      fireEvent.keyDown(affordance, { key: "Enter" });
      expect(activateEmptyOrigin).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(affordance, { key: " " });
      expect(activateEmptyOrigin).toHaveBeenCalledTimes(2);
    });

    it("keeps the same grid cell footprint across the affordance-to-editor swap (no row-height change)", () => {
      const rendered = render(
        <WorkspaceFileRenderer
          content=""
          fileName="empty.txt"
          language="plaintext"
          editing={false}
          editAdapter={createEditAdapter(vi.fn(), {
            activateEmptyOrigin: vi.fn(),
            attached: false,
          })}
          wordWrap={false}
          revealLine={null}
          revealNonce={null}
          findTarget={null}
          onRevealConsumed={vi.fn()}
          fileIdentity={null}
        />,
      );

      const host = document.querySelector("[data-diffs-host]");
      const grid = host?.querySelector(".grid");
      expect(grid).toBeTruthy();
      expect(screen.getByTestId("empty-origin-edit-affordance")).toBeTruthy();

      // Once attached, the affordance is gone but the same grid wrapper (not
      // a replaced/reflowed container) still holds the real editor - proven
      // by DOM node identity, not a pixel measurement jsdom can't provide.
      rendered.rerender(
        <WorkspaceFileRenderer
          content=""
          fileName="empty.txt"
          language="plaintext"
          editing
          editAdapter={createEditAdapter(vi.fn(), {
            activateEmptyOrigin: vi.fn(),
            attached: true,
          })}
          wordWrap={false}
          revealLine={null}
          revealNonce={null}
          findTarget={null}
          onRevealConsumed={vi.fn()}
          fileIdentity={null}
        />,
      );

      expect(document.querySelector("[data-diffs-host] .grid")).toBe(grid);
      expect(screen.queryByTestId("empty-origin-edit-affordance")).toBeNull();
    });
  });

  it("does not mount the Diffs file surface until primeFileHighlightCache resolves", async () => {
    let resolvePrime: (() => void) | null = null;
    const primePromise = new Promise<void>((resolve) => {
      resolvePrime = resolve;
    });
    const setRenderOptions = vi.fn(() => Promise.resolve());
    const primeFileHighlightCache = vi.fn(() => primePromise);
    highlightPool.pool = {
      setRenderOptions,
      primeFileHighlightCache,
      primeDiffHighlightCache: vi.fn(() => Promise.resolve()),
    };

    render(
      <WorkspaceFileRenderer
        content={"const value = 1;\n"}
        fileName="source.ts"
        language="typescript"
        editing={false}
        editAdapter={createEditAdapter(vi.fn(), undefined)}
        wordWrap={false}
        revealLine={null}
        revealNonce={null}
        findTarget={null}
        onRevealConsumed={vi.fn()}
        fileIdentity={null}
      />,
    );

    expect(screen.getByTestId("workspace-file-highlighting")).toBeTruthy();
    expect(activeDiffsContainer()).toBeNull();
    expect(highlightPool.mountCount).toBe(0);

    await waitFor(() => {
      expect(primeFileHighlightCache).toHaveBeenCalled();
    });
    expect(setRenderOptions).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrime?.();
      await primePromise;
    });

    await waitFor(() => {
      expect(activeDiffsContainer()).toBeTruthy();
    });
    expect(screen.queryByTestId("workspace-file-highlighting")).toBeNull();
    expect(highlightPool.mountCount).toBeGreaterThan(0);
    expect(highlightPool.unmountCount).toBeLessThan(highlightPool.mountCount);
    expect(highlightPool.lastEdit).toBe(false);
  });

  it("reveals the target line once its virtualized row exists", async () => {
    const frames = installAnimationFrameQueue();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const onRevealConsumed = vi.fn();

    render(
      <WorkspaceFileRenderer
        content={"line one\nline two\nline three\n"}
        fileName="source.ts"
        language="typescript"
        editing={false}
        editAdapter={createEditAdapter(vi.fn(), undefined)}
        wordWrap={false}
        revealLine={2}
        revealNonce={1}
        findTarget={null}
        onRevealConsumed={onRevealConsumed}
        fileIdentity={null}
      />,
    );

    await waitFor(() => {
      expect(activeDiffsContainer()).toBeTruthy();
    });
    // Simulates a virtualized row mounting only after the reveal effect's
    // first (failed) lookup: appended between frames, not before render.
    const targetLine = document.createElement("div");
    targetLine.setAttribute("data-line", "");
    targetLine.setAttribute("data-line-index", "1");
    activeDiffsContainer()?.shadowRoot?.appendChild(targetLine);

    act(() => {
      frames.flushFrames();
    });

    expect(targetLine.getAttribute("data-workspace-file-reveal")).toBe("");
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "auto",
    });
    expect(onRevealConsumed).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of frames when the target line never renders", async () => {
    const frames = installAnimationFrameQueue();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const onRevealConsumed = vi.fn();

    render(
      <WorkspaceFileRenderer
        content={"line one\nline two\nline three\n"}
        fileName="source.ts"
        language="typescript"
        editing={false}
        editAdapter={createEditAdapter(vi.fn(), undefined)}
        wordWrap={false}
        revealLine={2}
        revealNonce={1}
        findTarget={null}
        onRevealConsumed={onRevealConsumed}
        fileIdentity={null}
      />,
    );

    await waitFor(() => {
      expect(activeDiffsContainer()).toBeTruthy();
    });

    // The target row never renders (e.g. scrolled far off-screen). The retry
    // loop must give up instead of scheduling animation frames forever -
    // `flushFrames` throws if it doesn't converge within its guard.
    act(() => {
      frames.flushFrames();
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(onRevealConsumed).toHaveBeenCalledTimes(1);
  });

  it("keeps the mounted file visible while later content prewarms", async () => {
    const primeFileHighlightCache = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(new Promise<void>(() => undefined));
    highlightPool.pool = {
      setRenderOptions: vi.fn(() => Promise.resolve()),
      primeFileHighlightCache,
      primeDiffHighlightCache: vi.fn(() => Promise.resolve()),
    };
    const props = {
      fileName: "source.ts",
      language: "typescript",
      editing: false,
      editAdapter: createEditAdapter(vi.fn(), undefined),
      wordWrap: false,
      revealLine: null,
      revealNonce: null,
      findTarget: null,
      onRevealConsumed: vi.fn(),
      fileIdentity: null,
    } as const;
    const rendered = render(
      <WorkspaceFileRenderer content={"const value = 1;\n"} {...props} />,
    );
    await waitFor(() => {
      expect(activeDiffsContainer()).toBeTruthy();
    });
    const firstHost = activeDiffsContainer();
    const mountsBefore = highlightPool.mountCount;
    const unmountsBefore = highlightPool.unmountCount;

    rendered.rerender(
      <WorkspaceFileRenderer content={"const value = 2;\n"} {...props} />,
    );

    expect(screen.queryByTestId("workspace-file-highlighting")).toBeNull();
    expect(activeDiffsContainer()).toBe(firstHost);
    expect(highlightPool.mountCount).toBe(mountsBefore);
    expect(highlightPool.unmountCount).toBe(unmountsBefore);
    await waitFor(() => {
      expect(primeFileHighlightCache).toHaveBeenCalledTimes(2);
    });
  });
});

function createEditAdapter(
  onChange: (content: string) => void,
  overrides:
    | {
        readonly activateEmptyOrigin: () => void;
        readonly attached: boolean;
      }
    | undefined,
): DiffClickToEditAdapter {
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
    editorOptions: {
      onChange: (file) => {
        onChange(file.contents);
      },
    },
    onKeyDownCapture: vi.fn(),
    onPointerDownCapture: vi.fn(),
    cancelPendingActivation: vi.fn(),
    activateEmptyOrigin: overrides?.activateEmptyOrigin ?? vi.fn(),
    attached: overrides?.attached ?? false,
  };
}

function installAnimationFrameQueue(): {
  readonly flushFrames: () => void;
} {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    callbacks.delete(handle);
  });
  return {
    // Drain every pending frame, including frames re-scheduled while
    // draining (the reveal retry loop), so a test can assert the loop
    // converges instead of polling forever. Guarded against runaway
    // re-scheduling.
    flushFrames: () => {
      let guard = 0;
      while (callbacks.size > 0) {
        guard += 1;
        if (guard > 50) {
          throw new Error("Too many pending animation frames.");
        }
        const entry = Array.from(callbacks.entries()).at(0);
        if (entry === undefined) break;
        const [handle, callback] = entry;
        callbacks.delete(handle);
        callback(0);
      }
    },
  };
}

function activeDiffsContainer(): HTMLElement | null {
  return document.querySelector("diffs-container");
}
