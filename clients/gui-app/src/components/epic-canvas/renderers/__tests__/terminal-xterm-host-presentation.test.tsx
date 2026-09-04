import { act, StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  cleanup,
  render as renderUi,
  type RenderResult,
} from "@testing-library/react";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { TerminalXtermHost } from "@/components/epic-canvas/renderers/terminal-tile-xterm";
import {
  __disposeAllXtermHostsForTests,
  __getXtermHostEntryForTests,
  XTERM_CANVAS_DISPOSE_DELAY_MS,
  type XtermHostEntry,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import {
  __getTerminalSessionRegistryForTests,
  disposeAllTerminalSessions,
} from "@/lib/registries/terminal-session-registry";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import { WithTestQueryClient } from "@/__tests__/with-test-query-client";
import { resetTerminalFocusRegistryForTests } from "@/lib/terminals/terminal-focus-registry";

function render(ui: ReactNode): RenderResult {
  return renderUi(ui, { wrapper: WithTestQueryClient });
}

type Disposable = {
  readonly dispose: () => void;
};

type MockCanvasAddonInstance = {
  readonly dispose: Mock;
  readonly clearTextureAtlas: Mock;
  readonly isDisposed: () => boolean;
};

type MockTerminalInstance = {
  readonly refresh: Mock;
  readonly isDisposed: () => boolean;
};

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as MockTerminalInstance[],
  canvasAddons: [] as MockCanvasAddonInstance[],
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
    readonly unicode = { activeVersion: "6", register: vi.fn() };
    readonly textarea = document.createElement("textarea");
    readonly focus = vi.fn(() => this.textarea.focus());
    readonly refresh = vi.fn((_start: number, _end: number) => {
      this.renderListeners.forEach((listener) => {
        listener();
      });
    });
    private readonly dataListeners: Array<(data: string) => void> = [];
    private readonly renderListeners: Array<() => void> = [];
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

    open(container: HTMLElement): void {
      // Measurable so a fit during a renderer swap WOULD reach
      // `onContainerResize` if the engine reported a grid. jsdom boxes are 0x0.
      Object.defineProperty(container, "clientWidth", {
        configurable: true,
        value: 800,
      });
      Object.defineProperty(container, "clientHeight", {
        configurable: true,
        value: 600,
      });
      container.appendChild(this.textarea);
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

    onRender(listener: () => void): Disposable {
      this.renderListeners.push(listener);
      return {
        dispose: vi.fn(() => {
          const index = this.renderListeners.indexOf(listener);
          if (index >= 0) {
            this.renderListeners.splice(index, 1);
          }
        }),
      };
    }

    write(_chunk: string, callback: (() => void) | undefined): void {
      if (callback !== undefined) {
        callback();
      }
    }

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
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

    onDidChangeResults(_listener: () => void): Disposable {
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    proposeDimensions(): { readonly cols: number; readonly rows: number } {
      // Real enough that a fit during a renderer swap WOULD reach
      // `onContainerResize` if the engine reported a grid.
      return { cols: 80, rows: 24 };
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
    readonly clearTextureAtlas = vi.fn();
    readonly dispose = vi.fn(() => {
      this.disposed = true;
    });
    private disposed = false;

    constructor() {
      xtermMocks.canvasAddons.push(this);
    }

    activate(_terminal: unknown): void {}

    isDisposed(): boolean {
      return this.disposed;
    }
  },
}));

function HostUnderVisibility(props: {
  readonly paneVisible: boolean;
  readonly tabSelected: boolean;
  readonly instanceId: string;
  readonly onContainerResize: (cols: number, rows: number) => void;
  readonly keepAlive: boolean;
}): ReactNode {
  return (
    <PaneVisibilityContext value={props.paneVisible}>
      <TabBodySelectedContext value={props.tabSelected}>
        <TerminalXtermHost
          sessionId={`${props.instanceId}-session`}
          hostId="host-1"
          tileKind="terminal"
          instanceId={props.instanceId}
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={props.onContainerResize}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane={false}
          registerImperativeFocus
          findTargetId={null}
          keepAlive={props.keepAlive}
          chrome="padded"
          onTerminalReady={null}
        />
      </TabBodySelectedContext>
    </PaneVisibilityContext>
  );
}

function requireEntry(instanceId: string): XtermHostEntry {
  const entry = __getXtermHostEntryForTests(instanceId);
  if (entry === null) {
    throw new Error(`Expected a registered xterm engine for ${instanceId}`);
  }
  return entry;
}

