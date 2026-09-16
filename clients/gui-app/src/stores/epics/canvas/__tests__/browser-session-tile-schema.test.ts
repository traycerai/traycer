import { describe, expect, it } from "vitest";
import type { PendingBrowserTabRequest } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  browserSessionTileSchema,
  makeBrowserSessionTileRef,
  makePendingBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { TILE_KIND_BROWSER_SESSION } from "@/stores/epics/canvas/tile-kinds";
import {
  isBrowserSessionTileRef,
  type BrowserSessionTileRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";

const HOST = "host-1";

describe("makeBrowserSessionTileRef", () => {
  it("mints a deterministic pointer id from {sessionId, tabId}", () => {
    const first = makeBrowserSessionTileRef({
      hostId: HOST,
      sessionId: "sess-a",
      tabId: "tab-1",
    });
    const second = makeBrowserSessionTileRef({
      hostId: HOST,
      sessionId: "sess-a",
      tabId: "tab-1",
    });

    expect(first.type).toBe(TILE_KIND_BROWSER_SESSION);
    expect(first.id).toBe("browser-session:sess-a:tab-1");
    expect(second.id).toBe(first.id);
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(first.sessionId).toBe("sess-a");
    expect(first.tabId).toBe("tab-1");
    expect(first.name).toBe("Browser");
    expect(first.viewportPreset).toBe("responsive");
    expect(first).not.toHaveProperty("url");
    expect(first).not.toHaveProperty("chatId");
  });
});

describe("browserSessionTileSchema / parseTileRef", () => {
  it("round-trips a browser-session pointer ref", () => {
    const ref: BrowserSessionTileRef = {
      id: "browser-session:sess-1:tab-9",
      instanceId: "inst-1",
      type: TILE_KIND_BROWSER_SESSION,
      name: "Browser",
      hostId: HOST,
      sessionId: "sess-1",
      tabId: "tab-9",
      viewportPreset: "responsive",
    };

    expect(
      browserSessionTileSchema.parse(browserSessionTileSchema.serialize(ref)),
    ).toEqual(ref);
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);
  });

  it("rejects missing sessionId or tabId", () => {
    const base = {
      id: "browser-session:sess-1:tab-1",
      instanceId: "inst-1",
      type: TILE_KIND_BROWSER_SESSION,
      name: "Browser",
      hostId: HOST,
      sessionId: "sess-1",
      tabId: "tab-1",
      viewportPreset: "responsive",
    };
    expect(
      browserSessionTileSchema.parse({ ...base, sessionId: undefined }),
    ).toBeNull();
    expect(browserSessionTileSchema.parse({ ...base, tabId: 42 })).toBeNull();
    expect(
      browserSessionTileSchema.parse({ ...base, viewportPreset: "widescreen" }),
    ).toBeNull();
    expect(
      browserSessionTileSchema.parse({ ...base, type: "browser-peek" }),
    ).toBeNull();
  });
});

describe("makePendingBrowserSessionTileRef", () => {
  const pending: PendingBrowserTabRequest = {
    requestId: "req-1",
    hostId: HOST,
    scope: { kind: "epic", epicId: "epic-1" },
    requestedUrl: "https://example.test/",
    clickedAt: 0,
  };

  it("mints a null-session/tab placeholder carrying the request", () => {
    const ref = makePendingBrowserSessionTileRef(pending);

    expect(ref.type).toBe(TILE_KIND_BROWSER_SESSION);
    expect(ref.sessionId).toBeNull();
    expect(ref.tabId).toBeNull();
    expect(ref.pending).toBe(pending);
    expect(ref.hostId).toBe(HOST);
    expect(ref.id).toContain(pending.requestId);
  });

  it("never survives a serialize/parse round trip - a reload must never replay a stale request", () => {
    const ref = makePendingBrowserSessionTileRef(pending);

    const serialized = browserSessionTileSchema.serialize(ref);
    expect(serialized).toBeNull();
    expect(parseTileRef(serializeTileRef(ref))).toBeNull();
  });

  it("is rejected by parse even if a pending-shaped record were ever persisted", () => {
    // No sessionId/tabId string, same as any other malformed record - the
    // pending union member is never a thing `parse` can produce.
    expect(
      browserSessionTileSchema.parse({
        id: "browser-session:pending:req-1",
        instanceId: "inst-1",
        type: TILE_KIND_BROWSER_SESSION,
        name: "Browser",
        hostId: HOST,
        sessionId: null,
        tabId: null,
        viewportPreset: "responsive",
        pending,
      }),
    ).toBeNull();
  });
});

describe("isBrowserSessionTileRef", () => {
  it("narrows only browser-session tiles", () => {
    const pointer: BrowserSessionTileRef = {
      id: "browser-session:s:t",
      instanceId: "i",
      type: TILE_KIND_BROWSER_SESSION,
      name: "Browser",
      hostId: HOST,
      sessionId: "s",
      tabId: "t",
      viewportPreset: "responsive",
    };
    const blank: EpicCanvasTileRef = {
      id: "blank",
      instanceId: "i2",
      type: "blank",
      name: "New tab",
      hostId: HOST,
    };

    expect(isBrowserSessionTileRef(pointer)).toBe(true);
    expect(isBrowserSessionTileRef(blank)).toBe(false);
  });
});
