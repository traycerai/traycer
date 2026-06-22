import "../../../../../__tests__/test-browser-apis";
import { act, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TerminalXtermHost } from "@/components/epic-canvas/renderers/terminal-tile-xterm";
import { __disposeAllXtermHostsForTests } from "@/components/epic-canvas/renderers/xterm-host-registry";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import { useTerminalFindStore } from "@/stores/find-in-page/terminal-find-store";
import type { TerminalDataWriter } from "@/stores/terminals/terminal-session-store";

type Disposable = {
  readonly dispose: () => void;
};

type SearchResultListener = (result: {
  readonly resultIndex: number;
  readonly resultCount: number;
}) => void;

type MockTerminalInstance = {
  readonly focus: Mock;
  readonly paste: Mock;
  readonly isDisposed: () => boolean;
};

type MockSearchAddonInstance = {
  readonly findNext: Mock;
};

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as MockTerminalInstance[],
  searchAddons: [] as MockSearchAddonInstance[],
  // Ordered log of repaint-relevant engine calls, used to assert the reshow
  // repair runs `clearTextureAtlas` BEFORE `refresh`.
  repaintLog: [] as string[],
}));

const runnerHostMocks = vi.hoisted(() => ({
  openExternalLink: vi.fn(() => Promise.resolve()),
  resolveDroppedFilePaths: vi.fn(() =>
    Promise.resolve([] as readonly string[]),
  ),
  copyDroppedFilePaths: vi.fn((paths: readonly string[]) =>
    Promise.resolve(paths),
  ),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    openExternalLink: runnerHostMocks.openExternalLink,
    fileDrops: {
      resolveDroppedFilePaths: runnerHostMocks.resolveDroppedFilePaths,
      copyDroppedFilePaths: runnerHostMocks.copyDroppedFilePaths,
    },
  }),
}));

vi.mock("@/lib/terminal-theme", () => ({
  useTerminalTheme: () => ({}),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    readonly buffer = { active: { baseY: 0, length: 24 } };
    readonly focus = vi.fn();
    readonly paste = vi.fn((data: string) => {
      this.dataListeners.forEach((listener) => {
        listener(`\x1b[200~${data}\x1b[201~`);
      });
    });
    private readonly dataListeners: Array<(data: string) => void> = [];
    private disposed = false;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      xtermMocks.terminals.push(this);
    }

    loadAddon(addon: { activate: (terminal: unknown) => void } | object): void {
      if ("activate" in addon && typeof addon.activate === "function") {
        addon.activate(this);
      }
    }

    open(_container: HTMLElement): void {
      setTimeout(() => {
        if (this.disposed) {
          throw new TypeError(
            "Cannot read properties of undefined (reading 'dimensions')",
          );
        }
      }, 0);
    }

    attachCustomKeyEventHandler(
      _handler: (event: KeyboardEvent) => boolean,
    ): void {}

    onData(listener: (data: string) => void): Disposable {
      this.dataListeners.push(listener);
      return {
        dispose: vi.fn(() => {
          const index = this.dataListeners.indexOf(listener);
          if (index >= 0) {
            this.dataListeners.splice(index, 1);
          }
        }),
      };
    }

    onRender(_listener: () => void): Disposable {
      return { dispose: vi.fn() };
    }

    write(chunk: string, callback: (() => void) | undefined): void {
      if (chunk.includes("\x1b[6n")) {
        this.dataListeners.forEach((listener) => {
          listener("\x1b[16;39R");
        });
      }
      if (callback !== undefined) {
        callback();
      }
    }

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }

    refresh(_start: number, _end: number): void {
      xtermMocks.repaintLog.push("refresh");
    }

    isDisposed(): boolean {
      return this.disposed;
    }

    dispose(): void {
      this.disposed = true;
    }
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class MockSearchAddon {
    readonly findNext = vi.fn(() => true);
    readonly findPrevious = vi.fn(() => true);
    readonly clearDecorations = vi.fn();

    constructor() {
      xtermMocks.searchAddons.push(this);
    }

    onDidChangeResults(_listener: SearchResultListener): Disposable {
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    proposeDimensions(): undefined {
      return undefined;
    }

    fit(): void {}
  },
}));

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class MockClipboardAddon {},
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    constructor(_handler: (event: MouseEvent, uri: string) => void) {}
  },
}));

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class MockCanvasAddon {
    clearTextureAtlas(): void {
      xtermMocks.repaintLog.push("clearAtlas");
    }

    dispose(): void {}
  },
}));

