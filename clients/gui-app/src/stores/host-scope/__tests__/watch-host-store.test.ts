import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";

const PERSIST_KEY = persistKey(STORE_KEYS.watchHost);
const LEGACY_RATE_LIMIT_KEY = persistKey(STORE_KEYS.rateLimitPopover);
const LEGACY_RESOURCE_KEY = persistKey(STORE_KEYS.resourceMonitor);

// The store's own `setState` goes through the persist middleware and WRITES,
// so the reset has to end with an empty storage, not begin with one - a record
// left behind here would look to the next case like a store that has already
// been written.
function resetStore(): void {
  useWatchHostStore.setState({ scopedHostId: null, scopedHostName: null });
  window.localStorage.clear();
}

function writeRecord(key: string, state: unknown): void {
  window.localStorage.setItem(
    key,
    JSON.stringify({ state, version: CURRENT_PERSIST_VERSION }),
  );
}

/**
 * A fresh module graph, so the module-load seed runs against whatever this case
 * put in storage first. The migration happens BEFORE hydration by construction,
 * so it cannot be exercised through the already-imported singleton.
 */
async function launchWithFreshModules(): Promise<string | null> {
  vi.resetModules();
  const module = await import("@/stores/host-scope/watch-host-store");
  await module.useWatchHostStore.persist.rehydrate();
  return module.useWatchHostStore.getState().scopedHostId;
}

describe("useWatchHostStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("starts out following the active host", () => {
    expect(useWatchHostStore.getState().scopedHostId).toBeNull();
  });

  it("persists an explicitly picked host name", () => {
    useWatchHostStore
      .getState()
      .selectHost({ hostId: "host-b", name: "Bravo" });

    expect(
      JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
    ).toEqual({
      state: { scopedHostId: "host-b", scopedHostName: "Bravo" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("clears the picked id and name on a null pick", () => {
    useWatchHostStore
      .getState()
      .selectHost({ hostId: "host-b", name: "Bravo" });
    useWatchHostStore.getState().setScopedHostId(null);

    expect(
      JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
    ).toEqual({
      state: { scopedHostId: null, scopedHostName: null },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("rehydrates a pre-change id-only pick without inventing a name", async () => {
    writeRecord(PERSIST_KEY, { scopedHostId: "host-c" });

    await useWatchHostStore.persist.rehydrate();

    expect(useWatchHostStore.getState()).toMatchObject({
      scopedHostId: "host-c",
      scopedHostName: null,
    });
  });

  it("rehydrates the name recorded with a picked host", async () => {
    writeRecord(PERSIST_KEY, {
      scopedHostId: "host-c",
      scopedHostName: "Charlie",
    });

    await useWatchHostStore.persist.rehydrate();

    expect(useWatchHostStore.getState()).toMatchObject({
      scopedHostId: "host-c",
      scopedHostName: "Charlie",
    });
  });

  it("clears a retained name when the raw id-only setter changes hosts", () => {
    useWatchHostStore
      .getState()
      .selectHost({ hostId: "host-b", name: "Bravo" });
    useWatchHostStore.getState().setScopedHostId("host-c");

    expect(useWatchHostStore.getState()).toMatchObject({
      scopedHostId: "host-c",
      scopedHostName: null,
    });
  });

  it.each([
    ["a number", 42],
    ["an empty string", ""],
    ["null", null],
  ])("drops its own persisted pick when it is %s", async (_label, value) => {
    writeRecord(PERSIST_KEY, { scopedHostId: value });

    await useWatchHostStore.persist.rehydrate();

    expect(useWatchHostStore.getState().scopedHostId).toBeNull();
  });

  it("follows the active host when there is no record at all", async () => {
    await useWatchHostStore.persist.rehydrate();

    expect(useWatchHostStore.getState().scopedHostId).toBeNull();
  });

  describe("migration off the two per-surface picks", () => {
    it("adopts the usage pick when both surfaces named a host", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, {
        activeTab: "overview",
        scopedHostId: "host-usage",
      });
      writeRecord(LEGACY_RESOURCE_KEY, {
        sortOption: "tab",
        scopedHostId: "host-resources",
      });

      expect(await launchWithFreshModules()).toBe("host-usage");
    });

    it("falls through to the resource pick when only that surface named a host", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, { activeTab: "overview" });
      writeRecord(LEGACY_RESOURCE_KEY, { scopedHostId: "host-resources" });

      expect(await launchWithFreshModules()).toBe("host-resources");
    });

    it("follows the active host when neither legacy record named one", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, { activeTab: "codex" });
      writeRecord(LEGACY_RESOURCE_KEY, { sortOption: "cpu" });

      expect(await launchWithFreshModules()).toBeNull();
    });

    it("ignores a legacy pick that is not a usable host id", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, { scopedHostId: "" });
      writeRecord(LEGACY_RESOURCE_KEY, { scopedHostId: 7 });

      expect(await launchWithFreshModules()).toBeNull();
    });

    // The adoption writes the new key, so the legacy records are read exactly
    // once - a later launch reads only this store's own record.
    it("writes its own record so the adoption never runs twice", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, { scopedHostId: "host-usage" });

      expect(await launchWithFreshModules()).toBe("host-usage");
      expect(
        JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
      ).toEqual({
        state: { scopedHostId: "host-usage" },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    it("leaves the two legacy records intact", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, {
        activeTab: "codex",
        size: { widthPx: 560, heightPx: 420 },
        scopedHostId: "host-usage",
      });
      writeRecord(LEGACY_RESOURCE_KEY, { sortOption: "memory" });

      await launchWithFreshModules();

      expect(
        JSON.parse(window.localStorage.getItem(LEGACY_RATE_LIMIT_KEY) ?? "{}"),
      ).toEqual({
        state: {
          activeTab: "codex",
          size: { widthPx: 560, heightPx: 420 },
          scopedHostId: "host-usage",
        },
        version: CURRENT_PERSIST_VERSION,
      });
      expect(
        JSON.parse(window.localStorage.getItem(LEGACY_RESOURCE_KEY) ?? "{}"),
      ).toEqual({
        state: { sortOption: "memory" },
        version: CURRENT_PERSIST_VERSION,
      });
    });

    // A record under the new key wins outright, value included: a deliberate
    // return to the active host has to outlive a relaunch rather than being
    // undone by a legacy record nobody has rewritten yet.
    it("never revisits the legacy records once its own record exists", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, { scopedHostId: "host-usage" });
      writeRecord(PERSIST_KEY, { scopedHostId: null });

      expect(await launchWithFreshModules()).toBeNull();
    });

    it("prefers its own pick over a legacy record naming another host", async () => {
      writeRecord(LEGACY_RATE_LIMIT_KEY, { scopedHostId: "host-usage" });
      writeRecord(PERSIST_KEY, { scopedHostId: "host-picked" });

      expect(await launchWithFreshModules()).toBe("host-picked");
    });
  });
});
