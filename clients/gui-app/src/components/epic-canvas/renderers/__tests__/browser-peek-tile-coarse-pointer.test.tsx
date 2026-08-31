import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  PEEK_NODE,
  hostDirectoryEntryModule,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  tileBodyVisibleModule,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/epic-canvas/renderers/browser-peek-tile";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// The one fork this file exercises: a coarse pointer picks the touch handler
// bag and the compact chrome inside the single tile.
vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => true,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () =>
  tileBodyVisibleModule(hookState),
);

vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

vi.mock("@/hooks/host/use-host-stream-client-for", () =>
  hostStreamClientForWithAuthModule(hookState),
);

vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function overlayButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browser screencast controls" });
}

function framesOfKind(
  stream: FakeStreamSession,
  kind: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter((frame) => frame.kind === kind);
}

function emitStarted(stream: FakeStreamSession): void {
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
}

function emitJpegFrame(
  stream: FakeStreamSession,
  sequence: number,
  bytes: Uint8Array,
): void {
  stream.emit(
    {
      kind: "frame",
      hasBinaryPayload: true,
      sequence,
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
    bytes,
  );
}

function loadScreencastImage(): HTMLImageElement {
  const image = screen.getByAltText<HTMLImageElement>("Browser screencast");
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  fireEvent.load(image);
  return image;
}

function presentLiveFrame(
  stream: FakeStreamSession,
  sequence: number,
  bytes: Uint8Array,
): HTMLImageElement {
  act(() => {
    emitStarted(stream);
    emitJpegFrame(stream, sequence, bytes);
  });
  return loadScreencastImage();
}

/**
 * Focusing the overlay button re-focuses the hidden IME input (same relay the
 * desktop tile uses), which arms - identical handshake for both viewers, so
 * this mirrors `browser-peek-tile-chrome.test.tsx`'s `armPeekTile` rather
 * than simulating a tap for it (a tap before the arm epoch exists is
 * buffered pending a matching up, so it would not resolve here anyway).
 */
function armPeekTile(stream: FakeStreamSession): void {
  fireEvent.focus(overlayButton());
  act(() => {
    stream.emit({ kind: "armed", hasBinaryPayload: false, armEpoch: 1 }, null);
  });
}

function installAnimationFrameQueue(): {
  readonly runNextFrame: () => void;
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
    runNextFrame: () => {
      const entry = Array.from(callbacks.entries()).at(0);
      if (entry === undefined) {
        throw new Error("Expected a pending animation frame.");
      }
      const [handle, callback] = entry;
      callbacks.delete(handle);
      callback(0);
    },
  };
}

describe("BrowserPeekTile on a coarse pointer", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("a tap sends pointer down/up frames with normalized coords", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    presentLiveFrame(stream, 7, new Uint8Array([1, 2, 3]));

    armPeekTile(stream);

    // Once armed, a tap sends discrete down/up frames immediately.
    fireEvent.pointerDown(overlayButton(), {
      pointerId: 2,
      pointerType: "touch",
      clientX: 200,
      clientY: 300,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerUp(overlayButton(), {
      pointerId: 2,
      pointerType: "touch",
      clientX: 200,
      clientY: 300,
      button: 0,
      buttons: 0,
    });

    const pointerFrames = framesOfKind(stream, "pointer");
    const downs = pointerFrames.filter((frame) => frame.type === "down");
    const ups = pointerFrames.filter((frame) => frame.type === "up");
    expect(downs.length).toBeGreaterThanOrEqual(1);
    expect(ups.length).toBeGreaterThanOrEqual(1);
    const secondDown = downs.at(-1);
    expect(secondDown).toMatchObject({ normalizedX: 0.25, normalizedY: 0.5 });
  });

  it("a drag while armed sends wheel deltas instead of pointer moves", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    presentLiveFrame(stream, 7, new Uint8Array([1, 2, 3]));
    armPeekTile(stream);

    const rafQueue = installAnimationFrameQueue();
    fireEvent.pointerDown(overlayButton(), {
      pointerId: 3,
      pointerType: "touch",
      clientX: 100,
      clientY: 300,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerMove(overlayButton(), {
      pointerId: 3,
      pointerType: "touch",
      clientX: 100,
      clientY: 260,
      button: 0,
      buttons: 1,
    });
    act(() => {
      rafQueue.runNextFrame();
    });
    fireEvent.pointerUp(overlayButton(), {
      pointerId: 3,
      pointerType: "touch",
      clientX: 100,
      clientY: 260,
      button: 0,
      buttons: 0,
    });

    const pointerFrames = framesOfKind(stream, "pointer");
    const wheelFrames = pointerFrames.filter((frame) => frame.type === "wheel");
    const moveFrames = pointerFrames.filter((frame) => frame.type === "move");
    const downFrames = pointerFrames.filter((frame) => frame.type === "down");
    const upFrames = pointerFrames.filter((frame) => frame.type === "up");
    expect(moveFrames).toHaveLength(0);
    // A scroll must never bracket itself with down/up - Chrome would
    // synthesize a click from that pair and scrolling past a link would
    // navigate.
    expect(downFrames).toHaveLength(0);
    expect(upFrames).toHaveLength(0);
    expect(wheelFrames).toHaveLength(1);
    expect(wheelFrames[0]).toMatchObject({ deltaX: 0, deltaY: 40 });
  });

  it("a disarm mid-gesture drops the buffered touch instead of leaking a drag", () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    presentLiveFrame(stream, 7, new Uint8Array([1, 2, 3]));
    armPeekTile(stream);

    fireEvent.pointerDown(overlayButton(), {
      pointerId: 4,
      pointerType: "touch",
      clientX: 100,
      clientY: 300,
      button: 0,
      buttons: 1,
    });

    // Host revokes the arm mid-gesture (e.g. another surface took control).
    act(() => {
      stream.emit(
        { kind: "revoked", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });

    fireEvent.pointerMove(overlayButton(), {
      pointerId: 4,
      pointerType: "touch",
      clientX: 100,
      clientY: 200,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerUp(overlayButton(), {
      pointerId: 4,
      pointerType: "touch",
      clientX: 100,
      clientY: 200,
      button: 0,
      buttons: 0,
    });

    const pointerFrames = framesOfKind(stream, "pointer");
    expect(pointerFrames).toHaveLength(0);
  });

  it("nav bar reflects navState", () => {
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
          kind: "navState",
          hasBinaryPayload: false,
          url: "https://example.com/path",
          canGoBack: true,
          canGoForward: false,
          loading: false,
        },
        null,
      );
    });

    expect(
      screen.getByTestId("browser-tile-toolbar-compact").textContent,
    ).toContain("https://example.com/path");
    expect(
      screen.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // A nav action arms first (queued until the host confirms) and only then
    // sends - same handshake `armPeekTile` drives for input.
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    expect(framesOfKind(stream, "goBack")).toHaveLength(1);
  });

  it("a dialog renders as a sheet and answers dialogResponse", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={PEEK_NODE}
      />,
    );
    const stream = liveStream();
    presentLiveFrame(stream, 7, new Uint8Array([1, 2, 3]));
    armPeekTile(stream);

    act(() => {
      stream.emit(
        {
          kind: "dialogOpened",
          hasBinaryPayload: false,
          generation: 1,
          type: "confirm",
          message: "Leave the page?",
          defaultValue: "",
        },
        null,
      );
    });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Confirm" }).textContent,
      ).toContain("Leave the page?");
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    const responses = framesOfKind(stream, "dialogResponse");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ generation: 1, accept: true });
  });
});
