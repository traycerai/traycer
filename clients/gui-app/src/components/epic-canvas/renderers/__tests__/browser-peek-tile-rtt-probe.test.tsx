import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserPeekTile,
  type BrowserPeekNode,
} from "@/components/epic-canvas/renderers/browser-peek-tile";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";

/**
 * Ticket 18's viewer-side half of the RTT probe: the tile answers every
 * `rttProbe` the host sends with exactly one `rttProbeAck` carrying the same
 * `probeId`, and doing so must not disturb any other frame handling on the
 * same subscription.
 */

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
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

function liveStream(): FakeStreamSession {
  const sessions = hookState.streamClient?.sessions ?? [];
  const stream = sessions.at(-1);
  if (stream === undefined) {
    throw new Error("expected browser.sessions stream");
  }
  return stream;
}

const PEEK_NODE: BrowserPeekNode = {
  id: "browser-peek-headless-1",
  instanceId: "peek-instance-1",
  hostId: "host-test",
  sessionId: "headless-1",
  tabId: "headless-tab-1",
  initialUrl: "http://localhost:3000",
};

describe("BrowserPeekTile rttProbe handling", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
  });

  it("answers an rttProbe with exactly one rttProbeAck carrying the same probeId", () => {
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
