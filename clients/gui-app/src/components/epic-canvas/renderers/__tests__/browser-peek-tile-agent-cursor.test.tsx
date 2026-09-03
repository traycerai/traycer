import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderPeekTile } from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  runnerOpenExternalLinkModule,
  tileRoleRunnerHostModule,
  type FakeStreamSession,
  epicNestedFocusNavigationModule,
  fakeMediaPeerModule,
  fakeMediaStream,
  hostDirectoryEntryModule,
  liveStream as fixtureLiveStream,
  makeFreshPeekNode,
  streamAuthRevalidatorModule,
  tabHostIdModule,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import {
  BrowserPeekTile,
  type BrowserPeekNode,
} from "@/components/browser-tile/browser-peek-tile";
import type { MediaPeerHandlers } from "@/lib/browser-view/tiles/webrtc-media-registry";
import { AgentCursorOverlay } from "@/components/epic-canvas/renderers/agent-cursor-overlay";
import { containBox } from "@/components/epic-canvas/renderers/agent-cursor-contain-box";
import type { AgentCursorPosition } from "@/lib/browser-view/sessions/screencast-input-encoding";

/**
 * Ticket 10, the client half: the agent ghost cursor through the REAL hook,
 * transport and tile - the host's normalized coordinates in, a positioned
 * overlay out, on both display planes.
 */
const peers = vi.hoisted(
  () => [] as Array<{ readonly handlers: MediaPeerHandlers; closed: boolean }>,
);

vi.mock("@/providers/use-runner-host", () => tileRoleRunnerHostModule());

vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);

vi.mock("@/lib/browser-view/tiles/webrtc-media-registry", (original) =>
  fakeMediaPeerModule(peers)(original),
);

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);

vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => hookState.streamClient,
}));

vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () =>
  epicNestedFocusNavigationModule(),
);

const freshNode = makeFreshPeekNode("headless-cursor");
let peekNode: BrowserPeekNode = freshNode();

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

/**
 * The overlay's contain-fit is pure CSS (a size-query container clamping on
 * whichever axis runs out first), so a cursor's position is a percentage
 * inside the painted box and needs no measured overlay - which jsdom could not
 * lay out anyway. Longer than any linger the overlay could reasonably use, so
 * the fade assertions observe the fade rather than restating its constant.
 */
const PAST_ANY_LINGER_MS = 30_000;

