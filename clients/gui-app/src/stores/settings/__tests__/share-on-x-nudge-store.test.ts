import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isShareOnXNudgeEligible,
  useShareOnXNudgeStore,
} from "@/stores/settings/share-on-x-nudge-store";

const PERSIST_KEY = "traycer-gui-app:share-on-x-nudge";
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const START = Date.UTC(2026, 0, 1);

function resetStore(): void {
  window.localStorage.clear();
  useShareOnXNudgeStore.setState({
    firstSeenAt: null,
    optedOut: false,
    postedAt: null,
    countedShowings: 0,
    nextEligibleAt: 0,
  });
}

function eligibleNow(): boolean {
  return isShareOnXNudgeEligible(useShareOnXNudgeStore.getState(), Date.now());
}

/** An install that first saw the nudge long ago and has nothing pending. */
function seedEligibleInstall(): void {
  useShareOnXNudgeStore.setState({ firstSeenAt: START - 30 * DAY_MS });
}

describe("useShareOnXNudgeStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    resetStore();
  });
  afterEach(() => {
    resetStore();
    vi.useRealTimers();
  });

  it("is not eligible until 24 hours after the install first saw it", () => {
    expect(eligibleNow()).toBe(false);

    useShareOnXNudgeStore.getState().noteSeen(Date.now());
    expect(eligibleNow()).toBe(false);

    vi.setSystemTime(START + DAY_MS - 1);
    expect(eligibleNow()).toBe(false);

    vi.setSystemTime(START + DAY_MS);
    expect(eligibleNow()).toBe(true);
  });

  it("keeps the first noteSeen time", () => {
    useShareOnXNudgeStore.getState().noteSeen(START);
    useShareOnXNudgeStore.getState().noteSeen(START + 5 * DAY_MS);

    expect(useShareOnXNudgeStore.getState().firstSeenAt).toBe(START);
  });

  it.each([
    ["recordTimeout", 3 * DAY_MS, 0],
    ["recordRemindLater", 3 * DAY_MS, 1],
    ["recordClose", 14 * DAY_MS, 1],
    ["recordDialogAbandoned", 14 * DAY_MS, 1],
  ] as const)(
    "%s waits %d ms and counts %d showing(s)",
    (outcome, cooldownMs, counted) => {
      seedEligibleInstall();

      useShareOnXNudgeStore.getState()[outcome](Date.now());

      expect(useShareOnXNudgeStore.getState().countedShowings).toBe(counted);
      vi.setSystemTime(START + cooldownMs - 1);
      expect(eligibleNow()).toBe(false);
      vi.setSystemTime(START + cooldownMs);
      expect(eligibleNow()).toBe(true);
    },
  );

  it("never shows again after an opt-out", () => {
    seedEligibleInstall();
    useShareOnXNudgeStore.getState().recordOptOut();

    vi.setSystemTime(START + 365 * DAY_MS);
    expect(eligibleNow()).toBe(false);
  });

  it("never shows again after the person posted", () => {
    seedEligibleInstall();
    useShareOnXNudgeStore.getState().recordPosted(Date.now());

    vi.setSystemTime(START + 365 * DAY_MS);
    expect(eligibleNow()).toBe(false);
  });

  it("stops after three counted showings", () => {
    seedEligibleInstall();
    for (const expected of [1, 2]) {
      useShareOnXNudgeStore.getState().recordRemindLater(Date.now());
      vi.setSystemTime(Date.now() + 3 * DAY_MS);
      expect(useShareOnXNudgeStore.getState().countedShowings).toBe(expected);
      expect(eligibleNow()).toBe(true);
    }

    useShareOnXNudgeStore.getState().recordRemindLater(Date.now());
    vi.setSystemTime(Date.now() + 365 * DAY_MS);

    expect(useShareOnXNudgeStore.getState().countedShowings).toBe(3);
    expect(eligibleNow()).toBe(false);
  });

  describe("claimShowing", () => {
    it("succeeds once, then refuses until the short cooldown ends", () => {
      seedEligibleInstall();

      expect(useShareOnXNudgeStore.getState().claimShowing(Date.now())).toBe(
        true,
      );
      expect(useShareOnXNudgeStore.getState().nextEligibleAt).toBe(
        START + 3 * DAY_MS,
      );
      expect(useShareOnXNudgeStore.getState().claimShowing(Date.now())).toBe(
        false,
      );

      vi.setSystemTime(START + 3 * DAY_MS);
      expect(useShareOnXNudgeStore.getState().claimShowing(Date.now())).toBe(
        true,
      );
    });

    it("refuses an install that is not eligible", () => {
      expect(useShareOnXNudgeStore.getState().claimShowing(Date.now())).toBe(
        false,
      );
      expect(useShareOnXNudgeStore.getState().nextEligibleAt).toBe(0);
    });

    it("is refused when another window already claimed the showing", () => {
      seedEligibleInstall();
      const otherWindowClaim = {
        state: {
          firstSeenAt: START - 30 * DAY_MS,
          optedOut: false,
          postedAt: null,
          countedShowings: 0,
          nextEligibleAt: START + 3 * DAY_MS,
        },
        version: 1,
      };
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify(otherWindowClaim),
      );

      expect(useShareOnXNudgeStore.getState().claimShowing(Date.now())).toBe(
        false,
      );
    });
  });

  describe("rehydrating a stored record", () => {
    it("falls back to safe defaults field by field", async () => {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: {
            firstSeenAt: "yesterday",
            optedOut: "yes",
            postedAt: { at: 1 },
            countedShowings: -4.7,
            nextEligibleAt: null,
          },
          version: 1,
        }),
      );

      await useShareOnXNudgeStore.persist.rehydrate();

      const state = useShareOnXNudgeStore.getState();
      expect(state.firstSeenAt).toBeNull();
      expect(state.optedOut).toBe(false);
      expect(state.postedAt).toBeNull();
      expect(state.countedShowings).toBe(0);
      expect(state.nextEligibleAt).toBe(0);
    });

    it("keeps a stored opt-out next to corrupt fields", async () => {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: { optedOut: true, firstSeenAt: "x", countedShowings: "many" },
          version: 1,
        }),
      );

      await useShareOnXNudgeStore.persist.rehydrate();

      expect(useShareOnXNudgeStore.getState().optedOut).toBe(true);
      expect(useShareOnXNudgeStore.getState().countedShowings).toBe(0);
    });

    it("keeps the valid fields of a partly corrupt record", async () => {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          state: {
            firstSeenAt: START,
            countedShowings: 2.9,
            nextEligibleAt: "soon",
          },
          version: 1,
        }),
      );

      await useShareOnXNudgeStore.persist.rehydrate();

      const state = useShareOnXNudgeStore.getState();
      expect(state.firstSeenAt).toBe(START);
      expect(state.countedShowings).toBe(2);
      expect(state.nextEligibleAt).toBe(0);
    });

    it("treats a non-object record as empty", async () => {
      window.localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({ state: "garbage", version: 1 }),
      );

      await useShareOnXNudgeStore.persist.rehydrate();

      expect(useShareOnXNudgeStore.getState().firstSeenAt).toBeNull();
      expect(useShareOnXNudgeStore.getState().optedOut).toBe(false);
    });
  });
});
