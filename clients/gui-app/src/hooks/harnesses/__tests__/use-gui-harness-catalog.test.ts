import { describe, expect, it } from "vitest";
import type { ListGuiHarnessesResponse } from "@traycer/protocol/host/index";
import {
  nextHarnessAvailabilityRefetchInterval,
  nextHarnessModelRefetchInterval,
} from "@/hooks/harnesses/use-gui-harness-catalog";

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

function response(
  available: boolean,
  availabilityPending: boolean,
): ListGuiHarnessesResponse {
  return {
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        enabled: true,
        available,
        error: available ? null : "probe timed out",
        modes: ["gui", "tui"],
        requiresApiKey: false,
        supportedPermissionModes: [
          "supervised",
          "auto_accept_edits",
          "full_access",
        ],
        availabilityPending,
      },
    ],
  };
}

const PENDING_REFRESH_MS = 800;

describe("nextHarnessAvailabilityRefetchInterval", () => {
  it("keeps the steady-state interval before any data arrives", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "no-data",
        dataUpdateCount: 0,
        data: undefined,
      }),
    ).toBe(FIFTEEN_MIN_MS);
  });

  it("keeps the steady-state interval when every harness is available", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "all-available",
        dataUpdateCount: 1,
        data: response(true, false),
      }),
    ).toBe(FIFTEEN_MIN_MS);
  });

  it("fast-polls at 800ms when any harness has availabilityPending", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "pending",
        dataUpdateCount: 1,
        data: response(false, true),
      }),
    ).toBe(PENDING_REFRESH_MS);
  });

  it("retries at the host-cache TTL on the first unavailable result", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "first-unavailable",
        dataUpdateCount: 1,
        data: response(false, false),
      }),
    ).toBe(RETRY_MIN_MS);
  });

  it("backs off exponentially toward the ceiling across successive fetches", () => {
    const hash = "backoff";
    const intervals = [1, 2, 3, 4, 5, 6].map((dataUpdateCount) =>
      nextHarnessAvailabilityRefetchInterval({
        queryHash: hash,
        dataUpdateCount,
        data: response(false, false),
      }),
    );
    expect(intervals).toEqual([
      RETRY_MIN_MS, // 30s
      RETRY_MIN_MS * 2, // 1m
      RETRY_MIN_MS * 4, // 2m
      RETRY_MIN_MS * 8, // 4m
      RETRY_MAX_MS, // capped at 5m
      RETRY_MAX_MS,
    ]);
  });

  it("does not advance the backoff when re-evaluated for the same fetch", () => {
    const hash = "same-fetch";
    const first = nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 7,
      data: response(false, false),
    });
    const second = nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 7,
      data: response(false, false),
    });
    expect(first).toBe(RETRY_MIN_MS);
    expect(second).toBe(RETRY_MIN_MS);
  });

  it("resets the backoff once the catalog recovers", () => {
    const hash = "recovery";
    nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 1,
      data: response(false, false),
    });
    nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 2,
      data: response(false, false),
    });
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: hash,
        dataUpdateCount: 3,
        data: response(true, false),
      }),
    ).toBe(FIFTEEN_MIN_MS);
    // A later drop starts the backoff over from the host-cache TTL.
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: hash,
        dataUpdateCount: 4,
        data: response(false, false),
      }),
    ).toBe(RETRY_MIN_MS);
  });
});

describe("nextHarnessModelRefetchInterval", () => {
  it("keeps the steady-state interval while model queries are healthy", () => {
    expect(
      nextHarnessModelRefetchInterval({
        queryHash: "models-healthy",
        errorUpdateCount: 0,
        error: null,
      }),
    ).toBe(FIFTEEN_MIN_MS);
  });

  it("retries failed model catalogs quickly, then backs off toward the ceiling", () => {
    const hash = "models-error";
    const intervals = [1, 2, 3, 4, 5, 6].map((errorUpdateCount) =>
      nextHarnessModelRefetchInterval({
        queryHash: hash,
        errorUpdateCount,
        error: new Error("catalog timeout"),
      }),
    );
    expect(intervals).toEqual([
      RETRY_MIN_MS,
      RETRY_MIN_MS * 2,
      RETRY_MIN_MS * 4,
      RETRY_MIN_MS * 8,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
    ]);
  });

  it("does not advance model backoff when re-evaluated for the same error", () => {
    const hash = "models-same-error";
    const first = nextHarnessModelRefetchInterval({
      queryHash: hash,
      errorUpdateCount: 3,
      error: new Error("catalog timeout"),
    });
    const second = nextHarnessModelRefetchInterval({
      queryHash: hash,
      errorUpdateCount: 3,
      error: new Error("catalog timeout"),
    });
    expect(first).toBe(RETRY_MIN_MS);
    expect(second).toBe(RETRY_MIN_MS);
  });

  it("resets model backoff once the catalog recovers", () => {
    const hash = "models-recovery";
    nextHarnessModelRefetchInterval({
      queryHash: hash,
      errorUpdateCount: 1,
      error: new Error("catalog timeout"),
    });
    nextHarnessModelRefetchInterval({
      queryHash: hash,
      errorUpdateCount: 2,
      error: new Error("catalog timeout"),
    });
    expect(
      nextHarnessModelRefetchInterval({
        queryHash: hash,
        errorUpdateCount: 2,
        error: null,
      }),
    ).toBe(FIFTEEN_MIN_MS);
    expect(
      nextHarnessModelRefetchInterval({
        queryHash: hash,
        errorUpdateCount: 3,
        error: new Error("catalog timeout"),
      }),
    ).toBe(RETRY_MIN_MS);
  });
});
