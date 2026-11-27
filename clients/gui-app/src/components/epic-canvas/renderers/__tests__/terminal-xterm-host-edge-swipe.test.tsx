import "../../../../../__tests__/test-browser-apis";
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
  waitFor,
} from "@testing-library/react";
import { TerminalXtermHost } from "@/components/epic-canvas/renderers/terminal-tile-xterm";
import { __disposeAllXtermHostsForTests } from "@/components/epic-canvas/renderers/xterm-host-registry";
import { SELECT_HOLD_MS } from "@/components/epic-canvas/renderers/terminal-touch/use-terminal-touch-gestures";
import {
  useEdgeNavSwipe,
  type EdgeNavDirection,
} from "@/components/layout/shell/use-edge-nav-swipe";
import { setMobileApp } from "@/lib/mobile-app";

/**
 * The terminal grid is the one surface where a hold-then-drag from the screen
 * edge is a text selection, and a drag from the edge is also the shell's
 * navigation swipe. The grid declares itself the gesture's owner, so the shell
 * stands down and the selection is the terminal's. Driven through the REAL
 * terminal host (its container is built by the host, not by this test), the
 * real touch-gesture hook that sits on it and the real shell recognizer; only
 * the xterm engine is a stand-in. A plain sibling in the same screen keeps its
 * edge swipe, so the stand-down is the grid's and not the shell being dead.
 */
type SelectMock = Mock<(column: number, row: number, length: number) => void>;

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as Array<{ readonly select: SelectMock }>,
}));

vi.mock("@/lib/terminal-theme", () => ({
  useTerminalTheme: () => ({}),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ openExternalLink: vi.fn(() => Promise.resolve()) }),
}));

