import { describe, expect, it } from "vitest";
import {
  isBrowserTileVisible,
  registerVisibleBrowserTile,
  subscribeVisibleBrowserTiles,
  visibleBrowserTileKeyId,
  visibleBrowserTileStore,
} from "../visible-tile-registry";

function resetRegistry(): void {
  visibleBrowserTileStore.setState(
    visibleBrowserTileStore.getInitialState(),
    true,
  );
}

describe("visible-tile-registry", () => {
  it("refcounts the same host+session+tab key", () => {
    resetRegistry();
    const key = { hostId: "host-a", sessionId: "s1", tabId: "t1" };
    const first = registerVisibleBrowserTile(key);
    const second = registerVisibleBrowserTile(key);
    expect(isBrowserTileVisible(key)).toBe(true);
    first();
    expect(isBrowserTileVisible(key)).toBe(true);
    second();
    expect(isBrowserTileVisible(key)).toBe(false);
  });

  it("keys visibility by host, session, and tab independently", () => {
    resetRegistry();
    const a = { hostId: "host-a", sessionId: "s1", tabId: "t1" };
    const otherHost = { hostId: "host-b", sessionId: "s1", tabId: "t1" };
    const otherSession = { hostId: "host-a", sessionId: "s2", tabId: "t1" };
    const otherTab = { hostId: "host-a", sessionId: "s1", tabId: "t2" };
    const release = registerVisibleBrowserTile(a);
    expect(isBrowserTileVisible(a)).toBe(true);
    expect(isBrowserTileVisible(otherHost)).toBe(false);
    expect(isBrowserTileVisible(otherSession)).toBe(false);
    expect(isBrowserTileVisible(otherTab)).toBe(false);
    expect(visibleBrowserTileKeyId(a)).not.toBe(
      visibleBrowserTileKeyId(otherHost),
    );
    release();
  });

  it("unsubscribe stops notifications; reset only clears counts", () => {
    resetRegistry();
    let calls = 0;
    const unsubscribe = subscribeVisibleBrowserTiles(() => {
      calls += 1;
    });
    const release = registerVisibleBrowserTile({
      hostId: "host-a",
      sessionId: "s1",
      tabId: "t1",
    });
    expect(calls).toBe(1);
    unsubscribe();
    release();
    expect(calls).toBe(1);

    resetRegistry();
    expect(
      isBrowserTileVisible({
        hostId: "host-a",
        sessionId: "s1",
        tabId: "t1",
      }),
    ).toBe(false);
    registerVisibleBrowserTile({
      hostId: "host-a",
      sessionId: "s1",
      tabId: "t1",
    })();
    expect(calls).toBe(1);
  });

  it("is a local host+session+tab registry and never takes a viewed flag", () => {
    resetRegistry();
    const key = { hostId: "host-a", sessionId: "s1", tabId: "t1" };
    const release = registerVisibleBrowserTile(key);
    expect(Object.keys(key).sort()).toEqual(["hostId", "sessionId", "tabId"]);
    expect(isBrowserTileVisible(key)).toBe(true);
    release();
  });
});
