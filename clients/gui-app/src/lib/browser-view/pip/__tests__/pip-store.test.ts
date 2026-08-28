import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPipCaption,
  completePipConversion,
  convertBrowserTabToPip,
  dismissPip,
  failPipConversion,
  getPipSnapshot,
  initPipStore,
} from "../pip-store";
import {
  registerVisibleBrowserTile,
  visibleBrowserTileStore,
} from "../../tiles/visible-tile-registry";

const EPIC_ID = "epic-1";

type ConvertOverrides = Partial<{
  readonly sessionId: string;
  readonly tabId: string;
  readonly origin: "manual" | "agent";
  readonly onReady: () => void;
  readonly onError: (message: string) => void;
}>;

function convert(overrides: ConvertOverrides): string {
  convertBrowserTabToPip({
    epicId: EPIC_ID,
    hostId: "host-1",
    sessionId: overrides.sessionId ?? "session-1",
    tabId: overrides.tabId ?? "tab-1",
    origin: overrides.origin ?? "manual",
    onReady: overrides.onReady ?? vi.fn(),
    onError: overrides.onError ?? vi.fn(),
  });
  const selectionId = getPipSnapshot(EPIC_ID).pendingTarget?.selectionId;
  if (selectionId === undefined) throw new Error("Expected pending PiP target");
  return selectionId;
}

describe("manual PiP store", () => {
  beforeEach(() => {
    dismissPip(EPIC_ID);
    visibleBrowserTileStore.setState(
      visibleBrowserTileStore.getInitialState(),
      true,
    );
  });

  it("stays hidden until an explicit conversion receives its first frame", () => {
    const onReady = vi.fn();
    const selectionId = convert({ onReady });

    expect(getPipSnapshot(EPIC_ID).target).toBeNull();
    completePipConversion(EPIC_ID, selectionId);

    expect(getPipSnapshot(EPIC_ID).target).toMatchObject({
      sessionId: "session-1",
      tabId: "tab-1",
    });
    expect(getPipSnapshot(EPIC_ID).pendingTarget).toBeNull();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("keeps the old target until a replacement is ready", () => {
    const first = convert({});
    completePipConversion(EPIC_ID, first);
    const second = convert({ sessionId: "session-2", tabId: "tab-2" });

    expect(getPipSnapshot(EPIC_ID).target?.sessionId).toBe("session-1");
    expect(getPipSnapshot(EPIC_ID).pendingTarget?.sessionId).toBe("session-2");

    completePipConversion(EPIC_ID, second);
    expect(getPipSnapshot(EPIC_ID).target?.sessionId).toBe("session-2");
  });

  it("keeps the tile open and preserves the old target when replacement fails", () => {
    const first = convert({});
    completePipConversion(EPIC_ID, first);
    const onReady = vi.fn();
    const onError = vi.fn();
    const second = convert({
      sessionId: "session-2",
      tabId: "tab-2",
      onReady,
      onError,
    });

    failPipConversion(EPIC_ID, second, "capture failed");

    expect(getPipSnapshot(EPIC_ID).target?.sessionId).toBe("session-1");
    expect(getPipSnapshot(EPIC_ID).pendingTarget).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("capture failed");
  });

  it("dismisses only the PiP view", () => {
    const ready = vi.fn();
    const selectionId = convert({ onReady: ready });
    completePipConversion(EPIC_ID, selectionId);

    dismissPip(EPIC_ID);

    expect(getPipSnapshot(EPIC_ID).target).toBeNull();
    expect(ready).toHaveBeenCalledOnce();
  });

  it("dismisses PiP when its full browser tile becomes visible", () => {
    initPipStore();
    const selectionId = convert({});
    completePipConversion(EPIC_ID, selectionId);
    const unregister = registerVisibleBrowserTile({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
    });

    expect(getPipSnapshot(EPIC_ID).target).toBeNull();
    unregister();
  });

  it("accepts captions only for the selected browser tab", () => {
    const selectionId = convert({});
    completePipConversion(EPIC_ID, selectionId);
    applyPipCaption({
      epicId: EPIC_ID,
      hostId: "host-1",
      sessionId: "other-session",
      tabId: "tab-1",
      cellTitle: "Wrong tab",
    });
    expect(getPipSnapshot(EPIC_ID).caption).toBeNull();

    applyPipCaption({
      epicId: EPIC_ID,
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      cellTitle: "Inspect checkout",
    });
    expect(getPipSnapshot(EPIC_ID).caption?.cellTitle).toBe("Inspect checkout");
  });

  it("records who requested the conversion so agent surfacing can respect it", () => {
    const selectionId = convert({});
    completePipConversion(EPIC_ID, selectionId);
    expect(getPipSnapshot(EPIC_ID).target?.origin).toBe("manual");

    const agentSelectionId = convert({
      sessionId: "session-2",
      origin: "agent",
    });
    completePipConversion(EPIC_ID, agentSelectionId);
    expect(getPipSnapshot(EPIC_ID).target?.origin).toBe("agent");
  });
});
