import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxFrameProps,
  SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import {
  SandboxBridgeHost,
  type SandboxHostContext,
  type SandboxSize,
} from "@/lib/sandbox/bridge-host";
import { CanvasBoardFrame, type CanvasFrameEvents } from "../canvas-frame";
import {
  CanvasNodeContext,
  type CanvasNodeActions,
} from "../canvas-node-context";

type BoardNavigation = {
  readonly search: string;
  readonly hash: string;
  readonly visit: number;
} | null;

const BOARD = "boards/a.html";
const TITLE = "Board A";
const SOURCE: SandboxSource = { kind: "html", html: "<p>board</p>" };

// The real frame boots a sandboxed iframe; the board only needs its size
// callback and the iframe element it hands back through `ref`.
const frameProps = vi.hoisted(() => ({
  current: null as SandboxFrameProps | null,
}));

vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frameProps.current = props;
    return <iframe title={props.title} ref={props.ref} />;
  },
}));

const fitBoardHeight = vi.fn<(path: string, height: number) => void>();
const onSize = vi.fn<(path: string, size: SandboxSize) => void>();

function actionsFor(viewOnly: boolean): CanvasNodeActions {
  return {
    viewOnly,
    selectionEnabled: true,
    panMode: false,
    onAddError: () => undefined,
    sourceForBoard: () => null,
    frameEvents: null,
    renameBoard: () => undefined,
    startPlay: () => undefined,
    stopPlay: () => undefined,
    playingBoard: null,
    commentMode: false,
    fullscreenPath: null,
    navigation: {},
    resize: () => undefined,
    setNoteText: () => undefined,
    updateNote: () => undefined,
    editingNote: null,
    setEditingNote: () => undefined,
    fitBoardHeight,
    fullscreen: () => undefined,
  };
}

const EVENTS: CanvasFrameEvents = {
  onBridge: () => undefined,
  onStatus: () => undefined,
  onEditPointer: () => undefined,
  onSize,
};

function mountBoard(options: {
  readonly actions: CanvasNodeActions | null;
  readonly fullscreen?: boolean;
  readonly viewportHeight: number;
  readonly events?: CanvasFrameEvents;
  readonly navigation?: BoardNavigation;
}): HTMLIFrameElement {
  render(
    <CanvasNodeContext.Provider value={options.actions}>
      <CanvasBoardFrame
        path={BOARD}
        title={TITLE}
        source={SOURCE}
        events={options.events ?? EVENTS}
        fullscreen={options.fullscreen ?? false}
        mode="edit"
        navigation={options.navigation}
      />
    </CanvasNodeContext.Provider>,
  );
  const iframe = screen.getByTitle(TITLE);
  if (!(iframe instanceof HTMLIFrameElement))
    throw new Error("the board did not render an iframe");
  // jsdom has no layout, so the viewport the board is measured against is injected.
  Object.defineProperty(iframe, "clientHeight", {
    configurable: true,
    value: options.viewportHeight,
  });
  return iframe;
}

function reportSize(height: number | null): void {
  const props = frameProps.current;
  if (props === null) throw new Error("the board never rendered a frame");
  props.onSize({ width: 1280, height });
}

const HOST_CONTEXT: SandboxHostContext = {
  theme: "light",
  styles: { variables: {} },
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  platform: "desktop",
};

const liveBridges: SandboxBridgeHost[] = [];

/** A real bridge, as the board's own frame hands the editor through `onBridge`. */
function fakeBridge() {
  const bridge = new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: true,
      nonce: "n",
      forwardedShortcuts: [],
      pages: null,
    },
    hostContext: HOST_CONTEXT,
    hostVersion: "9.9.9",
    post: () => undefined,
    events: {
      onStatus: () => undefined,
      onSize: () => undefined,
      onOpenLink: () => Promise.resolve(true),
      onShortcut: () => undefined,
      onRequestTeardown: () => undefined,
      onScrollGesture: () => undefined,
      onWheel: () => undefined,
    },
    appRequests: null,
  });
  liveBridges.push(bridge);
  const navigateCanvas = vi
    .spyOn(bridge, "navigateCanvas")
    .mockResolvedValue(true);
  const setMode = vi.spyOn(bridge, "setMode").mockResolvedValue(true);
  return { bridge, navigateCanvas, setMode };
}

function stubFrameGeometry(
  iframe: HTMLIFrameElement,
  box: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  client: { readonly width: number; readonly height: number },
): void {
  iframe.getBoundingClientRect = () => ({
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  });
  Object.defineProperty(iframe, "clientWidth", {
    configurable: true,
    value: client.width,
  });
  Object.defineProperty(iframe, "clientHeight", {
    configurable: true,
    value: client.height,
  });
}

beforeEach(() => {
  frameProps.current = null;
  fitBoardHeight.mockReset();
  onSize.mockReset();
});

afterEach(() => {
  cleanup();
  for (const bridge of liveBridges.splice(0)) bridge.dispose();
  vi.restoreAllMocks();
});

