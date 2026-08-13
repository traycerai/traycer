import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";

const PERSIST_KEY = persistKey(STORE_KEYS.rateLimitPopover);

function resetStore(): void {
  window.localStorage.clear();
  useRateLimitPopoverStore.setState({
    activeTab: "overview",
    size: null,
    scopedHostId: null,
  });
}

describe("useRateLimitPopoverStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("initializes on Overview, following the active host", () => {
    expect(useRateLimitPopoverStore.getState().activeTab).toBe("overview");
    expect(useRateLimitPopoverStore.getState().size).toBeNull();
    expect(useRateLimitPopoverStore.getState().scopedHostId).toBeNull();
  });

  it("persists the last selected provider tab", async () => {
    useRateLimitPopoverStore.getState().setActiveTab("codex");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: { activeTab: "codex", size: null, scopedHostId: null },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("persists the last dragged size", async () => {
    useRateLimitPopoverStore
      .getState()
      .setSize({ widthPx: 560, heightPx: 420 });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: {
        activeTab: "overview",
        size: { widthPx: 560, heightPx: 420 },
        scopedHostId: null,
      },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("persists an explicitly picked host id", async () => {
    useRateLimitPopoverStore.getState().setScopedHostId("host-b");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: { activeTab: "overview", size: null, scopedHostId: "host-b" },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("drops the persisted pick and returns to following on setScopedHostId(null)", async () => {
    useRateLimitPopoverStore.getState().setScopedHostId("host-b");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    useRateLimitPopoverStore.getState().setScopedHostId(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: { activeTab: "overview", size: null, scopedHostId: null },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("rehydrates a valid saved tab", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { activeTab: "claude-code" },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useRateLimitPopoverStore.persist.rehydrate();

    expect(useRateLimitPopoverStore.getState().activeTab).toBe("claude-code");
    expect(useRateLimitPopoverStore.getState().size).toBeNull();
  });

  it("rehydrates a valid saved size", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          activeTab: "overview",
          size: { widthPx: 620, heightPx: 480 },
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useRateLimitPopoverStore.persist.rehydrate();

    expect(useRateLimitPopoverStore.getState().size).toEqual({
      widthPx: 620,
      heightPx: 480,
    });
  });

  it("falls back to Overview when persisted tab data is invalid", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { activeTab: "missing-provider" },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useRateLimitPopoverStore.persist.rehydrate();

    expect(useRateLimitPopoverStore.getState().activeTab).toBe("overview");
  });

  it("drops invalid persisted size data", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          activeTab: "overview",
          size: { widthPx: -1, heightPx: "large" },
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useRateLimitPopoverStore.persist.rehydrate();

    expect(useRateLimitPopoverStore.getState().size).toBeNull();
  });

  it("rehydrates a valid saved scoped host id", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { activeTab: "overview", scopedHostId: "host-b" },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useRateLimitPopoverStore.persist.rehydrate();

    expect(useRateLimitPopoverStore.getState().scopedHostId).toBe("host-b");
  });

  it("rehydrates a missing scoped host id to null (follow the active host)", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { activeTab: "overview" },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useRateLimitPopoverStore.persist.rehydrate();

    expect(useRateLimitPopoverStore.getState().scopedHostId).toBeNull();
  });

  // A host id is opaque to this store, so the only thing rehydration can
  // check is "a non-empty string someone could have picked"
  // (`persistedScopedHostId`). Anything else drops to `null` rather than
  // handing a garbage value on to `resolveScopedHost`.
  it.each([
    ["a number", 42],
    ["an empty string", ""],
    ["null", null],
  ])(
    "drops a persisted scoped host id that is %s",
    async (_label, scopedHostId) => {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: { activeTab: "overview", scopedHostId },
          version: CURRENT_PERSIST_VERSION,
        }),
      );

      await useRateLimitPopoverStore.persist.rehydrate();

      expect(useRateLimitPopoverStore.getState().scopedHostId).toBeNull();
    },
  );
});
