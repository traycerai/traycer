import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserPeekTile,
  type BrowserPeekNode,
} from "@/components/epic-canvas/renderers/browser-peek-tile";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  streamClientFactory: null as (() => FakeStreamClient | null) | null,
  visible: true,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-test",
}));

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => hookState.visible,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ hostId: "host-test" }),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () =>
    hookState.streamClientFactory === null
      ? hookState.streamClient
      : hookState.streamClientFactory(),
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () =>
    (_epicId: string, _tabId: string, prepare: () => unknown): unknown =>
      prepare(),
}));

/** Latest stream session (React StrictMode remount may open more than one). */
function liveStream(): FakeStreamSession {
  const sessions = hookState.streamClient?.sessions ?? [];
  const stream = sessions.at(-1);
  if (stream === undefined) {
    throw new Error("expected browser.sessions stream");
  }
  return stream;
}

let controllableResizeObservers: ControllableResizeObserver[] = [];

function resizeEntry(
  target: Element,
  width: number,
  height: number,
): ResizeObserverEntry {
  const contentRect = {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
  return {
    target,
    contentRect,
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
}

class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    controllableResizeObservers.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  emit(width: number, height: number): void {
    const target = this.observed.values().next().value;
    if (!(target instanceof Element)) return;
    this.callback([resizeEntry(target, width, height)], this);
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

const PEEK_NODE: BrowserPeekNode = {
  id: "browser-peek-headless-1",
  instanceId: "peek-instance-1",
  hostId: "host-test",
  sessionId: "headless-1",
  tabId: "headless-tab-1",
  initialUrl: "http://localhost:3000",
};

function armPeekTile(stream: FakeStreamSession): void {
  fireEvent.focus(
    screen.getByRole("button", { name: "Browser screencast controls" }),
  );
  act(() => {
    stream.emit({ kind: "armed", hasBinaryPayload: false, armEpoch: 1 }, null);
  });
}

describe("BrowserPeekTile", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    hookState.streamClientFactory = null;
    controllableResizeObservers = [];
  });

  afterEach(() => {
    cleanup();
    hookState.streamClientFactory = null;
  });

  it("does not dispatch during render when the peek stream client identity churns", () => {
    hookState.streamClientFactory = () => new FakeStreamClient(false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });

    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Too many re-renders"),
    );
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Maximum update depth exceeded"),
    );
  });

  it("renders JPEG frames and acks only after the image is presented", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    act(() => {
      stream.emitStatus("open");
      stream.emit(
        {
          kind: "started",
          hasBinaryPayload: false,
          frameWidth: 800,
          frameHeight: 600,
          deviceScaleFactor: 1,
        },
        null,
      );
      stream.emit(
        {
          kind: "frame",
          hasBinaryPayload: true,
          sequence: 7,
          metadata: {
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: 800,
            deviceHeight: 600,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            timestamp: 1,
          },
        },
        new Uint8Array([1, 2, 3]),
      );
    });

    expect(screen.getByAltText("Browser screencast").getAttribute("src")).toBe(
      "data:image/jpeg;base64,AQID",
    );
    expect(stream.sentFrames).not.toContainEqual({
      kind: "ack",
      hasBinaryPayload: false,
      sequence: 7,
    });

    fireEvent.load(screen.getByAltText("Browser screencast"));

    expect(stream.sentFrames).toContainEqual({
      kind: "ack",
      hasBinaryPayload: false,
      sequence: 7,
    });
  });

  it("renders a terminal screencast frame", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();

    act(() => {
      stream.emit(
        {
          kind: "complete",
          hasBinaryPayload: false,
        },
        null,
      );
    });

    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.getByText("Screencast ended.")).toBeTruthy();
  });

  it("ignores callbacks from a replaced screencast subscription", () => {
    const rendered = render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const retired = liveStream();
    hookState.visible = false;
    rendered.rerender(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    hookState.visible = true;
    rendered.rerender(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const current = liveStream();
    expect(current).not.toBe(retired);
    act(() => {
      current.emit({ kind: "complete", hasBinaryPayload: false }, null);
      retired.emit(
        {
          kind: "started",
          hasBinaryPayload: false,
          frameWidth: 800,
          frameHeight: 600,
          deviceScaleFactor: 1,
        },
        null,
      );
      retired.emitStatus("closed");
    });

    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.getByText("Screencast ended.")).toBeTruthy();
  });

  it("ignores an armed ack that arrives after blur disarmed the tile", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    const controls = screen.getByRole("button", {
      name: "Browser screencast controls",
    });

    fireEvent.focus(controls);
    expect(stream.sentFrames).toContainEqual({
      kind: "arm",
      hasBinaryPayload: false,
      armEpoch: 1,
    });
    fireEvent.blur(controls);
    expect(stream.sentFrames).toContainEqual({
      kind: "disarm",
      hasBinaryPayload: false,
      armEpoch: 1,
    });
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });

    expect(controls.className).not.toContain("ring-primary");
    fireEvent.keyDown(controls, { code: "KeyA", key: "a" });
    expect(stream.sentFrames).not.toContainEqual(
      expect.objectContaining({ kind: "keyboard" }),
    );
  });

  it("renders an alert overlay and responds with its generation", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 7,
          type: "alert",
          message: "Alert message",
          defaultValue: "",
        },
        null,
      );
    });

    expect(
      screen.getByRole("dialog", { name: "alert dialog" }).textContent,
    ).toContain("Alert message");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(stream.sentFrames).toContainEqual({
      kind: "dialogResponse",
      hasBinaryPayload: false,
      armEpoch: 1,
      generation: 7,
      accept: true,
      promptText: null,
    });
  });

  it("renders confirm and prompt overlays with dismiss and prompt responses", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 8,
          type: "confirm",
          message: "Confirm message",
          defaultValue: "",
        },
        null,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stream.sentFrames).toContainEqual({
      kind: "dialogResponse",
      hasBinaryPayload: false,
      armEpoch: 1,
      generation: 8,
      accept: false,
      promptText: null,
    });

    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 9,
          type: "prompt",
          message: "Prompt message",
          defaultValue: "initial value",
        },
        null,
      );
    });
    const prompt = screen.getByRole("textbox", { name: "Prompt response" });
    if (!(prompt instanceof HTMLInputElement)) {
      throw new Error("expected prompt input");
    }
    expect(prompt.value).toBe("initial value");
    fireEvent.change(prompt, { target: { value: "typed value" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(stream.sentFrames).toContainEqual({
      kind: "dialogResponse",
      hasBinaryPayload: false,
      armEpoch: 1,
      generation: 9,
      accept: true,
      promptText: "typed value",
    });
  });

  it("drops stale dialog generations before presenting or responding", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 11,
          type: "confirm",
          message: "Current dialog",
          defaultValue: "",
        },
        null,
      );
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 10,
          type: "confirm",
          message: "Stale dialog",
          defaultValue: "",
        },
        null,
      );
    });

    expect(screen.getByText("Current dialog")).toBeTruthy();
    expect(screen.queryByText("Stale dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(stream.sentFrames).toContainEqual(
      expect.objectContaining({
        kind: "dialogResponse",
        generation: 11,
      }),
    );
    expect(stream.sentFrames).not.toContainEqual(
      expect.objectContaining({
        kind: "dialogResponse",
        generation: 10,
      }),
    );
  });

  it("clears only the matching text-free dialog settlement", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 7,
          type: "confirm",
          message: "Current dialog",
          defaultValue: "",
        },
        null,
      );
      stream.emit(
        {
          kind: "dialogSettled",
          hasBinaryPayload: false,
          generation: 6,
        },
        null,
      );
    });

    expect(screen.getByText("Current dialog")).toBeTruthy();
    act(() => {
      stream.emit(
        {
          kind: "dialogSettled",
          hasBinaryPayload: false,
          generation: 7,
        },
        null,
      );
    });
    expect(screen.queryByText("Current dialog")).toBeNull();
  });

  it("resets control state on reconnect, re-arms with a fresh epoch, and accepts a low dialog generation", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    act(() => {
      stream.emit(
        {
          kind: "started",
          hasBinaryPayload: false,
          frameWidth: 800,
          frameHeight: 600,
          deviceScaleFactor: 1,
        },
        null,
      );
      stream.emit(
        {
          kind: "frame",
          hasBinaryPayload: true,
          sequence: 7,
          metadata: {
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: 800,
            deviceHeight: 600,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            timestamp: 1,
          },
        },
        new Uint8Array([1, 2, 3]),
      );
    });
    fireEvent.load(screen.getByAltText("Browser screencast"));
    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 9,
          type: "confirm",
          message: "Old dialog",
          defaultValue: "",
        },
        null,
      );
    });
    expect(screen.getByText("Old dialog")).toBeTruthy();
    const controls = screen.getByRole("button", {
      name: "Browser screencast controls",
    });
    const tile = screen.getByTestId(
      `browser-peek-tile-${PEEK_NODE.instanceId}`,
    );
    const image = screen.getByAltText("Browser screencast");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );

    act(() => {
      stream.emitStatus("reconnecting");
    });
    expect(tile.querySelector(".ring-primary")).toBeNull();
    expect(screen.queryByText("Old dialog")).toBeNull();

    act(() => {
      stream.emitStatus("open");
    });
    expect(stream.sentFrames).toContainEqual({
      kind: "arm",
      hasBinaryPayload: false,
      armEpoch: 2,
    });
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 2 },
        null,
      );
    });
    fireEvent.pointerDown(controls, {
      clientX: 400,
      clientY: 300,
      button: 0,
      buttons: 1,
    });
    expect(stream.sentFrames).not.toContainEqual(
      expect.objectContaining({ kind: "pointer" }),
    );

    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 1,
          type: "alert",
          message: "Reconnected dialog",
          defaultValue: "",
        },
        null,
      );
    });
    expect(screen.getByText("Reconnected dialog")).toBeTruthy();
  });

  it("sends one insertText frame for a local CJK composition and shows its indicator", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    armPeekTile(stream);
    const input = screen.getByRole("textbox", { name: "Browser IME input" });

    fireEvent.compositionStart(input);
    expect(screen.getByText("Composing text…")).toBeTruthy();
    fireEvent.input(input, { target: { value: "に" } });
    expect(
      stream.sentFrames.filter(
        (frame) => frame.kind === "keyboard" || frame.kind === "insertText",
      ),
    ).toEqual([]);

    fireEvent.compositionEnd(input, { data: "日本語" });

    expect(screen.queryByText("Composing text…")).toBeNull();
    expect(
      stream.sentFrames.filter((frame) => frame.kind === "keyboard"),
    ).toEqual([]);
    expect(
      stream.sentFrames.filter((frame) => frame.kind === "insertText"),
    ).toEqual([
      expect.objectContaining({
        kind: "insertText",
        hasBinaryPayload: false,
        armEpoch: 1,
        seq: 0,
        text: "日本語",
      }),
    ]);
  });

  it("does not keep a screencast subscription while the tile is hidden", () => {
    const { rerender } = render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();

    hookState.visible = false;
    rerender(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );

    expect(stream.closed).toBe(true);
    expect(hookState.streamClient?.subscribes).toHaveLength(1);
  });

  it("coalesces tile viewport changes with a trailing 200ms debounce", async () => {
    vi.useFakeTimers();
    try {
      render(
        <BrowserPeekTile
          viewTabId="view-tab-1"
          paneId="pane-1"
          epicId="epic-1"
          node={PEEK_NODE}
        />,
      );
      const stream = liveStream();
      const observer = controllableResizeObservers.at(-1);
      if (observer === undefined) throw new Error("expected resize observer");

      observer.emit(320, 240);
      observer.emit(640, 360);
      observer.emit(720, 400);
      expect(
        stream.sentFrames.filter((frame) => frame.kind === "viewport"),
      ).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(199);
      });
      expect(
        stream.sentFrames.filter((frame) => frame.kind === "viewport"),
      ).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(
        stream.sentFrames.filter((frame) => frame.kind === "viewport"),
      ).toEqual([
        {
          kind: "viewport",
          hasBinaryPayload: false,
          width: 720,
          height: 400,
          dpr: window.devicePixelRatio,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