function renderTile(): void {
  renderPeekTile(
    <BrowserPeekTile
      scope={{ kind: "epic", epicId: "epic-1" }}
      visible={hookState.visible}
      onConvertToPip={() => {}}
      node={peekNode}
      completeMeans="ended"
    />,
  );
  act(() => {
    liveStream().emitStatus("open");
    liveStream().emit(
      {
        kind: "started",
        hasBinaryPayload: false,
        frameWidth: 800,
        frameHeight: 600,
        deviceScaleFactor: 1,
      },
      null,
    );
    liveStream().emit(
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
}

function emitCursor(input: {
  readonly type: "move" | "down" | "up";
  readonly epoch: number;
  readonly normalizedX: number;
  readonly normalizedY: number;
}): void {
  act(() => {
    liveStream().emit(
      {
        kind: "agentCursor",
        hasBinaryPayload: false,
        label: "Log in",
        ...input,
      },
      null,
    );
  });
}

function cursorMarker(): HTMLElement | null {
  return screen.queryByTestId("browser-agent-cursor");
}

/** Puts the tile on the video plane with a decoded 800x600 track. */
async function switchToVideoPlane(): Promise<void> {
  await act(async () => {
    liveStream().emit(
      {
        kind: "sdpOffer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "o",
        iceServers: [],
      },
      null,
    );
    await Promise.resolve();
  });
  act(() => {
    peers[0]?.handlers.onStream(fakeMediaStream("track-0"));
  });
  const video = screen.getByTestId("browser-screencast-video");
  Object.defineProperty(video, "videoWidth", {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(video, "videoHeight", {
    configurable: true,
    value: 600,
  });
  act(() => {
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);
  });
  act(() => {
    liveStream().emit(
      { kind: "captureMode", hasBinaryPayload: false, mode: "video" },
      null,
    );
    liveStream().emit(
      { kind: "viewportEpoch", hasBinaryPayload: false, epoch: 3 },
      null,
    );
  });
}

describe("BrowserPeekTile agent ghost cursor", () => {
  beforeEach(() => {
    peers.length = 0;
    peekNode = freshNode();
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("positions the labeled cursor inside the letterboxed surface", () => {
    renderTile();

    emitCursor({ type: "move", epoch: 0, normalizedX: 0.5, normalizedY: 0.5 });

    const marker = cursorMarker();
    expect(marker?.style.left).toBe("50%");
    expect(marker?.style.top).toBe("50%");
    expect(screen.getByText("Log in")).toBeTruthy();
    expect(marker?.dataset.visible).toBe("true");
    expect(screen.queryByTestId("browser-agent-cursor-ripple")).toBeNull();
  });

  it("ripples on a press", () => {
    renderTile();

    emitCursor({ type: "down", epoch: 0, normalizedX: 0.25, normalizedY: 0.5 });

    expect(screen.getByTestId("browser-agent-cursor-ripple")).toBeTruthy();
    expect(cursorMarker()?.style.left).toBe("25%");
    expect(cursorMarker()?.style.top).toBe("50%");
  });

  it("fades out once the agent stops pointing, and un-fades on the next point", () => {
    vi.useFakeTimers();
    try {
      renderTile();
      emitCursor({
        type: "move",
        epoch: 0,
        normalizedX: 0.5,
        normalizedY: 0.5,
      });
      expect(cursorMarker()?.dataset.visible).toBe("true");

      act(() => {
        vi.advanceTimersByTime(PAST_ANY_LINGER_MS);
      });

      expect(cursorMarker()?.dataset.visible).toBe("false");
      expect(cursorMarker()?.className).toContain("opacity-0");

      // The linger restarts per cursor id (the marker is keyed by it).
      // Mutation: dropping that `key` leaves the faded marker faded forever.
      emitCursor({
        type: "move",
        epoch: 0,
        normalizedX: 0.6,
        normalizedY: 0.5,
      });
      expect(cursorMarker()?.dataset.visible).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a cursor stamped with any epoch while the JPEG plane paints", () => {
    renderTile();

    // No viewport epoch was ever announced: a JPEG tile has none, and a
    // cursor overlay has nothing to correlate per frame.
    emitCursor({ type: "move", epoch: 99, normalizedX: 0.5, normalizedY: 0.5 });

    expect(cursorMarker()).not.toBeNull();
  });

  it("ignores a superseded epoch once the video plane is painting", async () => {
    renderTile();
    await switchToVideoPlane();

    emitCursor({ type: "move", epoch: 2, normalizedX: 0.5, normalizedY: 0.5 });
    expect(cursorMarker()).toBeNull();

    emitCursor({ type: "move", epoch: 3, normalizedX: 0.5, normalizedY: 0.5 });
    expect(cursorMarker()?.style.left).toBe("50%");
  });
});

/**
 * The two properties the tile cannot reach: the contain-fit CSS text (jsdom
 * evaluates no `cqw`/`cqh`, so the strings themselves are the pin) and the
 * PiP-only lifecycle where ONE overlay outlives the selection whose cursor ids
 * it saw.
 */
describe("AgentCursorOverlay", () => {
  const FRAME_SIZE = { width: 800, height: 600 };

  function cursorAt(input: {
    readonly type: "move" | "down";
    readonly id: number;
  }): AgentCursorPosition {
    return {
      type: input.type,
      normalizedX: 0.5,
      normalizedY: 0.5,
      label: "Log in",
      id: input.id,
    };
  }

  it("sizes the box to the frame's contain-fit rectangle", () => {
    // Mutation: swapping width/height inside either `calc`, or dropping a
    // `min()` - both silently mis-place every cursor on a letterboxed tile.
    expect(containBox(FRAME_SIZE)).toEqual({
      width: "min(100cqw, calc(100cqh * 800 / 600))",
      height: "min(100cqh, calc(100cqw * 600 / 800))",
    });
    expect(containBox({ width: 600, height: 800 })).toEqual({
      width: "min(100cqw, calc(100cqh * 600 / 800))",
      height: "min(100cqh, calc(100cqw * 800 / 600))",
    });
  });

  it("drops the press latch when the cursor clears, so ids may restart at 1", () => {
    // LIVE BUG pin: PiP mints cursor ids per SELECTION, so they restart at 1
    // on a tab switch while this overlay stays mounted. Mutation: dropping the
    // `cursor === null` reset of `pressedId` - the retained 1 then matches the
    // NEXT selection's first cursor, and a plain move draws a phantom ripple
    // for a press that never happened.
    const { rerender } = renderPeekTile(
      <AgentCursorOverlay
        cursor={cursorAt({ type: "down", id: 1 })}
        frameSize={FRAME_SIZE}
      />,
    );
    expect(screen.getByTestId("browser-agent-cursor-ripple")).toBeTruthy();

    rerender(<AgentCursorOverlay cursor={null} frameSize={FRAME_SIZE} />);
    rerender(
      <AgentCursorOverlay
        cursor={cursorAt({ type: "move", id: 1 })}
        frameSize={FRAME_SIZE}
      />,
    );

    expect(screen.queryByTestId("browser-agent-cursor-ripple")).toBeNull();

    // And the next genuine press of that selection still ripples.
    rerender(
      <AgentCursorOverlay
        cursor={cursorAt({ type: "down", id: 2 })}
        frameSize={FRAME_SIZE}
      />,
    );
    expect(screen.getByTestId("browser-agent-cursor-ripple")).toBeTruthy();
  });

  afterEach(() => {
    cleanup();
  });
});
