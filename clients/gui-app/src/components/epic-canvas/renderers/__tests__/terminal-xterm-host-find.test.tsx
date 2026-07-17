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
import { TileFindScope } from "@/components/epic-canvas/tile-find/tile-find-scope";
import { TerminalXtermHost } from "@/components/epic-canvas/renderers/terminal-tile-xterm";
import {
  __disposeAllXtermHostsForTests,
  __getXtermHostEntryForTests,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import { useTerminalFindStore } from "@/stores/find-in-page/terminal-find-store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useTileFindStore } from "@/stores/tile-find";
import type { TerminalDataWriter } from "@/stores/terminals/terminal-session-store";
import type { TerminalTileFindKind } from "@/components/epic-canvas/renderers/terminal-tile-find-adapter";

type Disposable = {
  readonly dispose: () => void;
};

interface SearchResult {
  readonly resultIndex: number;
  readonly resultCount: number;
}

type SearchResultListener = (result: SearchResult) => void;

type MockTerminalInstance = {
  readonly focus: Mock;
  readonly paste: Mock;
  readonly isDisposed: () => boolean;
};

type MockSearchAddonInstance = {
  readonly findNext: Mock;
  readonly findPrevious: Mock;
  readonly clearDecorations: Mock;
  emitResults(result: SearchResult): void;
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
    private readonly resultListeners: SearchResultListener[] = [];

    constructor() {
      xtermMocks.searchAddons.push(this);
    }

    onDidChangeResults(listener: SearchResultListener): Disposable {
      this.resultListeners.push(listener);
      return {
        dispose: vi.fn(() => {
          const index = this.resultListeners.indexOf(listener);
          if (index >= 0) {
            this.resultListeners.splice(index, 1);
          }
        }),
      };
    }

    emitResults(result: SearchResult): void {
      this.resultListeners.forEach((listener) => listener(result));
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

interface ScopedTerminalHostProps {
  readonly tileKind: TerminalTileFindKind;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly tileId: string;
  readonly isActive: boolean;
  readonly keepAlive: boolean;
}

function ScopedTerminalHost(props: ScopedTerminalHostProps) {
  const node = createTerminalNode({
    tileKind: props.tileKind,
    instanceId: props.instanceId,
    sessionId: props.sessionId,
  });
  const viewTabId = `view-${props.tileId}`;
  const findTargetId = props.isActive
    ? `${props.tileKind}:${viewTabId}:${props.tileId}:${props.sessionId}`
    : null;
  return (
    <TileFindScope
      node={node}
      viewTabId={viewTabId}
      tileId={props.tileId}
      epicId="epic-1"
      isActive={props.isActive}
    >
      <TerminalXtermHost
        sessionId={props.sessionId}
        tileKind={props.tileKind}
        instanceId={props.instanceId}
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={props.isActive}
        findTargetId={findTargetId}
        keepAlive={props.keepAlive}
        chrome="padded"
      />
    </TileFindScope>
  );
}

function createTerminalNode(args: {
  readonly tileKind: TerminalTileFindKind;
  readonly instanceId: string;
  readonly sessionId: string;
}): EpicCanvasTileRef {
  if (args.tileKind === "terminal") {
    return {
      id: args.sessionId,
      instanceId: args.instanceId,
      type: "terminal",
      name: "Terminal",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/tmp",
    };
  }
  return {
    id: args.sessionId,
    instanceId: args.instanceId,
    type: "terminal-agent",
    name: "Terminal Agent",
    hostId: "host-1",
  };
}

function getSearchAddon(index: number): MockSearchAddonInstance {
  const addon = xtermMocks.searchAddons.at(index);
  if (addon === undefined) {
    throw new Error(`Expected search addon at index ${index}`);
  }
  return addon;
}

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
    useTileFindStore.getState().resetForTests();
  });

  it("reuses one xterm engine across a StrictMode remount, then disposes it once on unmount", () => {
    vi.useFakeTimers();

    const rendered = render(
      <StrictMode>
        <TerminalXtermHost
          sessionId="test-session"
          tileKind="terminal"
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane={false}
          findTargetId="terminal:test"
          keepAlive={false}
          chrome="padded"
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
      tileKind: "terminal",
      instanceId: "test-instance",
      effectiveCols: 80,
      effectiveRows: 24,
      onUserInput: vi.fn(),
      onContainerResize: vi.fn(),
      onWriterReady: vi.fn(),
      shouldFocusOnActivePane: false,
      findTargetId: "terminal:test",
      keepAlive: false,
      chrome: "padded",
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
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane
        findTargetId="terminal:test"
        keepAlive={false}
        chrome="padded"
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

  it("publishes legacy terminal result events to the global find store", async () => {
    render(
      <TerminalXtermHost
        sessionId="test-session"
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane
        findTargetId="terminal:test"
        keepAlive={false}
        chrome="padded"
      />,
    );

    await waitFor(() => {
      expect(useTerminalFindStore.getState().activeController).not.toBeNull();
    });

    const controller = useTerminalFindStore.getState().activeController;
    if (controller === null) {
      throw new Error("Terminal find controller was not registered");
    }

    act(() => {
      controller.findNext("needle", false, false);
      getSearchAddon(0).emitResults({ resultIndex: 1, resultCount: 4 });
    });

    expect(useFindInPageStore.getState().matches).toEqual({
      current: 2,
      total: 4,
    });
  });

  it("delegates tile-local terminal search commands to xterm", async () => {
    render(
      <ScopedTerminalHost
        tileKind="terminal"
        instanceId="terminal-instance"
        sessionId="terminal-session"
        tileId="terminal-pane"
        isActive
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId["terminal-instance"]
          ?.adapter.tileKind,
      ).toBe("terminal");
    });

    act(() => {
      useTileFindStore.getState().openForTile("terminal-instance");
      useTileFindStore.getState().setQuery("terminal-instance", "Needle");
      useTileFindStore.getState().setMatchCase("terminal-instance", true);
      useTileFindStore.getState().search("terminal-instance");
    });

    const addon = getSearchAddon(0);
    expect(addon.findNext).toHaveBeenCalledWith(
      "Needle",
      expect.objectContaining({
        caseSensitive: true,
        incremental: true,
      }),
    );
    expect(useFindInPageStore.getState().matches).toBeNull();

    act(() => {
      addon.emitResults({ resultIndex: 1, resultCount: 3 });
    });

    expect(
      useTileFindStore.getState().uiByTileInstanceId["terminal-instance"]
        ?.lastSnapshot,
    ).toMatchObject({
      status: "ready",
      query: "Needle",
      matchCase: true,
      current: 2,
      total: 3,
      exactHighlight: "painted",
    });
    expect(useFindInPageStore.getState().matches).toBeNull();

    act(() => {
      useTileFindStore.getState().next("terminal-instance");
    });
    expect(addon.findNext).toHaveBeenLastCalledWith(
      "Needle",
      expect.objectContaining({
        caseSensitive: true,
        incremental: false,
      }),
    );

    act(() => {
      useTileFindStore.getState().previous("terminal-instance");
    });
    expect(addon.findPrevious).toHaveBeenCalledWith(
      "Needle",
      expect.objectContaining({
        caseSensitive: true,
        incremental: false,
      }),
    );

    act(() => {
      useTileFindStore.getState().close("terminal-instance");
    });
    expect(addon.clearDecorations).toHaveBeenCalledTimes(1);
    expect(
      useTileFindStore.getState().uiByTileInstanceId["terminal-instance"]
        ?.lastSnapshot,
    ).toMatchObject({
      status: "idle",
      query: "",
      current: 0,
      total: 0,
    });

    const findNextCallCount = addon.findNext.mock.calls.length;
    const findPreviousCallCount = addon.findPrevious.mock.calls.length;
    act(() => {
      useTileFindStore.getState().next("terminal-instance");
      useTileFindStore.getState().previous("terminal-instance");
    });
    expect(addon.findNext).toHaveBeenCalledTimes(findNextCallCount);
    expect(addon.findPrevious).toHaveBeenCalledTimes(findPreviousCallCount);
  });

  it("registers the same tile-local adapter path for terminal-agent TUI tiles", async () => {
    render(
      <ScopedTerminalHost
        tileKind="terminal-agent"
        instanceId="agent-instance"
        sessionId="agent-session"
        tileId="agent-pane"
        isActive
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId["agent-instance"]
          ?.adapter.tileKind,
      ).toBe("terminal-agent");
    });

    act(() => {
      useTileFindStore.getState().setQuery("agent-instance", "needle");
      useTileFindStore.getState().search("agent-instance");
    });

    expect(getSearchAddon(0).findNext).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({
        caseSensitive: false,
        incremental: true,
      }),
    );
  });

  it("does not let an inactive terminal adapter registered last own tile find", async () => {
    render(
      <>
        <ScopedTerminalHost
          tileKind="terminal"
          instanceId="active-terminal-instance"
          sessionId="active-terminal-session"
          tileId="active-pane"
          isActive
          keepAlive={false}
        />
        <ScopedTerminalHost
          tileKind="terminal"
          instanceId="inactive-terminal-instance"
          sessionId="inactive-terminal-session"
          tileId="inactive-pane"
          isActive={false}
          keepAlive={false}
        />
      </>,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[
          "inactive-terminal-instance"
        ],
      ).toBeDefined();
    });

    expect(useTileFindStore.getState().activeOwner).toMatchObject({
      tileInstanceId: "active-terminal-instance",
      tileKind: "terminal",
    });

    act(() => {
      useTileFindStore.getState().openActiveOwner();
      useTileFindStore
        .getState()
        .setQuery("active-terminal-instance", "needle");
      useTileFindStore.getState().search("active-terminal-instance");
    });

    expect(getSearchAddon(0).findNext).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ incremental: true }),
    );
    expect(getSearchAddon(1).findNext).not.toHaveBeenCalled();
  });

  it("forwards direct tile search results for an inactive terminal", async () => {
    render(
      <>
        <ScopedTerminalHost
          tileKind="terminal"
          instanceId="active-terminal-instance"
          sessionId="active-terminal-session"
          tileId="active-pane"
          isActive
          keepAlive={false}
        />
        <ScopedTerminalHost
          tileKind="terminal"
          instanceId="inactive-terminal-instance"
          sessionId="inactive-terminal-session"
          tileId="inactive-pane"
          isActive={false}
          keepAlive={false}
        />
      </>,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[
          "inactive-terminal-instance"
        ],
      ).toBeDefined();
    });

    const inactiveAddon = getSearchAddon(1);
    act(() => {
      useTileFindStore.getState().openForTile("inactive-terminal-instance");
      useTileFindStore
        .getState()
        .setQuery("inactive-terminal-instance", "needle");
      useTileFindStore.getState().search("inactive-terminal-instance");
      inactiveAddon.emitResults({ resultIndex: 0, resultCount: 2 });
    });

    expect(inactiveAddon.findNext).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ incremental: true }),
    );
    expect(
      useTileFindStore.getState().uiByTileInstanceId[
        "inactive-terminal-instance"
      ]?.lastSnapshot,
    ).toMatchObject({
      status: "ready",
      query: "needle",
      current: 1,
      total: 2,
      exactHighlight: "painted",
    });
    expect(useFindInPageStore.getState().matches).toBeNull();
  });

  it("keeps legacy terminal results out of tile-local snapshots", async () => {
    render(
      <ScopedTerminalHost
        tileKind="terminal"
        instanceId="terminal-instance"
        sessionId="terminal-session"
        tileId="terminal-pane"
        isActive
        keepAlive={false}
      />,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[
          "terminal-instance"
        ],
      ).toBeDefined();
      expect(useTerminalFindStore.getState().activeController).not.toBeNull();
    });

    const addon = getSearchAddon(0);
    act(() => {
      useTileFindStore.getState().setQuery("terminal-instance", "Needle");
      useTileFindStore.getState().search("terminal-instance");
      addon.emitResults({ resultIndex: 1, resultCount: 3 });
    });
    const tileSnapshotBefore =
      useTileFindStore.getState().uiByTileInstanceId["terminal-instance"]
        ?.lastSnapshot;
    expect(tileSnapshotBefore).toMatchObject({
      query: "Needle",
      current: 2,
      total: 3,
    });

    const controller = useTerminalFindStore.getState().activeController;
    if (controller === null) {
      throw new Error("Terminal find controller was not registered");
    }

    act(() => {
      controller.findNext("legacy", false, false);
      addon.emitResults({ resultIndex: 4, resultCount: 8 });
    });

    expect(useFindInPageStore.getState().matches).toEqual({
      current: 5,
      total: 8,
    });
    expect(
      useTileFindStore.getState().uiByTileInstanceId["terminal-instance"]
        ?.lastSnapshot,
    ).toBe(tileSnapshotBefore);
  });

  it("clears retained xterm search callbacks on unmount and reattaches cleanly", async () => {
    const firstRender = render(
      <ScopedTerminalHost
        tileKind="terminal"
        instanceId="retained-terminal-instance"
        sessionId="retained-terminal-session"
        tileId="retained-pane"
        isActive
        keepAlive
      />,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[
          "retained-terminal-instance"
        ],
      ).toBeDefined();
    });

    const retainedEntry = __getXtermHostEntryForTests(
      "retained-terminal-instance",
    );
    if (retainedEntry === null) {
      throw new Error("Expected retained xterm host entry");
    }
    const firstSearchResultsCallback = retainedEntry.live.onSearchResults;
    expect(retainedEntry.live.getFindTargetId()).not.toBeNull();

    firstRender.unmount();

    expect(__getXtermHostEntryForTests("retained-terminal-instance")).toBe(
      retainedEntry,
    );
    expect(retainedEntry.live.getFindTargetId()).toBeNull();
    expect(retainedEntry.live.onSearchResults).not.toBe(
      firstSearchResultsCallback,
    );

    const secondRender = render(
      <ScopedTerminalHost
        tileKind="terminal"
        instanceId="retained-terminal-instance"
        sessionId="retained-terminal-session"
        tileId="retained-pane"
        isActive
        keepAlive
      />,
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[
          "retained-terminal-instance"
        ],
      ).toBeDefined();
    });
    expect(__getXtermHostEntryForTests("retained-terminal-instance")).toBe(
      retainedEntry,
    );
    expect(retainedEntry.live.getFindTargetId()).not.toBeNull();
    expect(retainedEntry.live.onSearchResults).not.toBe(
      firstSearchResultsCallback,
    );

    act(() => {
      useTileFindStore
        .getState()
        .setQuery("retained-terminal-instance", "after");
      useTileFindStore.getState().search("retained-terminal-instance");
      getSearchAddon(0).emitResults({ resultIndex: 1, resultCount: 2 });
    });

    expect(
      useTileFindStore.getState().uiByTileInstanceId[
        "retained-terminal-instance"
      ]?.lastSnapshot,
    ).toMatchObject({
      query: "after",
      current: 2,
      total: 2,
    });

    secondRender.unmount();
  });

  it("focuses the active terminal when its pane becomes visible", async () => {
    render(
      <TerminalXtermHost
        sessionId="test-session"
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane
        findTargetId="terminal:test"
        keepAlive={false}
        chrome="padded"
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
        tileKind="terminal"
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
        chrome="padded"
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

    getWriter()({
      kind: "snapshot",
      chunk: "\x1b[6n",
      cols: 80,
      rows: 24,
      onAckable: () => {},
    });
    expect(onUserInput).not.toHaveBeenCalled();

    getWriter()({ kind: "live", chunk: "\x1b[6n", onAckable: () => {} });
    expect(onUserInput).toHaveBeenCalledWith("\x1b[16;39R");
  });

  it("resets the buffer before replaying a reconnect snapshot", async () => {
    // A transport reconnect re-sends a full snapshot into the same kept-alive
    // engine that still holds pre-disconnect content. The engine must reset the
    // buffer before replaying so the authoritative snapshot lands clean instead
    // of colliding with the stale screen (the dropped-tail / lost-theme bug).
    // We assert this indirectly: replaying identical content twice leaves the
    // cursor in the SAME place only if the second snapshot reset first; without
    // a reset the second snapshot would append and the cursor would advance.
    const inputReports: string[] = [];
    const onUserInput = vi.fn((data: string) => {
      inputReports.push(data);
    });
    let writer: TerminalDataWriter | null = null;

    render(
      <TerminalXtermHost
        sessionId="test-session-reset"
        tileKind="terminal"
        instanceId="test-instance-reset"
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
        chrome="padded"
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

    // First snapshot: prints content and ends with a cursor-position query.
    getWriter()({
      kind: "snapshot",
      chunk: "hello world\x1b[6n",
      cols: 80,
      rows: 24,
      onAckable: () => {},
    });
    getWriter()({ kind: "live", chunk: "\x1b[6n", onAckable: () => {} });
    const afterFirst = inputReports.at(-1);
    expect(afterFirst).toBeDefined();

    // Reconnect: the SAME content replayed. With a reset the cursor lands in the
    // same spot; without a reset it would append after the first copy.
    getWriter()({
      kind: "snapshot",
      chunk: "hello world\x1b[6n",
      cols: 80,
      rows: 24,
      onAckable: () => {},
    });
    getWriter()({ kind: "live", chunk: "\x1b[6n", onAckable: () => {} });
    const afterReconnect = inputReports.at(-1);

    expect(afterReconnect).toBe(afterFirst);
  });

  it("resets the buffer before replaying a reconnect snapshot given as Uint8Array (terminal.subscribe@1.2)", async () => {
    // Same reset-before-replay guarantee as the string case above, but for a
    // `@1.2` binary connection's `Uint8Array` snapshot chunk - exercises
    // `prependResetEscape`'s byte-concatenation path against a real xterm
    // engine instead of just checking the produced bytes in isolation.
    const inputReports: string[] = [];
    const onUserInput = vi.fn((data: string) => {
      inputReports.push(data);
    });
    let writer: TerminalDataWriter | null = null;

    render(
      <TerminalXtermHost
        sessionId="test-session-reset-binary"
        tileKind="terminal"
        instanceId="test-instance-reset-binary"
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
        chrome="padded"
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

    const snapshotBytes = new TextEncoder().encode("hello world\x1b[6n");

    getWriter()({
      kind: "snapshot",
      chunk: snapshotBytes,
      cols: 80,
      rows: 24,
      onAckable: () => {},
    });
    getWriter()({ kind: "live", chunk: "\x1b[6n", onAckable: () => {} });
    const afterFirst = inputReports.at(-1);
    expect(afterFirst).toBeDefined();

    // Reconnect: the SAME bytes replayed. With a correctly-prepended reset
    // the cursor lands in the same spot; without one (or with corrupted
    // reset bytes) it would append after the first copy or garble entirely.
    getWriter()({
      kind: "snapshot",
      chunk: snapshotBytes,
      cols: 80,
      rows: 24,
      onAckable: () => {},
    });
    getWriter()({ kind: "live", chunk: "\x1b[6n", onAckable: () => {} });
    const afterReconnect = inputReports.at(-1);

    expect(afterReconnect).toBe(afterFirst);
  });

  it("focuses the active terminal when a retained hidden pane becomes visible", async () => {
    const { rerender } = render(
      <PaneVisibilityContext.Provider value={false}>
        <TerminalXtermHost
          sessionId="test-session"
          tileKind="terminal"
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane
          findTargetId="terminal:test"
          keepAlive={false}
          chrome="padded"
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
          tileKind="terminal"
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane
          findTargetId="terminal:test"
          keepAlive={false}
          chrome="padded"
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
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
        chrome="padded"
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
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
        chrome="padded"
      />,
    );

    await waitFor(() => {
      expect(xtermMocks.terminals).toHaveLength(1);
    });
    expect(xtermMocks.terminals[0].focus).not.toHaveBeenCalled();

    rerender(
      <TerminalXtermHost
        sessionId="test-session"
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={vi.fn()}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane
        findTargetId="terminal:test"
        keepAlive={false}
        chrome="padded"
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
            tileKind="terminal"
            instanceId="test-instance"
            effectiveCols={80}
            effectiveRows={24}
            onUserInput={vi.fn()}
            onContainerResize={vi.fn()}
            onWriterReady={vi.fn()}
            shouldFocusOnActivePane={active}
            findTargetId={active ? "terminal:test" : null}
            keepAlive={false}
            chrome="padded"
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
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={onUserInput}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
        chrome="padded"
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

  it.each([
    "terminal",
    "terminal-agent",
  ] satisfies readonly TerminalTileFindKind[])(
    "pastes copied file paths through xterm for %s tiles",
    async (tileKind) => {
      const onUserInput = vi.fn();
      const copiedPath = "/Users/tgill/Documents/agent notes.md";
      const copiedFile = new File(["notes"], "agent notes.md", {
        type: "text/markdown",
      });
      runnerHostMocks.resolveDroppedFilePaths.mockResolvedValue([copiedPath]);

      render(
        <TerminalXtermHost
          sessionId="test-session"
          tileKind={tileKind}
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={onUserInput}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane={false}
          findTargetId={null}
          keepAlive={false}
          chrome="padded"
        />,
      );

      const pasteTarget = screen.getByTestId("terminal-xterm-host");

      fireEvent.paste(pasteTarget, {
        clipboardData: {
          types: ["Files"],
          files: [copiedFile],
          items: [],
        },
      });

      await waitFor(() => {
        expect(runnerHostMocks.resolveDroppedFilePaths).toHaveBeenCalledWith([
          copiedFile,
        ]);
        expect(xtermMocks.terminals[0].paste).toHaveBeenCalledWith(
          "/Users/tgill/Documents/agent\\ notes.md",
        );
        expect(onUserInput).toHaveBeenCalledWith(
          "\x1b[200~/Users/tgill/Documents/agent\\ notes.md\x1b[201~",
        );
      });
      expect(xtermMocks.terminals[0].focus).toHaveBeenCalledTimes(1);
    },
  );

  it("copies ephemeral file URL clipboard data into a stable path before pasting", async () => {
    const onUserInput = vi.fn();
    const stablePath =
      "/tmp/traycer-dropped-files/20260603-uuid-Screenshot-2026-06-03-at-1.17.17-AM.png";
    runnerHostMocks.copyDroppedFilePaths.mockResolvedValue([stablePath]);

    render(
      <TerminalXtermHost
        sessionId="test-session"
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={onUserInput}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
        chrome="padded"
      />,
    );

    fireEvent.paste(screen.getByTestId("terminal-xterm-host"), {
      clipboardData: {
        types: ["Files", "text/uri-list"],
        files: [],
        items: [],
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

  it("copies ephemeral file URL drops into a stable path before pasting", async () => {
    const onUserInput = vi.fn();
    const stablePath =
      "/tmp/traycer-dropped-files/20260603-uuid-Screenshot-2026-06-03-at-1.17.17-AM.png";
    runnerHostMocks.copyDroppedFilePaths.mockResolvedValue([stablePath]);

    render(
      <TerminalXtermHost
        sessionId="test-session"
        tileKind="terminal"
        instanceId="test-instance"
        effectiveCols={80}
        effectiveRows={24}
        onUserInput={onUserInput}
        onContainerResize={vi.fn()}
        onWriterReady={vi.fn()}
        shouldFocusOnActivePane={false}
        findTargetId={null}
        keepAlive={false}
        chrome="padded"
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
