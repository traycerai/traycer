import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionsClientFrame } from "@traycer/protocol/host/browser/contracts";
import {
  attachBorrowedTileCdpSurface,
  publishBorrowedTileCdpRequest,
  registerBorrowedTileCdpHandler,
  resetBorrowedTileCdpForTests,
  type BorrowedTileCdpRequest,
} from "../borrowed-tile-cdp";
import type {
  BrowserViewTileCdpSessionEndedChange,
  BrowserViewTileCdpTargetAttachedChange,
  DesktopBrowserViewBridge,
} from "../desktop-browser-view";

const TILE_KEY = {
  viewTabId: "view-1",
  paneId: "pane-1",
  tileInstanceId: "tile-1",
  pageSessionId: "page-1",
} as const;

afterEach(() => {
  resetBorrowedTileCdpForTests();
});

describe("borrowed tile CDP", () => {
  it("routes only to the currently mounted borrowed surface", () => {
    const first = vi.fn<(request: BorrowedTileCdpRequest) => void>();
    const second = vi.fn<(request: BorrowedTileCdpRequest) => void>();
    const disposeFirst = registerBorrowedTileCdpHandler("tile-1", first);
    registerBorrowedTileCdpHandler("tile-1", second);
    const request = cdpRequest();

    publishBorrowedTileCdpRequest(request);
    disposeFirst();
    publishBorrowedTileCdpRequest(request);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("returns a targeted not-found result when no surface is mounted", () => {
    const sent: BrowserSessionsClientFrame[] = [];

    publishBorrowedTileCdpRequest({
      ...cdpRequest(),
      sendFrame: (frame) => sent.push(frame),
    });

    expect(sent).toEqual([
      expect.objectContaining({
        kind: "cdpGetFrameTreeResult",
        target: { kind: "borrowed-tile", tileInstanceId: "tile-1" },
        ok: false,
        error: expect.objectContaining({ kind: "tile_not_found" }),
      }),
    ]);
  });

  it("dispatches through the mounted native tile and returns on the requesting stream", async () => {
    const bridge = createBridge();
    const dispose = attachBorrowedTileCdpSurface({ bridge, tileKey: TILE_KEY });
    const sent: BrowserSessionsClientFrame[] = [];

    publishBorrowedTileCdpRequest({
      ...cdpRequest(),
      cdpSessionId: "cdp-session-1",
      sendFrame: (frame) => sent.push(frame),
    });
    await vi.waitFor(() => {
      expect(bridge.dispatchCdp).toHaveBeenCalledExactlyOnceWith({
        ...TILE_KEY,
        sessionId: "cdp-session-1",
        command: { kind: "cdpGetFrameTree" },
      });
      expect(sent).toContainEqual(
        expect.objectContaining({
          kind: "cdpGetFrameTreeResult",
          target: { kind: "borrowed-tile", tileInstanceId: "tile-1" },
          ok: true,
        }),
      );
    });

    dispose();
  });

  it("keeps native pushes in the mounted surface closure and filters exact tile identity", () => {
    const bridge = createBridge();
    const dispose = attachBorrowedTileCdpSurface({ bridge, tileKey: TILE_KEY });
    const sent: BrowserSessionsClientFrame[] = [];
    publishBorrowedTileCdpRequest({
      ...cdpRequest(),
      sendFrame: (frame) => sent.push(frame),
    });
    bridge.emitEnded({ ...TILE_KEY, reason: "target closed" });
    bridge.emitAttached({
      ...TILE_KEY,
      tileInstanceId: "foreign-tile",
      sessionId: "cdp-foreign",
      targetId: "target-foreign",
      targetType: "iframe",
      url: "https://foreign.example/",
      waitingForDebugger: false,
    });

    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "cdpSessionEnded",
        target: { kind: "borrowed-tile", tileInstanceId: "tile-1" },
        registrationId: null,
        reason: "target closed",
      }),
    );
    expect(sent.some((frame) => frame.kind === "cdpTargetAttached")).toBe(false);

    sent.length = 0;
    dispose();
    bridge.emitEnded({ ...TILE_KEY, reason: "late" });
    expect(sent).toEqual([]);
  });
});

function cdpRequest(): BorrowedTileCdpRequest {
  return {
    requestId: "request-1",
    tileInstanceId: "tile-1",
    cdpSessionId: null,
    command: { kind: "cdpGetFrameTree" },
    sendFrame: () => {},
  };
}

interface TestBridge
  extends Pick<
    DesktopBrowserViewBridge,
    "dispatchCdp" | "onCdpSessionEnded" | "onCdpTargetAttached"
  > {
  emitEnded(change: BrowserViewTileCdpSessionEndedChange): void;
  emitAttached(change: BrowserViewTileCdpTargetAttachedChange): void;
}

function createBridge(): TestBridge {
  const ended = new Set<
    (change: BrowserViewTileCdpSessionEndedChange) => void
  >();
  const attached = new Set<
    (change: BrowserViewTileCdpTargetAttachedChange) => void
  >();
  return {
    dispatchCdp: vi.fn(async () => ({
      kind: "cdpGetFrameTree" as const,
      ok: true as const,
      frames: [],
    })),
    onCdpSessionEnded: (handler) => {
      ended.add(handler);
      return { dispose: () => ended.delete(handler) };
    },
    onCdpTargetAttached: (handler) => {
      attached.add(handler);
      return { dispose: () => attached.delete(handler) };
    },
    emitEnded: (change) => {
      for (const handler of ended) handler(change);
    },
    emitAttached: (change) => {
      for (const handler of attached) handler(change);
    },
  };
}
