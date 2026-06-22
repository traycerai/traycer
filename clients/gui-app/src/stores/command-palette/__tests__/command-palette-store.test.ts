import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMAND_PALETTE_LIMITS,
  useCommandPaletteStore,
} from "@/stores/command-palette/command-palette-store";

function resetStore(): void {
  useCommandPaletteStore.setState({
    open: false,
    query: "",
    recentIds: [],
    pinnedIds: [],
  });
}

describe("useCommandPaletteStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("starts closed, with an empty query", () => {
    const state = useCommandPaletteStore.getState();
    expect(state.open).toBe(false);
    expect(state.query).toBe("");
    expect(state.recentIds).toEqual([]);
    expect(state.pinnedIds).toEqual([]);
  });

  it("setOpen(true) resets the query so the palette opens fresh", () => {
    useCommandPaletteStore.setState({ query: "stale" });
    useCommandPaletteStore.getState().setOpen(true);
    const next = useCommandPaletteStore.getState();
    expect(next.open).toBe(true);
    expect(next.query).toBe("");
  });

  it("setOpen(false) closes without touching persisted fields", () => {
    useCommandPaletteStore.setState({
      open: true,
      recentIds: ["a"],
      pinnedIds: ["b"],
    });
    useCommandPaletteStore.getState().setOpen(false);
    const next = useCommandPaletteStore.getState();
    expect(next.open).toBe(false);
    expect(next.recentIds).toEqual(["a"]);
    expect(next.pinnedIds).toEqual(["b"]);
  });

  it("setQuery updates the query and is a no-op when unchanged", () => {
    useCommandPaletteStore.getState().setQuery("hello");
    expect(useCommandPaletteStore.getState().query).toBe("hello");
    const before = useCommandPaletteStore.getState();
    useCommandPaletteStore.getState().setQuery("hello");
    expect(useCommandPaletteStore.getState()).toBe(before);
  });

  it("recordUse prepends the id and caps at the recents limit", () => {
    const ids = Array.from({ length: COMMAND_PALETTE_LIMITS.recents + 3 }).map(
      (_, i) => `cmd-${i}`,
    );
    for (const id of ids) {
      useCommandPaletteStore.getState().recordUse(id);
    }
    const { recentIds } = useCommandPaletteStore.getState();
    expect(recentIds).toHaveLength(COMMAND_PALETTE_LIMITS.recents);
    expect(recentIds[0]).toBe(ids[ids.length - 1]);
  });

  it("recordUse dedupes an id by moving it to the front", () => {
    const { recordUse } = useCommandPaletteStore.getState();
    recordUse("a");
    recordUse("b");
    recordUse("c");
    recordUse("a");
    expect(useCommandPaletteStore.getState().recentIds).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("togglePin adds the id and returns true when there is room", () => {
    const result = useCommandPaletteStore.getState().togglePin("pin-1");
    expect(result).toBe(true);
    expect(useCommandPaletteStore.getState().pinnedIds).toEqual(["pin-1"]);
  });

  it("togglePin removes the id when already pinned", () => {
    useCommandPaletteStore.setState({ pinnedIds: ["a", "b", "c"] });
    const result = useCommandPaletteStore.getState().togglePin("b");
    expect(result).toBe(true);
    expect(useCommandPaletteStore.getState().pinnedIds).toEqual(["a", "c"]);
  });

  it("togglePin returns false without mutating when the cap is reached", () => {
    const ids = Array.from({ length: COMMAND_PALETTE_LIMITS.pinned }).map(
      (_, i) => `p-${i}`,
    );
    useCommandPaletteStore.setState({ pinnedIds: ids });
    const result = useCommandPaletteStore.getState().togglePin("p-new");
    expect(result).toBe(false);
    expect(useCommandPaletteStore.getState().pinnedIds).toEqual(ids);
  });

  it("clearRecents empties the recents list", () => {
    useCommandPaletteStore.setState({ recentIds: ["a", "b"] });
    useCommandPaletteStore.getState().clearRecents();
    expect(useCommandPaletteStore.getState().recentIds).toEqual([]);
  });

  it("does not persist session-only open state", () => {
    useCommandPaletteStore.getState().setOpen(true);
    const raw = window.localStorage.getItem("traycer-gui-app:command-palette");
    if (raw === null) throw new Error("expected persisted palette state");
    const persisted = JSON.parse(raw) as {
      readonly state: Record<string, unknown>;
    };
    expect(persisted.state).not.toHaveProperty("open");
  });
});
