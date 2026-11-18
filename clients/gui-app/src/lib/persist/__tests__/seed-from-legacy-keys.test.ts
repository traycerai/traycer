import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PERSIST_VERSION } from "@/lib/persist";
import { seedPersistedStateFromLegacyKeys } from "@/lib/persist/seed-from-legacy-keys";

const NAME = "traycer-gui-app:seed-target";
const FIRST_LEGACY = "traycer-gui-app:seed-legacy-a";
const SECOND_LEGACY = "traycer-gui-app:seed-legacy-b";

function writeRecord(key: string, state: unknown): void {
  window.localStorage.setItem(
    key,
    JSON.stringify({ state, version: CURRENT_PERSIST_VERSION }),
  );
}

function readRecord(key: string): unknown {
  const raw = window.localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function seed(): void {
  seedPersistedStateFromLegacyKeys({
    name: NAME,
    legacyNames: [FIRST_LEGACY, SECOND_LEGACY],
    seedFrom: (legacyState) =>
      typeof legacyState.pick === "string" && legacyState.pick.length > 0
        ? { pick: legacyState.pick }
        : null,
  });
}

describe("seedPersistedStateFromLegacyKeys", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("seeds from the first legacy record that carries a value", () => {
    writeRecord(FIRST_LEGACY, { tab: "overview", pick: "from-first" });
    writeRecord(SECOND_LEGACY, { sort: "cpu", pick: "from-second" });

    seed();

    expect(readRecord(NAME)).toEqual({
      state: { pick: "from-first" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("falls through to a later legacy record when the earlier carries nothing", () => {
    writeRecord(FIRST_LEGACY, { tab: "overview" });
    writeRecord(SECOND_LEGACY, { pick: "from-second" });

    seed();

    expect(readRecord(NAME)).toEqual({
      state: { pick: "from-second" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("writes nothing when no legacy record carries a value", () => {
    writeRecord(FIRST_LEGACY, { tab: "overview" });
    writeRecord(SECOND_LEGACY, { sort: "cpu" });

    seed();

    expect(window.localStorage.getItem(NAME)).toBeNull();
  });

  it("writes nothing when there are no legacy records at all", () => {
    seed();

    expect(window.localStorage.getItem(NAME)).toBeNull();
  });

  // A record already written under the new key wins outright - re-seeding
  // would overwrite the store's own newer state with a superseded pick.
  it("leaves an existing record under the new key untouched", () => {
    writeRecord(NAME, { pick: "already-chosen" });
    writeRecord(FIRST_LEGACY, { pick: "from-first" });

    seed();

    expect(readRecord(NAME)).toEqual({
      state: { pick: "already-chosen" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("treats an existing record as authoritative even when it holds a default", () => {
    writeRecord(NAME, { pick: null });
    writeRecord(FIRST_LEGACY, { pick: "from-first" });

    seed();

    expect(readRecord(NAME)).toEqual({
      state: { pick: null },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("leaves the legacy records in place", () => {
    writeRecord(FIRST_LEGACY, { tab: "overview", pick: "from-first" });
    writeRecord(SECOND_LEGACY, { sort: "cpu" });

    seed();

    expect(readRecord(FIRST_LEGACY)).toEqual({
      state: { tab: "overview", pick: "from-first" },
      version: CURRENT_PERSIST_VERSION,
    });
    expect(readRecord(SECOND_LEGACY)).toEqual({
      state: { sort: "cpu" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a bare scalar", '"a string"'],
    ["a wrapper with no state", '{"version":1}'],
    ["a wrapper whose state is an array", '{"state":[],"version":1}'],
    ["a wrapper whose state is null", '{"state":null,"version":1}'],
  ])("skips a legacy record that is %s", (_label, raw) => {
    window.localStorage.setItem(FIRST_LEGACY, raw);
    writeRecord(SECOND_LEGACY, { pick: "from-second" });

    seed();

    expect(readRecord(NAME)).toEqual({
      state: { pick: "from-second" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("writes nothing rather than throwing when storage refuses to read", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage is blocked");
    });

    expect(() => {
      seed();
    }).not.toThrow();
  });

  it("swallows a storage that refuses to write", () => {
    writeRecord(FIRST_LEGACY, { pick: "from-first" });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => {
      seed();
    }).not.toThrow();
  });
});
