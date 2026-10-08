import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { useLimitedBannerDismissalsStore } from "@/stores/rate-limits/limited-banner-dismissals-store";

const PERSIST_KEY = persistKey(STORE_KEYS.limitedBannerDismissals);
const NOW = 1_000_000;

function resetStore(): void {
  window.localStorage.clear();
  useLimitedBannerDismissalsStore.setState({ dismissals: {} });
}

function dismissals() {
  return useLimitedBannerDismissalsStore.getState().dismissals;
}

describe("useLimitedBannerDismissalsStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("dismiss stores the reset time under its own host", () => {
    const { dismiss } = useLimitedBannerDismissalsStore.getState();
    dismiss("host-a", "codex:p1", NOW + 5);
    dismiss("host-b", "codex:p1", null);

    expect(dismissals()).toEqual({
      "host-a": { "codex:p1": NOW + 5 },
      "host-b": { "codex:p1": null },
    });
  });

  it("prune drops a timed entry whose reset has passed on any host and keeps a future one", () => {
    useLimitedBannerDismissalsStore.setState({
      dismissals: {
        "host-a": { "codex:old": NOW - 1, "codex:future": NOW + 1 },
        "host-b": { "codex:edge": NOW, "claude-code:future": NOW + 9 },
      },
    });

    useLimitedBannerDismissalsStore.getState().prune("host-a", new Set(), NOW);

    expect(dismissals()).toEqual({
      "host-a": { "codex:future": NOW + 1 },
      "host-b": { "claude-code:future": NOW + 9 },
    });
  });

  it("prune drops a null entry only on the given host and only when its key is cleared", () => {
    useLimitedBannerDismissalsStore.setState({
      dismissals: {
        "host-a": { "codex:cleared": null, "codex:loading": null },
        "host-b": { "codex:cleared": null },
      },
    });

    useLimitedBannerDismissalsStore
      .getState()
      .prune("host-a", new Set(["codex:cleared"]), NOW);

    expect(dismissals()).toEqual({
      "host-a": { "codex:loading": null },
      "host-b": { "codex:cleared": null },
    });
  });

  it("prune leaves the state object untouched when nothing is stale", () => {
    useLimitedBannerDismissalsStore.setState({
      dismissals: { "host-a": { "codex:p1": NOW + 1, "codex:p2": null } },
    });
    const before = dismissals();

    useLimitedBannerDismissalsStore.getState().prune("host-a", new Set(), NOW);

    expect(dismissals()).toBe(before);
  });

  it("persists the dismissals", async () => {
    useLimitedBannerDismissalsStore
      .getState()
      .dismiss("host-a", "codex:p1", NOW + 5);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
    ).toEqual({
      state: { dismissals: { "host-a": { "codex:p1": NOW + 5 } } },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("filters garbage out of persisted state on rehydrate", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          dismissals: {
            "host-a": {
              good: 42,
              none: null,
              text: "soon",
              flag: true,
              nested: { a: 1 },
            },
            "host-bad": "nope",
            "host-empty": { text: "x" },
            "host-null": null,
          },
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useLimitedBannerDismissalsStore.persist.rehydrate();

    expect(dismissals()).toEqual({ "host-a": { good: 42, none: null } });
  });

  it("rehydrates to empty when the persisted dismissals are not an object", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { dismissals: "garbage" },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useLimitedBannerDismissalsStore.persist.rehydrate();

    expect(dismissals()).toEqual({});
  });
});
