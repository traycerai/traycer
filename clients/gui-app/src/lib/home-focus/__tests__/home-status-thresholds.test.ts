import { describe, expect, it } from "vitest";
import {
  HOME_STATUS_ROW_TTL_MS,
  HOME_STATUS_STALE_MS,
  type HomeStatusRow,
} from "@traycer/protocol/notifications/home-status-room";
import {
  DEFAULT_HOME_STATUS_THRESHOLDS,
  HOME_STATUS_DONE_HIDE_OPTIONS,
  isHomeStatusRowHiddenFor,
  isHomeStatusRowStaleFor,
  resolveHomeStatusThresholds,
} from "@/lib/home-focus/home-status-thresholds";

const NOW = 1_800_000_000_000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function row(overrides: Partial<HomeStatusRow>): HomeStatusRow {
  return {
    key: "row",
    status: "in-progress",
    item: "Item",
    note: "",
    agentId: "agent-1",
    agentName: "Agent",
    epicId: "epic-1",
    hostId: "host-1",
    harnessId: null,
    updatedAt: NOW,
    ...overrides,
  };
}

const ninetyMinutesAgo = NOW - 90 * MINUTE_MS;

describe("home status thresholds", () => {
  it("defaults to the protocol's own rules", () => {
    expect(DEFAULT_HOME_STATUS_THRESHOLDS).toEqual({
      inProgressStaleAfterMs: HOME_STATUS_STALE_MS,
      needsYouStaleAfterMs: null,
      doneHideAfterMs: DAY_MS,
    });
  });

  describe("in progress — stale after", () => {
    it("marks a 90-minute-old row stale at 1 h, not at the 2 h default", () => {
      const r = row({ status: "in-progress", updatedAt: ninetyMinutesAgo });
      expect(
        isHomeStatusRowStaleFor(
          r,
          NOW,
          resolveHomeStatusThresholds("1h", "never", "24h"),
        ),
      ).toBe(true);
      expect(
        isHomeStatusRowStaleFor(r, NOW, DEFAULT_HOME_STATUS_THRESHOLDS),
      ).toBe(false);
    });

    it("never marks anything stale at Never", () => {
      const thresholds = resolveHomeStatusThresholds("never", "never", "24h");
      expect(
        isHomeStatusRowStaleFor(
          row({
            status: "in-progress",
            updatedAt: NOW - 6 * 24 * 60 * MINUTE_MS,
          }),
          NOW,
          thresholds,
        ),
      ).toBe(false);
    });
  });

  describe("needs you — stale after", () => {
    it("is never stale by default, however old", () => {
      expect(
        isHomeStatusRowStaleFor(
          row({
            status: "needs-you",
            updatedAt: NOW - 6 * 24 * 60 * MINUTE_MS,
          }),
          NOW,
          DEFAULT_HOME_STATUS_THRESHOLDS,
        ),
      ).toBe(false);
    });

    it("goes stale past its own threshold, independent of in progress", () => {
      const thresholds = resolveHomeStatusThresholds("never", "1h", "24h");
      expect(
        isHomeStatusRowStaleFor(
          row({ status: "needs-you", updatedAt: ninetyMinutesAgo }),
          NOW,
          thresholds,
        ),
      ).toBe(true);
      expect(
        isHomeStatusRowStaleFor(
          row({ status: "in-progress", updatedAt: ninetyMinutesAgo }),
          NOW,
          thresholds,
        ),
      ).toBe(false);
    });
  });

  describe("done — hide after", () => {
    it("never marks a done row stale", () => {
      expect(
        isHomeStatusRowStaleFor(
          row({ status: "done", updatedAt: ninetyMinutesAgo }),
          NOW,
          resolveHomeStatusThresholds("30m", "1h", "24h"),
        ),
      ).toBe(false);
    });

    it("hides a done row past the chosen time, and only a done row", () => {
      const thresholds = resolveHomeStatusThresholds("2h", "never", "1h");
      expect(
        isHomeStatusRowHiddenFor(
          row({ status: "done", updatedAt: ninetyMinutesAgo }),
          NOW,
          thresholds,
        ),
      ).toBe(true);
      expect(
        isHomeStatusRowHiddenFor(
          row({ status: "done", updatedAt: ninetyMinutesAgo }),
          NOW,
          DEFAULT_HOME_STATUS_THRESHOLDS,
        ),
      ).toBe(false);
      expect(
        isHomeStatusRowHiddenFor(
          row({ status: "in-progress", updatedAt: ninetyMinutesAgo }),
          NOW,
          thresholds,
        ),
      ).toBe(false);
    });

    it("keeps a done row until the 7-day row TTL at Never", () => {
      const thresholds = resolveHomeStatusThresholds("2h", "never", "never");
      expect(thresholds.doneHideAfterMs).toBeNull();
      expect(
        isHomeStatusRowHiddenFor(
          row({ status: "done", updatedAt: NOW - HOME_STATUS_ROW_TTL_MS }),
          NOW,
          thresholds,
        ),
      ).toBe(false);
      expect(
        isHomeStatusRowHiddenFor(
          row({ status: "done", updatedAt: NOW - HOME_STATUS_ROW_TTL_MS - 1 }),
          NOW,
          thresholds,
        ),
      ).toBe(true);
    });

    it("offers Never last, and no finite choice past the row TTL", () => {
      expect(HOME_STATUS_DONE_HIDE_OPTIONS.at(-1)?.value).toBe("never");
      for (const option of HOME_STATUS_DONE_HIDE_OPTIONS) {
        if (option.ms === null) continue;
        expect(option.ms).toBeLessThan(HOME_STATUS_ROW_TTL_MS);
      }
    });
  });

  it("hides any row past the protocol's 7-day TTL whatever the settings", () => {
    const thresholds = resolveHomeStatusThresholds("never", "never", "24h");
    expect(
      isHomeStatusRowHiddenFor(
        row({
          status: "needs-you",
          updatedAt: NOW - HOME_STATUS_ROW_TTL_MS - 1,
        }),
        NOW,
        thresholds,
      ),
    ).toBe(true);
  });
});
