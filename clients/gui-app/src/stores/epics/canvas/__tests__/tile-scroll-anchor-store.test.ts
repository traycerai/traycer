import { afterEach, describe, expect, it } from "vitest";
import {
  useTileScrollAnchorStore,
  type TileScrollAnchor,
} from "@/stores/epics/canvas/tile-scroll-anchor-store";

const NATIVE: TileScrollAnchor = {
  kind: "native",
  scrollTop: 100,
  scrollLeft: 0,
  scrollHeight: 800,
  scrollWidth: 400,
};
const CHAT: TileScrollAnchor = {
  kind: "chat",
  followingBottom: false,
  scrollTop: 42,
};

function reset(): void {
  useTileScrollAnchorStore.setState({ anchors: {} });
}

describe("useTileScrollAnchorStore", () => {
  afterEach(reset);

  it("sets and gets an anchor by instanceId", () => {
    useTileScrollAnchorStore.getState().setAnchor("t1", NATIVE);
    expect(useTileScrollAnchorStore.getState().getAnchor("t1")).toEqual(NATIVE);
  });

  it("returns undefined for an unknown instanceId", () => {
    expect(
      useTileScrollAnchorStore.getState().getAnchor("missing"),
    ).toBeUndefined();
  });

  it("overwrites an existing anchor", () => {
    const store = useTileScrollAnchorStore.getState();
    store.setAnchor("t1", NATIVE);
    store.setAnchor("t1", CHAT);
    expect(useTileScrollAnchorStore.getState().getAnchor("t1")).toEqual(CHAT);
  });

  it("clears a single anchor", () => {
    const store = useTileScrollAnchorStore.getState();
    store.setAnchor("t1", NATIVE);
    store.clearAnchors(["t1"]);
    expect(useTileScrollAnchorStore.getState().getAnchor("t1")).toBeUndefined();
  });

  it("treats clearAnchors on a missing id as a no-op (same reference)", () => {
    const before = useTileScrollAnchorStore.getState().anchors;
    useTileScrollAnchorStore.getState().clearAnchors(["missing"]);
    expect(useTileScrollAnchorStore.getState().anchors).toBe(before);
  });

  it("clears a subset and leaves the rest intact", () => {
    const store = useTileScrollAnchorStore.getState();
    store.setAnchor("t1", NATIVE);
    store.setAnchor("t2", CHAT);
    store.setAnchor("t3", NATIVE);
    store.clearAnchors(["t1", "t3", "absent"]);
    const after = useTileScrollAnchorStore.getState();
    expect(after.getAnchor("t1")).toBeUndefined();
    expect(after.getAnchor("t2")).toEqual(CHAT);
    expect(after.getAnchor("t3")).toBeUndefined();
  });

  it("keeps the same state reference when clearAnchors matches nothing", () => {
    const store = useTileScrollAnchorStore.getState();
    store.setAnchor("t1", NATIVE);
    const before = useTileScrollAnchorStore.getState().anchors;
    store.clearAnchors(["x", "y"]);
    expect(useTileScrollAnchorStore.getState().anchors).toBe(before);
  });
});
