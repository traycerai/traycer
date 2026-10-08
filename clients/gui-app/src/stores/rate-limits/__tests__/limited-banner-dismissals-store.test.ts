import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { NO_RESET_DISMISSAL_MS } from "@/lib/rate-limits/limited-profiles";
import type { LimitedBannerDismissals } from "@/stores/rate-limits/limited-banner-dismissals-store";
import { useLimitedBannerDismissalsStore } from "@/stores/rate-limits/limited-banner-dismissals-store";

const PERSIST_KEY = persistKey(STORE_KEYS.limitedBannerDismissals);
const NOW = 1_000_000;

function resetStore(): void {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useLimitedBannerDismissalsStore.setState({ dismissals: {} });
}

function dismissals() {
  return useLimitedBannerDismissalsStore.getState().dismissals;
}

/** What another renderer wrote: straight to storage, not through this store. */
function writeStorage(value: LimitedBannerDismissals): void {
  window.localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({
      state: { dismissals: value },
      version: CURRENT_PERSIST_VERSION,
    }),
  );
}

/** Seed through storage and apply it (synchronous for localStorage). */
function seed(value: LimitedBannerDismissals): void {
  writeStorage(value);
  void useLimitedBannerDismissalsStore.persist.rehydrate();
}

function storedDismissals(): unknown {
  const raw: unknown = JSON.parse(
    window.localStorage.getItem(PERSIST_KEY) ?? "{}",
  );
  if (typeof raw !== "object" || raw === null || !("state" in raw)) return null;
  const state: unknown = raw.state;
  if (typeof state !== "object" || state === null) return null;
  return "dismissals" in state ? state.dismissals : null;
}

function timed(resetsAt: number) {
  return { resetsAt, dismissedAt: NOW - 500 };
}

describe("useLimitedBannerDismissalsStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("dismiss stores the reset time and the dismissal time under its own host", () => {
    const { dismiss } = useLimitedBannerDismissalsStore.getState();
    dismiss("host-a", "codex:p1", NOW + 5, NOW);
    dismiss("host-b", "codex:p1", null, NOW + 1);

    expect(dismissals()).toEqual({
      "host-a": { "codex:p1": { resetsAt: NOW + 5, dismissedAt: NOW } },
      "host-b": { "codex:p1": { resetsAt: null, dismissedAt: NOW + 1 } },
    });
  });

  it("prune drops a timed entry whose reset has passed on any host and keeps a future one", () => {
    seed({
      "host-a": {
        "codex:old": timed(NOW - 1),
        "codex:future": timed(NOW + 1),
      },
      "host-b": {
        "codex:edge": timed(NOW),
        "claude-code:future": timed(NOW + 9),
      },
    });

    useLimitedBannerDismissalsStore.getState().prune("host-a", new Map(), NOW);

    expect(dismissals()).toEqual({
      "host-a": { "codex:future": timed(NOW + 1) },
      "host-b": { "claude-code:future": timed(NOW + 9) },
    });
  });

  it("prune drops a no-reset entry a day old on any host and keeps a younger one", () => {
    const expired = {
      resetsAt: null,
      dismissedAt: NOW - NO_RESET_DISMISSAL_MS,
    };
    const young = {
      resetsAt: null,
      dismissedAt: NOW - NO_RESET_DISMISSAL_MS + 1,
    };
    seed({
      "host-a": { "codex:expired": expired, "codex:young": young },
      "host-b": { "codex:expired": expired, "codex:young": young },
    });

    useLimitedBannerDismissalsStore.getState().prune("host-a", new Map(), NOW);

    expect(dismissals()).toEqual({
      "host-a": { "codex:young": young },
      "host-b": { "codex:young": young },
    });
  });

  it("prune drops a null entry only on the given host and only when its key is cleared", () => {
    const none = { resetsAt: null, dismissedAt: 1000 };
    seed({
      "host-a": { "codex:cleared": none, "codex:loading": none },
      "host-b": { "codex:cleared": none },
    });

    useLimitedBannerDismissalsStore
      .getState()
      .prune("host-a", new Map([["codex:cleared", 2000]]), NOW);

    expect(dismissals()).toEqual({
      "host-a": { "codex:loading": none },
      "host-b": { "codex:cleared": none },
    });
  });

  it("prune keeps a null entry for a healthy reading older than or equal to the dismissal, and drops it for a newer one", () => {
    const none = { resetsAt: null, dismissedAt: 1000 };
    const { prune } = useLimitedBannerDismissalsStore.getState();
    seed({ "host-a": { "codex:p1": none } });

    prune("host-a", new Map([["codex:p1", 999]]), NOW);
    expect(dismissals()).toEqual({ "host-a": { "codex:p1": none } });

    prune("host-a", new Map([["codex:p1", 1000]]), NOW);
    expect(dismissals()).toEqual({ "host-a": { "codex:p1": none } });

    prune("host-a", new Map([["codex:p1", 1001]]), NOW);
    expect(dismissals()).toEqual({});
  });

  it("prune keeps a timed entry for a healthy reading not newer than the dismissal, and drops it for a newer one", () => {
    const entry = { resetsAt: NOW + 3_600_000, dismissedAt: 1000 };
    const { prune } = useLimitedBannerDismissalsStore.getState();
    seed({ "host-a": { "codex:p1": entry } });

    prune("host-a", new Map([["codex:p1", 999]]), NOW);
    expect(dismissals()).toEqual({ "host-a": { "codex:p1": entry } });

    prune("host-a", new Map([["codex:p1", 1000]]), NOW);
    expect(dismissals()).toEqual({ "host-a": { "codex:p1": entry } });

    prune("host-a", new Map([["codex:p1", 1001]]), NOW);
    expect(dismissals()).toEqual({});
  });

  it("prune does not drop another host's timed entry for a clearing reading of the given host", () => {
    const entry = { resetsAt: NOW + 3_600_000, dismissedAt: 1000 };
    seed({
      "host-a": { "codex:p1": entry },
      "host-b": { "codex:p1": entry },
    });

    useLimitedBannerDismissalsStore
      .getState()
      .prune("host-a", new Map([["codex:p1", 2000]]), NOW);

    expect(dismissals()).toEqual({ "host-b": { "codex:p1": entry } });
  });

  it("prune writes storage only when it removes something", () => {
    seed({
      "host-a": {
        "codex:keep": timed(NOW + 1),
        "codex:old": timed(NOW - 1),
      },
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const writesToKey = () =>
      setItem.mock.calls.filter(([key]) => key === PERSIST_KEY).length;
    const { prune } = useLimitedBannerDismissalsStore.getState();

    prune("host-a", new Map(), NOW - 10);
    expect(writesToKey()).toBe(0);

    prune("host-a", new Map(), NOW);
    expect(writesToKey()).toBeGreaterThan(0);
  });

  it("prune with nothing to remove keeps another window's dismissal that this store has not heard of", () => {
    const fromWindowA = {
      "host-a": { "codex:p1": timed(NOW + 5) },
    };
    writeStorage(fromWindowA);

    useLimitedBannerDismissalsStore.getState().prune("host-a", new Map(), NOW);

    expect(storedDismissals()).toEqual(fromWindowA);
    expect(dismissals()).toEqual(fromWindowA);
  });

  it("dismiss of another key keeps another window's dismissal that this store has not heard of", () => {
    const fromWindowA = { "codex:p1": timed(NOW + 5) };
    writeStorage({ "host-a": fromWindowA });

    useLimitedBannerDismissalsStore
      .getState()
      .dismiss("host-a", "codex:p2", NOW + 9, NOW);

    const both = {
      "host-a": {
        ...fromWindowA,
        "codex:p2": { resetsAt: NOW + 9, dismissedAt: NOW },
      },
    };
    expect(storedDismissals()).toEqual(both);
    expect(dismissals()).toEqual(both);
  });

  it("persists the dismissals", async () => {
    useLimitedBannerDismissalsStore
      .getState()
      .dismiss("host-a", "codex:p1", NOW + 5, NOW);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
    ).toEqual({
      state: {
        dismissals: {
          "host-a": { "codex:p1": { resetsAt: NOW + 5, dismissedAt: NOW } },
        },
      },
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
              good: { resetsAt: 42, dismissedAt: 7 },
              none: { resetsAt: null, dismissedAt: 8 },
              bare: 42,
              bareNull: null,
              noAt: { resetsAt: 42 },
              text: { resetsAt: "soon", dismissedAt: 1 },
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

    expect(dismissals()).toEqual({
      "host-a": {
        good: { resetsAt: 42, dismissedAt: 7 },
        none: { resetsAt: null, dismissedAt: 8 },
      },
    });
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
