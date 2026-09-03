import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderPeekTile } from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  runnerOpenExternalLinkModule,
  tileRoleRunnerHostModule,
  type FakeStreamSession,
  PEEK_NODE,
  epicNestedFocusNavigationModule,
  hostDirectoryEntryModule,
  liveStream as fixtureLiveStream,
  streamAuthRevalidatorModule,
  tabHostIdModule,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/browser-tile/browser-peek-tile";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  streamClientFactory: null as (() => FakeStreamClient | null) | null,
  visible: true,
}));

vi.mock("@/providers/use-runner-host", () => tileRoleRunnerHostModule());

vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);

vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () =>
    hookState.streamClientFactory === null
      ? hookState.streamClient
      : hookState.streamClientFactory(),
}));

vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () =>
  epicNestedFocusNavigationModule(),
);

function peekTile(): HTMLElement {
  return screen.getByTestId(`browser-peek-tile-${PEEK_NODE.instanceId}`);
}

/** Latest stream session (React StrictMode remount may open more than one). */
function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
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

    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Too many re-renders"),
    );
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Maximum update depth exceeded"),
    );
  });

  it("renders JPEG frames and acks on arrival, before the image is presented", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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

    // Ack fires the moment the frame arrives over the wire - the host gates
    // its next capture on it, and waiting for paint would outrun the host.
    expect(stream.sentFrames).toContainEqual({
      kind: "ack",
      hasBinaryPayload: false,
      sequence: 7,
    });
    expect(screen.getByAltText("Browser screencast").getAttribute("src")).toBe(
      "data:image/jpeg;base64,AQID",
    );

    const ackCountBeforePaint = stream.sentFrames.filter(
      (frame) => frame.kind === "ack",
    ).length;
    fireEvent.load(screen.getByAltText("Browser screencast"));

    // Paint does not ack again - it only latches the presented sequence.
    expect(
      stream.sentFrames.filter((frame) => frame.kind === "ack"),
    ).toHaveLength(ackCountBeforePaint);
  });

  it("renders a terminal screencast frame", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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

  it("reads a native-handoff complete frame as a handoff spinner, not a dead cast", () => {
    // `completeMeans="native-handoff"`: this client is the one placing the
    // native tab, so the host's `complete` frame (browser-screencast-plane.ts's
    // `subscribeScreencast`) means "attached, going native" - pins existing
    // behavior for the electron-capable client (browser-session-tile.tsx's
    // `browserPeekCompleteMeaning`).
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="native-handoff"
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

    expect(screen.getByText("Going native")).toBeTruthy();
    expect(screen.getByText("Handing off to the native tab.")).toBeTruthy();
    expect(screen.queryByText("Ended")).toBeNull();
  });

  it("reads a native-elsewhere complete frame as an honest terminal state, not a handoff spinner", () => {
    // `completeMeans="native-elsewhere"`: a client with no native window of
    // its own for the session's host (e.g. a viewer-only client, or an
    // electron-capable client on a DIFFERENT host than the session's) gets the
    // same `complete` frame for a tab that will never stream here. It must not
    // read as "Going native" (nothing is arriving) nor as "Ended" (the tab is
    // not dead, it is just unreachable from this client).
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="native-elsewhere"
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

    expect(screen.getByText("Open natively")).toBeTruthy();
    expect(
      screen.getByText(
        "This tab is open in the desktop app on that host, so it can't be streamed here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Going native")).toBeNull();
    expect(screen.queryByText("Ended")).toBeNull();
  });

  it("ignores callbacks from a replaced screencast subscription", () => {
    const rendered = renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const retired = liveStream();
    hookState.visible = false;
    rendered.rerender(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    hookState.visible = true;
    rendered.rerender(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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

  it("pre-arms on hover and stops re-claiming once the host denies it", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    const controls = screen.getByRole("button", {
      name: "Browser screencast controls",
    });

    fireEvent.pointerEnter(controls);
    expect(stream.sentFrames).toContainEqual({
      kind: "preArm",
      hasBinaryPayload: false,
      armEpoch: 1,
    });

    act(() => {
      stream.emit(
        {
          kind: "revoked",
          hasBinaryPayload: false,
          armEpoch: 1,
          cause: "denied",
        },
        null,
      );
    });
    fireEvent.pointerLeave(controls);
    fireEvent.pointerEnter(controls);

    // Someone else is driving: hovering across the tile must not storm the
    // control plane with claims that will be refused again.
    expect(
      stream.sentFrames.filter((frame) => frame.kind === "preArm"),
    ).toHaveLength(1);
    expect(controls.className).not.toContain("ring-primary");
  });

  it("shows no control chrome for a hover pre-arm and lights it on the click", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();
    const controls = screen.getByRole("button", {
      name: "Browser screencast controls",
    });

    fireEvent.pointerEnter(controls);
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });

    // The claim is granted, but hovering is not controlling.
    expect(screen.queryByText("Controlling")).toBeNull();
    expect(peekTile().querySelector(".ring-primary")).toBeNull();

    fireEvent.pointerDown(controls, {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      button: 0,
      buttons: 1,
    });

    // No second arm round trip: the claim it needed was already there.
    expect(
      stream.sentFrames.filter((frame) => frame.kind === "arm"),
    ).toHaveLength(0);
    expect(screen.getByText("Controlling")).not.toBeNull();
    expect(peekTile().querySelector(".ring-primary")).not.toBeNull();
  });

  it("ignores an armed ack that arrives after an explicit Release", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
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
    const { rerender } = renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    hookState.visible = false;
    rerender(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );

    expect(stream.closed).toBe(true);
    expect(hookState.streamClient?.subscribes).toHaveLength(1);
  });

  it("coalesces tile viewport changes with a trailing 200ms debounce", async () => {
    vi.useFakeTimers();
    try {
      renderPeekTile(
        <BrowserPeekTile
          scope={{ kind: "epic", epicId: "epic-1" }}
          visible={hookState.visible}
          onConvertToPip={() => {}}
          node={PEEK_NODE}
          completeMeans="ended"
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

  it("restates the measured viewport once a stream that was still dialing opens", async () => {
    vi.useFakeTimers();
    try {
      // The field case: the tile is laid out and measured while the transport
      // is still completing its subscribe handshake, which drops everything it
      // is handed. Nothing resizes afterwards, so without a restatement at
      // `open` the host serves the whole round on its last-tile-close defaults.
      hookState.streamClient = new FakeStreamClient(false);
      renderPeekTile(
        <BrowserPeekTile
          scope={{ kind: "epic", epicId: "epic-1" }}
          visible={hookState.visible}
          onConvertToPip={() => {}}
          node={PEEK_NODE}
          completeMeans="ended"
        />,
      );
      const stream = liveStream();
      const observer = controllableResizeObservers.at(-1);
      if (observer === undefined) throw new Error("expected resize observer");

      observer.emit(1272, 800);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(
        stream.sentFrames.filter((frame) => frame.kind === "viewport"),
      ).toEqual([]);

      act(() => {
        stream.emitStatus("open");
      });

      expect(
        stream.sentFrames.filter((frame) => frame.kind === "viewport"),
      ).toEqual([
        {
          kind: "viewport",
          hasBinaryPayload: false,
          width: 1272,
          height: 800,
          dpr: window.devicePixelRatio,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Ticket 18's viewer-side half of the RTT probe: the tile answers every
 * `rttProbe` the host sends with exactly one `rttProbeAck` carrying the same
 * `probeId`, and doing so must not disturb any other frame handling on the
 * same subscription.
 */
describe("BrowserPeekTile rttProbe handling", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    hookState.streamClientFactory = null;
  });

  afterEach(() => {
    cleanup();
    hookState.streamClientFactory = null;
  });

  it("answers an rttProbe with exactly one rttProbeAck carrying the same probeId", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    act(() => {
      stream.emit(
        {
          kind: "rttProbe",
          hasBinaryPayload: false,
          probeId: 42,
          controlPlaneRttMs: 120,
        },
        null,
      );
    });

    expect(
      stream.sentFrames.filter((frame) => frame.kind === "rttProbeAck"),
    ).toEqual([{ kind: "rttProbeAck", hasBinaryPayload: false, probeId: 42 }]);
  });

  it("does not disturb other frame handling on the same subscription", () => {
    renderPeekTile(
      <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
        visible={hookState.visible}
        onConvertToPip={() => {}}
        node={PEEK_NODE}
        completeMeans="ended"
      />,
    );
    const stream = liveStream();

    act(() => {
      stream.emit(
        {
          kind: "rttProbe",
          hasBinaryPayload: false,
          probeId: 1,
          controlPlaneRttMs: null,
        },
        null,
      );
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

    expect(stream.sentFrames).toContainEqual({
      kind: "rttProbeAck",
      hasBinaryPayload: false,
      probeId: 1,
    });
    expect(stream.sentFrames).toContainEqual({
      kind: "ack",
      hasBinaryPayload: false,
      sequence: 7,
    });
    expect(screen.getByAltText("Browser screencast").getAttribute("src")).toBe(
      "data:image/jpeg;base64,AQID",
    );

    // A second probe still answers exactly once each, never a duplicate ack.
    act(() => {
      stream.emit(
        {
          kind: "rttProbe",
          hasBinaryPayload: false,
          probeId: 2,
          controlPlaneRttMs: 150,
        },
        null,
      );
    });
    expect(
      stream.sentFrames.filter((frame) => frame.kind === "rttProbeAck"),
    ).toEqual([
      { kind: "rttProbeAck", hasBinaryPayload: false, probeId: 1 },
      { kind: "rttProbeAck", hasBinaryPayload: false, probeId: 2 },
    ]);
  });
});
