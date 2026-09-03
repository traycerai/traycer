import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { useResourceMonitorStore } from "@/stores/resources/resource-monitor-store";

const PERSIST_KEY = persistKey(STORE_KEYS.resourceMonitor);

function resetStore(): void {
  window.localStorage.clear();
  useResourceMonitorStore.setState({ sortOption: "tab" });
}

describe("useResourceMonitorStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("starts in tab order", () => {
    expect(useResourceMonitorStore.getState().sortOption).toBe("tab");
  });

  it("persists the chosen ordering", async () => {
    useResourceMonitorStore.getState().setSortOption("memory");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
    ).toEqual({
      state: { sortOption: "memory" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("falls back to tab order for an ordering this build does not know", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { sortOption: "entropy" },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useResourceMonitorStore.persist.rehydrate();

    expect(useResourceMonitorStore.getState().sortOption).toBe("tab");
  });

  // The host this surface reads moved to the shared watch pick, so a record
  // left behind by an older build must not resurrect it here.
  it("ignores a legacy scoped host id left in its persisted record", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { sortOption: "cpu", scopedHostId: "host-b" },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useResourceMonitorStore.persist.rehydrate();
    useResourceMonitorStore.getState().setSortOption("name");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(useResourceMonitorStore.getState()).not.toHaveProperty(
      "scopedHostId",
    );
    expect(
      JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
    ).toEqual({
      state: { sortOption: "name" },
      version: CURRENT_PERSIST_VERSION,
    });
  });
});
