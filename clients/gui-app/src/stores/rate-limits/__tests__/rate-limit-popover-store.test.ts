import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";

const PERSIST_KEY = persistKey(STORE_KEYS.rateLimitPopover);

function resetStore(): void {
  window.localStorage.clear();
  useRateLimitPopoverStore.setState({ activeTab: "overview" });
}

describe("useRateLimitPopoverStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("initializes on Overview", () => {
    expect(useRateLimitPopoverStore.getState().activeTab).toBe("overview");
  });

  it("persists the last selected provider tab", async () => {
    useRateLimitPopoverStore.getState().setActiveTab("codex");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: { activeTab: "codex" },
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
});
