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
import type {
  MediaDataChannel,
  MediaPeer,
  MediaPeerHandlers,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * The `inputAck` promotion end to end: the frame is parsed and dispatched by
 * the REAL `handleServerFrame`, not by calling the controller directly.
 * Ticket 17's DataChannel ping was swallowed by the transport before any
 * contract handler ran, and a controller-level test could never have seen it -
 * hence this one.
 */
const peers = vi.hoisted(
  () => [] as Array<{ readonly handlers: MediaPeerHandlers }>,
);

vi.mock("@/lib/browser-view/tiles/webrtc-media-registry", async (original) => {
  const actual =
    await original<
      typeof import("@/lib/browser-view/tiles/webrtc-media-registry")
    >();
  const createBrowserMediaPeer = (handlers: MediaPeerHandlers): MediaPeer => {
    peers.push({ handlers });
    return {
      answerOffer: (sdp) => {
        handlers.onIceGatheringComplete();
        return Promise.resolve(`answer-for:${sdp}`);
      },
      addRemoteCandidate: () => Promise.resolve(),
      getStats: () => Promise.resolve(new Map()),
      close: () => {},
    };
  };
  return { ...actual, createBrowserMediaPeer };
});

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-test",
}));

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => true,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ hostId: "host-test" }),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => hookState.streamClient,
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

let nodeCounter = 0;
let peekNode: BrowserPeekNode = freshNode();

/** A distinct session id per test: the media registry is module-scoped. */
function freshNode(): BrowserPeekNode {
  nodeCounter += 1;
  return {
    id: "browser-peek-headless-1",
    instanceId: "peek-instance-1",
    hostId: "host-test",
    sessionId: `headless-${nodeCounter}`,
    tabId: "headless-tab-1",
    initialUrl: "http://localhost:3000",
  };
}

function liveStream(): FakeStreamSession {
  const stream = hookState.streamClient?.sessions.at(-1);
  if (stream === undefined) throw new Error("expected screencast stream");
  return stream;
}

function imeInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Browser IME input" });
}

function keyboardFrameCount(stream: FakeStreamSession): number {
  return stream.sentFrames.filter((frame) => frame.kind === "keyboard").length;
}

interface FakeChannel extends MediaDataChannel {
  readonly sends: string[];
}

function fakeChannel(label: string): FakeChannel {
  const sends: string[] = [];
  return {
    label,
    sends,
    isOpen: () => true,
    send: (payload) => sends.push(payload),
    close: () => {},
    onStateChange: null,
  };
}

describe("BrowserPeekTile input ack", () => {
  beforeEach(() => {
    peers.length = 0;
    peekNode = freshNode();
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("promotes input to the channels when a host inputAck drains the mux", async () => {
    render(
      <BrowserPeekTile
        viewTabId="view-tab-1"
        paneId="pane-1"
        epicId="epic-1"
        node={peekNode}
      />,
    );
    const stream = liveStream();
    act(() => {
      stream.emitStatus("open");
      stream.emit(
        { kind: "captureMode", hasBinaryPayload: false, mode: "video" },
        null,
      );
      stream.emit(
        { kind: "viewportEpoch", hasBinaryPayload: false, epoch: 4 },
        null,
      );
    });

    // Armed, and typing while the channels are still down.
    fireEvent.focus(
      screen.getByRole("button", { name: "Browser screencast controls" }),
    );
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });
    fireEvent.keyDown(imeInput(), { code: "KeyA", key: "a" });
    const beforeChannels = keyboardFrameCount(stream);
    expect(beforeChannels).toBeGreaterThan(0);

    // The round comes up mid-arm.
    await act(async () => {
      stream.emit(
        {
          kind: "sdpOffer",
          hasBinaryPayload: false,
          negotiationId: 1,
          sdp: "offer-1",
          iceServers: [],
        },
        null,
      );
      await Promise.resolve();
    });
    const peer = peers.at(0);
    if (peer === undefined) throw new Error("no peer was created");
    const handlers = peer.handlers;
    const reliable = fakeChannel("input-reliable");
    act(() => {
      handlers.onDataChannel(fakeChannel("input-lossy"));
      handlers.onDataChannel(reliable);
    });

    // Still the mux: the host has not said it consumed what is already there.
    fireEvent.keyDown(imeInput(), { code: "KeyB", key: "b" });
    expect(reliable.sends).toEqual([]);
    const beforeAck = keyboardFrameCount(stream);
    expect(beforeAck).toBeGreaterThan(beforeChannels);

    act(() => {
      stream.emit(
        {
          kind: "inputAck",
          hasBinaryPayload: false,
          armEpoch: 1,
          lastSeq: beforeAck - 1,
        },
        null,
      );
    });
    fireEvent.keyDown(imeInput(), { code: "KeyC", key: "c" });

    // Promoted mid-arm: the next key rides the channel and the mux sees none.
    expect(reliable.sends.length).toBeGreaterThan(0);
    expect(keyboardFrameCount(stream)).toBe(beforeAck);
  });
});