describe("<TerminalXtermHost /> terminal find", () => {
  afterEach(() => {
    cleanup();
    __disposeAllXtermHostsForTests();
    vi.useRealTimers();
    xtermMocks.terminals.length = 0;
    xtermMocks.searchAddons.length = 0;
    xtermMocks.repaintLog.length = 0;
    runnerHostMocks.openExternalLink.mockClear();
    runnerHostMocks.resolveDroppedFilePaths.mockReset();
    runnerHostMocks.resolveDroppedFilePaths.mockResolvedValue([]);
    runnerHostMocks.copyDroppedFilePaths.mockReset();
    runnerHostMocks.copyDroppedFilePaths.mockImplementation((paths) =>
      Promise.resolve(paths),
    );
    useTerminalFindStore.setState({ activeController: null });
    useFindInPageStore.setState({
      isOpen: false,
      query: "",
      matches: null,
      matchCase: false,
      advanceForwardNonce: 0,
      advanceBackwardNonce: 0,
      focusRequestNonce: 0,
    });
  });

  it("reuses one xterm engine across a StrictMode remount, then disposes it once on unmount", () => {
    vi.useFakeTimers();

    const rendered = render(
      <StrictMode>
        <TerminalXtermHost
          sessionId="test-session"
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane={false}
          findTargetId="terminal:test"
          keepAlive={false}
        />
      </StrictMode>,
    );

    // StrictMode mounts → unmounts → remounts synchronously. The unmount's
    // disposal is deferred (a macrotask), so the remount's re-acquire cancels
    // it and reclaims the SAME engine instead of building a fresh one. Eager
    // disposal here is the blank-terminal-on-refresh bug: it throws away the
    // engine that already rendered the one-shot host snapshot.
    expect(xtermMocks.terminals).toHaveLength(1);
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(xtermMocks.terminals[0].isDisposed()).toBe(false);

    // A real unmount has no remount to cancel the deferred disposal, so the
    // engine is torn down. The startup Viewport timer must still drain first
    // without throwing.
    rendered.unmount();
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(xtermMocks.terminals[0].isDisposed()).toBe(true);
  });

  it("clears the glyph atlas before refreshing when a hidden pane becomes visible", () => {
    const hostProps = {
      sessionId: "test-session",
      instanceId: "test-instance",
      effectiveCols: 80,
      effectiveRows: 24,
      onUserInput: vi.fn(),
      onContainerResize: vi.fn(),
      onWriterReady: vi.fn(),
      shouldFocusOnActivePane: false,
      findTargetId: "terminal:test",
      keepAlive: false,
    } as const;

    const rendered = render(
      <PaneVisibilityContext value={false}>
        <TerminalXtermHost {...hostProps} />
      </PaneVisibilityContext>,
    );

    // Hidden on mount: the visible-pane repair must not have run yet.
    expect(xtermMocks.repaintLog).not.toContain("refresh");

    // Drop the mount-time atlas/theme churn so the assertion isolates the
    // reshow path.
    xtermMocks.repaintLog.length = 0;

    act(() => {
      rendered.rerender(
        <PaneVisibilityContext value>
          <TerminalXtermHost {...hostProps} />
        </PaneVisibilityContext>,
      );
    });

    // The reshow repair clears the (possibly invalidated) glyph atlas BEFORE
    // forcing the full repaint, so every cell re-rasterizes in the current
    // theme instead of painting from a stale/cleared atlas - the blank-grid /
    // default-color regression after returning from `display:none`.
    expect(xtermMocks.repaintLog).toEqual(["clearAtlas", "refresh"]);
  });

  it("searches the terminal without taking focus from the find input", async () => {
    render(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane
        findTargetId="terminal:test"
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(useTerminalFindStore.getState().activeController).not.toBeNull();
    });

    const controller = useTerminalFindStore.getState().activeController;
    if (controller === null) {
      throw new Error("Terminal find controller was not registered");
    }
    xtermMocks.terminals[0].focus.mockClear();

    controller.findNext("needle", false, false);

    expect(xtermMocks.searchAddons[0].findNext).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ incremental: false }),
    );
    expect(xtermMocks.terminals[0].focus).not.toHaveBeenCalled();
  });

  it("focuses the active terminal when its pane becomes visible", async () => {
    render(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane
        findTargetId="terminal:test"
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals[0].focus).toHaveBeenCalledTimes(1);
    });
  });

  it("suppresses xterm responses generated during snapshot replay only", async () => {
    const onUserInput = vi.fn();
    let writer: TerminalDataWriter | null = null;

    render(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={onUserInput}
        onContainerResize={vi.fn()}
        onWriterReady={(nextWriter) => {
          writer = nextWriter;
        }}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(writer).not.toBeNull();
    });
    const getWriter = (): TerminalDataWriter => {
      if (writer === null) {
        throw new Error("Expected terminal writer");
      }
      return writer;
    };

    getWriter()({ kind: "snapshot", chunk: "\x1b[6n", cols: 80, rows: 24 });
    expect(onUserInput).not.toHaveBeenCalled();

    getWriter()({ kind: "live", chunk: "\x1b[6n" });
    expect(onUserInput).toHaveBeenCalledWith("\x1b[16;39R");
  });

  it("focuses the active terminal when a retained hidden pane becomes visible", async () => {
    const { rerender } = render(
      <PaneVisibilityContext.Provider value={false}>
        <TerminalXtermHost
          sessionId="test-session"
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane
          findTargetId="terminal:test"
          keepAlive={false}
        />
      </PaneVisibilityContext.Provider>,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals).toHaveLength(1);
    });
    expect(xtermMocks.terminals[0].focus).not.toHaveBeenCalled();

    rerender(
      <PaneVisibilityContext.Provider value>
        <TerminalXtermHost
          sessionId="test-session"
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane
          findTargetId="terminal:test"
          keepAlive={false}
        />
      </PaneVisibilityContext.Provider>,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals[0].focus).toHaveBeenCalledTimes(1);
    });
  });

  it("does not focus inactive terminal tiles in the visible pane", async () => {
    render(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals).toHaveLength(1);
    });
    expect(xtermMocks.terminals[0].focus).not.toHaveBeenCalled();
  });

  it("focuses a terminal that becomes the active tile while its pane is already visible", async () => {
    const { rerender } = render(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals).toHaveLength(1);
    });
    expect(xtermMocks.terminals[0].focus).not.toHaveBeenCalled();

    rerender(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane
        findTargetId="terminal:test"
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals[0].focus).toHaveBeenCalledTimes(1);
    });
  });

  it("focuses an activated terminal after the clicked tab's own focus settles", async () => {
    vi.useFakeTimers();
    const focusOrder: string[] = [];

    function ActivationHarness() {
      const [active, setActive] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setActive(true);
              window.setTimeout(() => {
                focusOrder.push("tab");
              }, 0);
            }}
          >
            Activate terminal tab
          </button>
          <TerminalXtermHost
            sessionId="test-session"
            instanceId="test-instance"
            effectiveCols={80}
            effectiveRows={24}
            onUserInput={vi.fn()}
            onContainerResize={vi.fn()}
            onWriterReady={vi.fn()}
            shouldFocusOnActivePane={active}
            findTargetId={active ? "terminal:test" : null}
            keepAlive={false}
          />
        </>
      );
    }

    render(<ActivationHarness />);

    expect(xtermMocks.terminals).toHaveLength(1);
    xtermMocks.terminals[0].focus.mockImplementation(() => {
      focusOrder.push("terminal");
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Activate terminal tab" }),
    );

    expect(focusOrder).toEqual([]);

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(focusOrder).toEqual(["tab", "terminal"]);
  });

  it("pastes dropped file paths through xterm's paste path", async () => {
    const onUserInput = vi.fn();
    const screenshotPath =
      "/Users/tgill/Desktop/Screenshot 2026-06-03 at 1.17.17\u202fAM.png";
    runnerHostMocks.resolveDroppedFilePaths.mockResolvedValue([screenshotPath]);

    render(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={onUserInput}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
      />,
    );

    const dropTarget = screen.getByTestId("terminal-xterm-host").parentElement;
    if (dropTarget === null) {
      throw new Error("Terminal drop target was not mounted");
    }

    fireEvent.drop(dropTarget, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["image"], "Screenshot.png", { type: "image/png" })],
        items: [],
        dropEffect: "copy",
      },
    });

    await waitFor(() => {
      expect(xtermMocks.terminals[0].paste).toHaveBeenCalledWith(
        "/Users/tgill/Desktop/Screenshot\\ 2026-06-03\\ at\\ 1.17.17\\\u202fAM.png",
      );
      expect(onUserInput).toHaveBeenCalledWith(
        "\x1b[200~/Users/tgill/Desktop/Screenshot\\ 2026-06-03\\ at\\ 1.17.17\\\u202fAM.png\x1b[201~",
      );
    });
    expect(onUserInput.mock.calls[0]?.[0]).not.toContain("'");
    expect(xtermMocks.terminals[0].focus).toHaveBeenCalledTimes(1);
  });

  it("copies ephemeral file URL drops into a stable path before pasting", async () => {
    const onUserInput = vi.fn();
    const stablePath =
      "/tmp/traycer-dropped-files/20260603-uuid-Screenshot-2026-06-03-at-1.17.17-AM.png";
    runnerHostMocks.copyDroppedFilePaths.mockResolvedValue([stablePath]);

    render(
      <TerminalXtermHost
        sessionId="test-session"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={onUserInput}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
      />,
    );

    const dropTarget = screen.getByTestId("terminal-xterm-host").parentElement;
    if (dropTarget === null) {
      throw new Error("Terminal drop target was not mounted");
    }

    fireEvent.drop(dropTarget, {
      dataTransfer: {
        types: ["Files", "text/uri-list"],
        files: [],
        items: [],
        dropEffect: "copy",
        getData: (type: string) =>
          type === "text/uri-list"
            ? "file:///Users/tgill/Desktop/Screenshot%202026-06-03%20at%201.17.17%E2%80%AFAM.png"
            : "",
      },
    });

    await waitFor(() => {
      expect(xtermMocks.terminals[0].paste).toHaveBeenCalledWith(stablePath);
    });
    expect(runnerHostMocks.copyDroppedFilePaths).toHaveBeenCalledWith([
      "/Users/tgill/Desktop/Screenshot 2026-06-03 at 1.17.17\u202fAM.png",
    ]);
    expect(runnerHostMocks.resolveDroppedFilePaths).not.toHaveBeenCalled();
    expect(onUserInput).toHaveBeenCalledWith(`\x1b[200~${stablePath}\x1b[201~`);
  });
});
