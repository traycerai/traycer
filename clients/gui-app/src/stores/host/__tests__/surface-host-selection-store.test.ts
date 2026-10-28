import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_PERSIST_VERSION,
  surfaceHostSelectionKey,
} from "@/lib/persist";
import {
  composerSurfaceKey,
  gitDiffPanelSurfaceKey,
  notifyEffectiveHostChanged,
  resolvedSurfaceHostId,
  subscribeFollowingSurfaceReset,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

const PERSIST_KEY = surfaceHostSelectionKey(null);
const GIT_KEY = gitDiffPanelSurfaceKey("tab-1");
const TREE_KEY = "file-tree-test";

/** The persist middleware writes on a microtask. */
function flushPersist(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function storedSelections(): unknown {
  const raw = window.localStorage.getItem(PERSIST_KEY);
  const parsed: unknown = JSON.parse(raw ?? "{}");
  if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
    return null;
  }
  const state = parsed.state;
  if (typeof state !== "object" || state === null || !("selections" in state)) {
    return null;
  }
  return state.selections;
}

function resetStore(): void {
  window.localStorage.clear();
  useSurfaceHostSelectionStore.persist.setOptions({ name: PERSIST_KEY });
  useSurfaceHostSelectionStore.getState().resetForTests();
}

describe("useSurfaceHostSelectionStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("starts following: missing key is null, resolved falls through to effective", () => {
    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      undefined,
    );
    expect(
      resolvedSurfaceHostId(null, "host-active", {
        authorityAttached: false,
        leases: [],
      }),
    ).toBe("host-active");
  });

  it("pins one instance without touching a sibling", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.setSelection(GIT_KEY, "host-b");
    store.setSelection(TREE_KEY, "host-c");

    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      "host-b",
    );
    expect(useSurfaceHostSelectionStore.getState().selections[TREE_KEY]).toBe(
      "host-c",
    );
    expect(
      resolvedSurfaceHostId("host-b", "host-active", {
        authorityAttached: false,
        leases: [],
      }),
    ).toBe("host-b");
  });

  it("setSelection(null) returns the instance to following", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.setSelection(GIT_KEY, "host-b");
    store.setSelection(GIT_KEY, null);

    expect(
      useSurfaceHostSelectionStore.getState().selections[GIT_KEY],
    ).toBeUndefined();
  });

  it("latchOnFirstUse pins a follower and is a no-op once pinned", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.latchOnFirstUse(GIT_KEY, "host-active");
    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      "host-active",
    );

    store.latchOnFirstUse(GIT_KEY, "host-other");
    expect(useSurfaceHostSelectionStore.getState().selections[GIT_KEY]).toBe(
      "host-active",
    );
  });

  it("notifyEffectiveHostChanged fires the G4 reset hook only when effective moves", () => {
    const seen: Array<{
      readonly previousEffectiveHostId: string | null;
      readonly nextEffectiveHostId: string | null;
    }> = [];
    const unsubscribe = subscribeFollowingSurfaceReset((event) => {
      seen.push(event);
    });

    notifyEffectiveHostChanged("host-a", "host-a");
    notifyEffectiveHostChanged("host-a", "host-b");
    unsubscribe();
    notifyEffectiveHostChanged("host-b", "host-c");

    expect(seen).toEqual([
      { previousEffectiveHostId: "host-a", nextEffectiveHostId: "host-b" },
    ]);
  });

  it("reserves a composer window key without requiring a consumer", () => {
    expect(composerSurfaceKey("window-1")).toBe("composer\u001fwindow-1");
    expect(composerSurfaceKey(null)).toBe("composer\u001fbrowser");
  });

  /**
   * TWO WINDOWS, ONE STORED MAP.
   *
   * Every window runs its own instance of this store and persists the WHOLE
   * `selections` map to one account-scoped key, so the second writer used to
   * erase the first writer's newer pin - visible only after that window
   * reloaded and its surface silently followed `effective` instead of the host
   * the user picked. Per-window surface keys do not help: distinct keys still
   * share one stored object.
   *
   * The other window is simulated by writing storage DIRECTLY, which is
   * exactly what it is from this instance's point of view: a change to the
   * shared key that this instance never saw.
   */
  it("preserves a pin another window wrote after this instance hydrated", async () => {
    useSurfaceHostSelectionStore.getState().setSelection(GIT_KEY, "host-b");
    await flushPersist();

    // Window B lands its own pin under a key this instance has never held.
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          selections: { [GIT_KEY]: "host-b", [TREE_KEY]: "host-c" },
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    // This instance writes again, from a map that knows nothing about B's pin.
    useSurfaceHostSelectionStore.getState().setSelection(GIT_KEY, "host-d");
    await flushPersist();

    expect(storedSelections()).toEqual({
      [GIT_KEY]: "host-d",
      [TREE_KEY]: "host-c",
    });
  });

  /**
   * The direction a plain union would break, and the reason the merge is
   * three-way. Unpin is expressed as ABSENCE, so a writer that only ever
   * merged keys IN would resurrect every pin the user just cleared - trading a
   * lost write for a pin that cannot be removed.
   */
  it("still applies this window's own unpin through the merge", async () => {
    useSurfaceHostSelectionStore.getState().setSelection(GIT_KEY, "host-b");
    await flushPersist();

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          selections: { [GIT_KEY]: "host-b", [TREE_KEY]: "host-c" },
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    useSurfaceHostSelectionStore.getState().setSelection(GIT_KEY, null);
    await flushPersist();

    // Own key gone, foreign key untouched.
    expect(storedSelections()).toEqual({ [TREE_KEY]: "host-c" });
  });

  /**
   * The MIRROR of the lost-write bug, and the one a "spread my whole map over
   * theirs" merge creates while fixing it.
   *
   * Two windows hydrate pin `x`. Window B unpins it - an explicit
   * return-to-following - and persists the deletion. Window A still carries `x`
   * in memory, having never touched it. Any unrelated write from A then
   * republished `x`, and it also survived a deletion loop keyed on absence
   * because `x` was still present in A's map. So ordinary activity in another
   * window silently undid the user's choice.
   *
   * The rule that fixes it: a key equal in this instance's base and its current
   * map was not touched between those two writes, so this instance has no
   * opinion about it and storage stands - including storage's absence.
   */
  it("does not resurrect a pin another window deleted", async () => {
    // Both windows know `x` and this instance knows an unrelated key.
    useSurfaceHostSelectionStore.getState().setSelection(GIT_KEY, "host-b");
    useSurfaceHostSelectionStore.getState().setSelection(TREE_KEY, "host-c");
    await flushPersist();
    expect(storedSelections()).toEqual({
      [GIT_KEY]: "host-b",
      [TREE_KEY]: "host-c",
    });

    // Window B unpins GIT_KEY and persists that deletion.
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { selections: { [TREE_KEY]: "host-c" } },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    // This instance writes something UNRELATED. It still holds GIT_KEY in
    // memory and must not re-assert it.
    useSurfaceHostSelectionStore.getState().setSelection(TREE_KEY, "host-d");
    await flushPersist();

    expect(storedSelections()).toEqual({ [TREE_KEY]: "host-d" });
  });

  it("persists pins and drops invalid rehydrated entries", async () => {
    useSurfaceHostSelectionStore.getState().setSelection(GIT_KEY, "host-b");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: { selections: { [GIT_KEY]: "host-b" } },
      version: CURRENT_PERSIST_VERSION,
    });

    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { selections: { [GIT_KEY]: "host-b", bad: 1, "": "x" } },
        version: CURRENT_PERSIST_VERSION,
      }),
    );
    await useSurfaceHostSelectionStore.persist.rehydrate();
    expect(useSurfaceHostSelectionStore.getState().selections).toEqual({
      [GIT_KEY]: "host-b",
    });
  });
});