vi.mock("@/lib/links/open-external-link", () => ({
  useOpenExternalLink: () => ({
    isPending: false,
    mutateAsync: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    readonly buffer = {
      active: {
        baseY: 0,
        length: 24,
        type: "normal" as const,
        viewportY: 0,
        getLine: () => undefined,
      },
    };
    readonly unicode = { activeVersion: "6", register: vi.fn() };
    // An 80x24 grid painted into an 800x480 screen at the origin: 10px cells,
    // 20px rows. `open` mounts it the way xterm mounts its own element.
    readonly element = document.createElement("div");
    readonly select: SelectMock = vi.fn();
    readonly focus = vi.fn();
    readonly selectAll = vi.fn();
    readonly paste = vi.fn();
    readonly hasSelection = vi.fn(() => false);
    readonly clearSelection = vi.fn();
    readonly getSelection = vi.fn(() => "");
    readonly scrollPages = vi.fn();
    readonly scrollToTop = vi.fn();
    readonly scrollToBottom = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      const screen = document.createElement("div");
      screen.className = "xterm-screen";
      screen.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      this.element.appendChild(screen);
      xtermMocks.terminals.push(this);
    }

    loadAddon(addon: { activate: (terminal: unknown) => void } | object): void {
      if ("activate" in addon && typeof addon.activate === "function") {
        addon.activate(this);
      }
    }

    open(container: HTMLElement): void {
      container.appendChild(this.element);
    }

    attachCustomKeyEventHandler(): void {}

    onData(): { dispose: () => void } {
      return { dispose: vi.fn() };
    }

    onRender(): { dispose: () => void } {
      return { dispose: vi.fn() };
    }

    write(): void {}

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }

    refresh(): void {}

    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class MockSearchAddon {
    readonly findNext = vi.fn(() => true);
    readonly findPrevious = vi.fn(() => true);
    readonly clearDecorations = vi.fn();

    onDidChangeResults(): { dispose: () => void } {
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
  WebLinksAddon: class MockWebLinksAddon {},
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss(): { dispose: () => void } {
      return { dispose: vi.fn() };
    }

    clearTextureAtlas(): void {}

    dispose(): void {}
  },
}));

interface ShellProbe {
  readonly navigations: EdgeNavDirection[];
  readonly dragStarts: EdgeNavDirection[];
}

function Shell(props: { readonly probe: ShellProbe }) {
  useEdgeNavSwipe({
    canStart: () => true,
    onDragStart: (direction) => {
      props.probe.dragStarts.push(direction);
      return "instant";
    },
    onDragMove: () => {},
    onDragEnd: () => {},
    onNavigate: (direction) => {
      props.probe.navigations.push(direction);
    },
    edgesClaimed: () => false,
  });
  return null;
}

async function renderScreen(): Promise<{
  readonly probe: ShellProbe;
  readonly grid: Element;
  readonly plain: HTMLElement;
}> {
  const probe: ShellProbe = { navigations: [], dragStarts: [] };
  const view = render(
    <>
      <Shell probe={probe} />
      <div className="relative h-40 w-full">
        <TerminalXtermHost
          sessionId="test-session"
          hostId="host-1"
          tileKind="terminal"
          instanceId="test-instance"
          effectiveCols={80}
          effectiveRows={24}
          onUserInput={vi.fn()}
          onContainerResize={vi.fn()}
          onWriterReady={vi.fn()}
          shouldFocusOnActivePane={false}
          registerImperativeFocus
          findTargetId={null}
          keepAlive={false}
          chrome="padded"
          onTerminalReady={null}
        />
      </div>
      <div data-testid="plain" />
    </>,
  );
  await waitFor(() => {
    expect(view.container.querySelector(".xterm-screen")).not.toBeNull();
  });
  const grid = view.container.querySelector(".xterm-screen");
  if (grid === null) throw new Error("the terminal grid never mounted");
  return { probe, grid, plain: view.getByTestId("plain") };
}

const FINGER = { pointerType: "touch", isPrimary: true, pointerId: 1 };

function touchEvent(target: Element, type: string, clientX: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX, clientY: 45 };
  Object.defineProperty(event, "touches", {
    value: Object.assign([point], { item: () => point }),
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("the terminal grid at the screen edge", () => {
  beforeEach(() => {
    setMobileApp(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    __disposeAllXtermHostsForTests();
    xtermMocks.terminals.length = 0;
    setMobileApp(false);
  });

  it("selects on a hold-then-drag from the leading edge and starts no navigation", async () => {
    const { probe, grid } = await renderScreen();
    const select = xtermMocks.terminals.at(0)?.select;
    if (select === undefined) throw new Error("no terminal was created");
    vi.useFakeTimers();

    act(() => {
      fireEvent.pointerDown(grid, { ...FINGER, clientX: 8, clientY: 45 });
    });
    act(() => {
      vi.advanceTimersByTime(SELECT_HOLD_MS);
    });
    act(() => {
      fireEvent.pointerMove(grid, { ...FINGER, clientX: 68, clientY: 45 });
    });

    // Anchor: column 0, screen row 2. Head: column 6.
    expect(select).toHaveBeenLastCalledWith(0, 2, 7);
    expect(probe.dragStarts).toEqual([]);
    expect(probe.navigations).toEqual([]);
  });

  it("leaves the touch stream to the grid rather than reserving it for the shell", async () => {
    const { grid } = await renderScreen();

    touchEvent(grid, "touchstart", 8);
    const move = touchEvent(grid, "touchmove", 68);

    expect(move.defaultPrevented).toBe(false);
  });

  // The control: the same screen, the same edge, a surface that owns nothing.
  it("still navigates and reserves the touch for a plain surface beside it", async () => {
    const { probe, plain } = await renderScreen();

    touchEvent(plain, "touchstart", 8);
    const move = touchEvent(plain, "touchmove", 68);
    act(() => {
      fireEvent.pointerDown(plain, { ...FINGER, clientX: 8, clientY: 45 });
      fireEvent.pointerMove(plain, { ...FINGER, clientX: 68, clientY: 45 });
    });

    expect(move.defaultPrevented).toBe(true);
    expect(probe.navigations).toEqual(["back"]);
  });

  // The marker exists for the phone shell's swipe. Outside the installed app
  // there is no such recognizer, and a surface that claims the gesture there
  // would only change how a desktop browser treats a horizontal pan.
  it("does not mark the grid as a gesture owner outside the installed app", async () => {
    setMobileApp(false);
    const { grid } = await renderScreen();

    expect(grid.closest("[data-history-gesture-owner]")).toBeNull();
  });

  it("marks the host's own container as the gesture owner inside the installed app", async () => {
    const { grid } = await renderScreen();

    expect(
      grid
        .closest("[data-terminal-host]")
        ?.hasAttribute("data-history-gesture-owner"),
    ).toBe(true);
  });
});