function createLiveSessionHandle(
  sessionId: string,
): TerminalSessionStoreHandle {
  return createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-1" },
    sessionId,
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind: "terminal",
    streamClientFactory: () => ({
      sendAction: () => undefined,
      close: () => undefined,
    }),
  });
}

function requireCanvasAddon(index: number): MockCanvasAddonInstance {
  const addon = xtermMocks.canvasAddons.at(index);
  if (addon === undefined) {
    throw new Error(`Expected canvas addon at index ${index}`);
  }
  return addon;
}

describe("<TerminalXtermHost /> presentation-gated canvases", () => {
  afterEach(() => {
    cleanup();
    resetTerminalFocusRegistryForTests();
    __disposeAllXtermHostsForTests();
    disposeAllTerminalSessions();
    vi.useRealTimers();
    xtermMocks.terminals.length = 0;
    xtermMocks.canvasAddons.length = 0;
    runnerHostMocks.openExternalLink.mockClear();
    runnerHostMocks.resolveDroppedFilePaths.mockReset();
    runnerHostMocks.resolveDroppedFilePaths.mockResolvedValue([]);
    runnerHostMocks.copyDroppedFilePaths.mockReset();
    runnerHostMocks.copyDroppedFilePaths.mockImplementation((paths) =>
      Promise.resolve(paths),
    );
  });

  it("a host born hidden never allocates a canvas addon", () => {
    const instanceId = "born-hidden-instance";
    expect(__getXtermHostEntryForTests(instanceId)).toBeNull();
    expect(xtermMocks.canvasAddons).toHaveLength(0);

    render(
      <HostUnderVisibility
        paneVisible={false}
        tabSelected
        instanceId={instanceId}
        onContainerResize={vi.fn()}
        keepAlive
      />,
    );

    const entry = requireEntry(instanceId);
    expect(entry.rendererController.currentCanvas()).toBeNull();
    expect(xtermMocks.canvasAddons).toHaveLength(0);
  });

  it("deselection within a visible pane unpresents the canvas and restores it on reselect", () => {
    // Invariant 5: Deselection within a visible pane unpresents.
    vi.useFakeTimers();
    const instanceId = "tab-deselect-instance";
    const onContainerResize = vi.fn();

    const rendered = render(
      <HostUnderVisibility
        paneVisible
        tabSelected
        instanceId={instanceId}
        onContainerResize={onContainerResize}
        keepAlive
      />,
    );

    const entry = requireEntry(instanceId);
    const canvasBefore = entry.rendererController.currentCanvas();
    expect(canvasBefore).not.toBeNull();
    expect(xtermMocks.canvasAddons).toHaveLength(1);

    rendered.rerender(
      <HostUnderVisibility
        paneVisible
        tabSelected={false}
        instanceId={instanceId}
        onContainerResize={onContainerResize}
        keepAlive
      />,
    );

    expect(entry.rendererController.currentCanvas()).toBe(canvasBefore);
    act(() => {
      vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS - 1);
    });
    expect(entry.rendererController.currentCanvas()).toBe(canvasBefore);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(entry.rendererController.currentCanvas()).toBeNull();
    expect(requireCanvasAddon(0).isDisposed()).toBe(true);

    rendered.rerender(
      <HostUnderVisibility
        paneVisible
        tabSelected
        instanceId={instanceId}
        onContainerResize={onContainerResize}
        keepAlive
      />,
    );

    const canvasAfter = entry.rendererController.currentCanvas();
    expect(canvasAfter).not.toBeNull();
    expect(canvasAfter).not.toBe(canvasBefore);
    expect(xtermMocks.canvasAddons).toHaveLength(2);
  });

  it("a kept-alive engine released while presented drops its canvas but keeps the engine", () => {
    // Invariant 2, the RELEASE half. "Unpresented" covers a host that
    // unmounted while presented, not only one whose tile was hidden - and that
    // is the case this whole change exists for: a terminal that was viewed and
    // then left, whose engine the registry deliberately keeps alive. It is
    // also the only test that pins the host passing its presented state to
    // `releaseXtermHost`: hand it `false` and the count is stranded at 1, so
    // no grace is ever armed and the canvas outlives the tile forever.
    vi.useFakeTimers();
    const instanceId = "released-keep-alive-instance";
    const registry = __getTerminalSessionRegistryForTests();
    // A live session handle is what makes `releaseXtermHost` KEEP the engine,
    // so the disposal below is provably the renderer controller's doing and
    // not the engine teardown incidentally taking the canvas with it.
    registry.acquire(
      instanceId,
      () => createLiveSessionHandle(`${instanceId}-session`),
      "host-1",
    );

    const rendered = render(
      <HostUnderVisibility
        paneVisible
        tabSelected
        instanceId={instanceId}
        onContainerResize={vi.fn()}
        keepAlive
      />,
    );

    const entry = requireEntry(instanceId);
    const canvasBefore = entry.rendererController.currentCanvas();
    expect(canvasBefore).not.toBeNull();
    expect(requireCanvasAddon(0).isDisposed()).toBe(false);

    rendered.unmount();

    // The engine survives the unmount (that is what keepAlive means), and so
    // does its canvas for the length of the grace...
    expect(__getXtermHostEntryForTests(instanceId)).toBe(entry);
    expect(entry.rendererController.currentCanvas()).toBe(canvasBefore);
    act(() => {
      vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS - 1);
    });
    expect(entry.rendererController.currentCanvas()).toBe(canvasBefore);

    // ...and no longer. The engine, its buffer and its container stay.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(__getXtermHostEntryForTests(instanceId)).toBe(entry);
    expect(entry.rendererController.currentCanvas()).toBeNull();
    expect(requireCanvasAddon(0).isDisposed()).toBe(true);
    expect(xtermMocks.canvasAddons).toHaveLength(1);
  });

  it("a renderer swap never reports a grid to the host", () => {
    // Invariant 7: No host round-trip.
    vi.useFakeTimers();
    const instanceId = "no-round-trip-instance";
    const onContainerResize = vi.fn();

    const rendered = render(
      <HostUnderVisibility
        paneVisible
        tabSelected
        instanceId={instanceId}
        onContainerResize={onContainerResize}
        keepAlive
      />,
    );

    const entry = requireEntry(instanceId);
    const canvasBefore = entry.rendererController.currentCanvas();
    expect(canvasBefore).not.toBeNull();
    // The spy is live: the initial present's refresh → onRender → fit reports
    // the measurable grid. A later zero is therefore a real observation.
    expect(onContainerResize).toHaveBeenCalled();
    onContainerResize.mockClear();

    rendered.rerender(
      <HostUnderVisibility
        paneVisible
        tabSelected={false}
        instanceId={instanceId}
        onContainerResize={onContainerResize}
        keepAlive
      />,
    );
    act(() => {
      vi.advanceTimersByTime(XTERM_CANVAS_DISPOSE_DELAY_MS);
    });
    expect(entry.rendererController.currentCanvas()).toBeNull();
    expect(onContainerResize).toHaveBeenCalledTimes(0);

    rendered.rerender(
      <HostUnderVisibility
        paneVisible
        tabSelected
        instanceId={instanceId}
        onContainerResize={onContainerResize}
        keepAlive
      />,
    );
    const canvasAfter = entry.rendererController.currentCanvas();
    expect(canvasAfter).not.toBeNull();
    expect(canvasAfter).not.toBe(canvasBefore);
    expect(onContainerResize).toHaveBeenCalledTimes(0);

    entry.live.onContainerResize(99, 40);
    expect(onContainerResize).toHaveBeenCalledTimes(1);
  });

  it("StrictMode double mount keeps the same canvas addon and never disposes it", () => {
    vi.useFakeTimers();
    const instanceId = "strict-mode-instance";

    render(
      <StrictMode>
        <HostUnderVisibility
          paneVisible
          tabSelected
          instanceId={instanceId}
          onContainerResize={vi.fn()}
          keepAlive={false}
        />
      </StrictMode>,
    );

    expect(xtermMocks.canvasAddons).toHaveLength(1);
    const addon = requireCanvasAddon(0);
    expect(addon.isDisposed()).toBe(false);
    const entry = requireEntry(instanceId);
    expect(entry.rendererController.currentCanvas()).toBe(addon);

    expect(() => {
      act(() => {
        vi.runOnlyPendingTimers();
      });
    }).not.toThrow();
    expect(addon.isDisposed()).toBe(false);
    expect(entry.rendererController.currentCanvas()).toBe(addon);
    expect(xtermMocks.canvasAddons).toHaveLength(1);
  });
});
