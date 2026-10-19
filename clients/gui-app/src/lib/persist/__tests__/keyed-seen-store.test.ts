/**
 * The keyed seen store's write keeps both what this window remembers and what
 * another window marked.
 *
 * A mark re-reads storage before it writes. Storage that has been emptied
 * (cleared by something else, or a quota drop) must not erase this window's
 * memory; another window's mark is unioned in; and the cap still holds with
 * the union.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKeyedSeenStore,
  keyedSeen,
} from "@/lib/persist/keyed-seen-store";

let storageKeyCounter = 0;

function uniqueStorageKey(): string {
  storageKeyCounter += 1;
  return `test:keyed-seen-store:${String(storageKeyCounter)}`;
}

/**
 * Writes another window's mark straight into storage, in the shape the store
 * itself persisted: read the blob, add the pair, write it back.
 */
function writeForeignMark(
  storageKey: string,
  viewerUserId: string,
  subject: string,
  at: number,
): void {
  const raw = window.localStorage.getItem(storageKey);
  if (raw === null) throw new Error("the store has not persisted yet");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("state" in parsed) ||
    typeof parsed.state !== "object" ||
    parsed.state === null ||
    !("seen" in parsed.state) ||
    typeof parsed.state.seen !== "object" ||
    parsed.state.seen === null
  ) {
    throw new Error("unexpected persisted shape");
  }
  const seen = {
    ...parsed.state.seen,
    [`${viewerUserId}\u0000${subject}`]: at,
  };
  window.localStorage.setItem(
    storageKey,
    JSON.stringify({ ...parsed, state: { ...parsed.state, seen } }),
  );
}

describe("createKeyedSeenStore", () => {
  let clock = 0;

  beforeEach(() => {
    window.localStorage.clear();
    clock = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 1;
      return clock;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("keeps this window's memory when storage has been emptied under it", () => {
    const storageKey = uniqueStorageKey();
    const store = createKeyedSeenStore(storageKey, 10);

    store.getState().markSeen("v", "a");
    window.localStorage.removeItem(storageKey);
    store.getState().markSeen("v", "b");

    const { seen } = store.getState();
    expect(keyedSeen(seen, "v", "a")).toBe(true);
    expect(keyedSeen(seen, "v", "b")).toBe(true);
  });

  it("unions another window's mark with this window's own", () => {
    const storageKey = uniqueStorageKey();
    const store = createKeyedSeenStore(storageKey, 10);

    store.getState().markSeen("v", "a");
    writeForeignMark(storageKey, "w", "x", 1);
    store.getState().markSeen("v", "b");

    const { seen } = store.getState();
    expect(keyedSeen(seen, "v", "a")).toBe(true);
    expect(keyedSeen(seen, "v", "b")).toBe(true);
    expect(keyedSeen(seen, "w", "x")).toBe(true);
  });

  it("holds the cap: three distinct marks under a cap of two keep only the two newest", () => {
    const storageKey = uniqueStorageKey();
    const store = createKeyedSeenStore(storageKey, 2);

    store.getState().markSeen("v", "a");
    store.getState().markSeen("v", "b");
    store.getState().markSeen("v", "c");

    const { seen } = store.getState();
    expect(Object.keys(seen)).toHaveLength(2);
    expect(keyedSeen(seen, "v", "a")).toBe(false);
    expect(keyedSeen(seen, "v", "b")).toBe(true);
    expect(keyedSeen(seen, "v", "c")).toBe(true);
  });

  it("holds the cap with the union: an older foreign mark is the one dropped", () => {
    const storageKey = uniqueStorageKey();
    const store = createKeyedSeenStore(storageKey, 2);

    store.getState().markSeen("v", "a");
    writeForeignMark(storageKey, "w", "x", 1);
    store.getState().markSeen("v", "b");

    const { seen } = store.getState();
    expect(Object.keys(seen)).toHaveLength(2);
    expect(keyedSeen(seen, "w", "x")).toBe(false);
    expect(keyedSeen(seen, "v", "a")).toBe(true);
    expect(keyedSeen(seen, "v", "b")).toBe(true);
  });

  it("holds the cap when storage was emptied between marks: memory is the union's base", () => {
    const storageKey = uniqueStorageKey();
    const store = createKeyedSeenStore(storageKey, 2);

    store.getState().markSeen("v", "a");
    store.getState().markSeen("v", "b");
    window.localStorage.removeItem(storageKey);
    store.getState().markSeen("v", "c");

    const { seen } = store.getState();
    expect(Object.keys(seen)).toHaveLength(2);
    expect(keyedSeen(seen, "v", "a")).toBe(false);
    expect(keyedSeen(seen, "v", "b")).toBe(true);
    expect(keyedSeen(seen, "v", "c")).toBe(true);
  });
});