describe("CanvasBoardFrame height fit", () => {
  it("writes the page's own height when it is shorter than the board", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(420);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 420);
  });

  it("keeps the nominal height for a page that fills the viewport, within one pixel", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 500 });

    reportSize(499);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 800);
  });

  it("keeps the real height of content that overflows the viewport", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 500 });

    reportSize(2400);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 2400);
  });

  it("fits a page just under the one pixel tolerance", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 500 });

    reportSize(498);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 498);
  });

  it("never writes a height under the 60 pixel board minimum", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(12);

    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 60);
  });

  it("fits once, so the size feedback of the fitted board cannot resize it again", () => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(420);
    reportSize(300);
    reportSize(700);

    expect(fitBoardHeight).toHaveBeenCalledTimes(1);
  });

  it("does not use up the one fit on a size it could not measure against", () => {
    const iframe = mountBoard({
      actions: actionsFor(false),
      viewportHeight: 0,
    });

    reportSize(420);
    expect(fitBoardHeight).not.toHaveBeenCalled();

    Object.defineProperty(iframe, "clientHeight", {
      configurable: true,
      value: 800,
    });
    reportSize(420);
    expect(fitBoardHeight).toHaveBeenCalledExactlyOnceWith(BOARD, 420);
  });

  it.each([
    ["a null height", null],
    ["a non-finite height", Number.NaN],
    ["an infinite height", Number.POSITIVE_INFINITY],
  ])("ignores %s", (_name, height) => {
    mountBoard({ actions: actionsFor(false), viewportHeight: 800 });

    reportSize(height);

    expect(fitBoardHeight).not.toHaveBeenCalled();
  });

  it("leaves a view-only canvas alone", () => {
    mountBoard({ actions: actionsFor(true), viewportHeight: 800 });

    reportSize(420);

    expect(fitBoardHeight).not.toHaveBeenCalled();
  });

  it("leaves a fullscreen board alone, since its frame is the window", () => {
    mountBoard({
      actions: actionsFor(false),
      fullscreen: true,
      viewportHeight: 800,
    });

    reportSize(420);

    expect(fitBoardHeight).not.toHaveBeenCalled();
  });

  it("renders and reports sizes outside a canvas surface", () => {
    mountBoard({ actions: null, viewportHeight: 800 });

    reportSize(420);

    expect(fitBoardHeight).not.toHaveBeenCalled();
    expect(onSize).toHaveBeenCalledWith(BOARD, { width: 1280, height: 420 });
  });

  it.each([
    ["view-only", actionsFor(true), false],
    ["fullscreen", actionsFor(false), true],
    ["detached", null, false],
  ])(
    "still forwards every size to the registry when %s",
    (_name, actions, fullscreen) => {
      mountBoard({ actions, fullscreen, viewportHeight: 800 });

      reportSize(420);
      reportSize(null);

      expect(onSize.mock.calls).toEqual([
        [BOARD, { width: 1280, height: 420 }],
        [BOARD, { width: 1280, height: null }],
      ]);
    },
  );
});

describe("CanvasBoardFrame navigation", () => {
  it("sends the navigation to the bridge once the board is ready", async () => {
    mountBoard({
      actions: actionsFor(false),
      viewportHeight: 800,
      navigation: { search: "", hash: "#pay", visit: 1 },
    });
    const props = frameProps.current;
    if (props === null) throw new Error("the board never rendered a frame");
    const { bridge, navigateCanvas } = fakeBridge();

    act(() => {
      props.onBridge?.(bridge);
    });
    await act(async () => {
      props.onStatus("ready");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigateCanvas).toHaveBeenCalledExactlyOnceWith({
      search: "",
      hash: "#pay",
      visit: 1,
    });
  });

  it("does not re-send a navigation that already landed on the current bridge", async () => {
    mountBoard({
      actions: actionsFor(false),
      viewportHeight: 800,
      navigation: { search: "", hash: "#pay", visit: 1 },
    });
    const props = frameProps.current;
    if (props === null) throw new Error("the board never rendered a frame");
    const { bridge, navigateCanvas } = fakeBridge();
    act(() => {
      props.onBridge?.(bridge);
    });
    await act(async () => {
      props.onStatus("ready");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigateCanvas).toHaveBeenCalledTimes(1);

    // The board becomes ready again (a reload) with the exact same
    // navigation object; it has already landed, so it is not repeated.
    await act(async () => {
      props.onStatus("ready");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigateCanvas).toHaveBeenCalledTimes(1);
  });
});

describe("CanvasBoardFrame zoom gesture", () => {
  function events(
    onZoom: (delta: number, point: { x: number; y: number }) => void,
  ): CanvasFrameEvents {
    return { ...EVENTS, onZoom };
  }

  it("maps a board-local pinch/wheel gesture into the page's own coordinates", () => {
    const onZoom =
      vi.fn<(delta: number, point: { x: number; y: number }) => void>();
    const iframe = mountBoard({
      actions: actionsFor(false),
      viewportHeight: 800,
      events: events(onZoom),
    });
    stubFrameGeometry(
      iframe,
      { left: 100, top: 50, width: 640, height: 400 },
      { width: 1280, height: 800 },
    );
    const props = frameProps.current;
    if (props === null) throw new Error("the board never rendered a frame");

    props.onCanvasZoom?.({ delta: 120, x: 320, y: 200 });

    expect(onZoom).toHaveBeenCalledExactlyOnceWith(120, {
      x: 100 + (320 * 640) / 1280,
      y: 50 + (200 * 400) / 800,
    });
  });

  it("drops the gesture while the board is the fullscreen frame, which has its own handler", () => {
    const onZoom =
      vi.fn<(delta: number, point: { x: number; y: number }) => void>();
    mountBoard({
      actions: actionsFor(false),
      fullscreen: true,
      viewportHeight: 800,
      events: events(onZoom),
    });
    const props = frameProps.current;
    if (props === null) throw new Error("the board never rendered a frame");

    props.onCanvasZoom?.({ delta: 120, x: 10, y: 10 });

    expect(onZoom).not.toHaveBeenCalled();
  });
});
