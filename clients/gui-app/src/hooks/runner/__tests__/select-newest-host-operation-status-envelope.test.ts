import { describe, expect, it } from "vitest";
import type { HostOperationStatusEnvelope } from "@traycer-clients/shared/platform/runner-host";
import { selectNewestHostOperationStatusEnvelope } from "../use-runner-host-operation-status-query";

describe("selectNewestHostOperationStatusEnvelope", () => {
  const staleActive: HostOperationStatusEnvelope = {
    revision: 3,
    status: {
      operationId: "op-stale",
      kind: "ensure",
      stage: "applying",
      percent: null,
      bytes: null,
      totalBytes: null,
      message: null,
      startedAt: "2026-05-15T00:00:00Z",
    },
    lastEnsureOutcome: null,
  };
  const freshSettled: HostOperationStatusEnvelope = {
    revision: 4,
    status: null,
    lastEnsureOutcome: {
      operationId: "op-stale",
      revision: 4,
      result: {
        action: "already-ready",
        running: true,
        version: "1.2.3",
      },
      busyHostPid: null,
    },
  };

  it("keeps the higher revision when a pushed-null races a stale active snapshot", () => {
    // Push null first, then a stale active snapshot arrives late.
    expect(
      selectNewestHostOperationStatusEnvelope(freshSettled, staleActive),
    ).toEqual(freshSettled);
    // Stale snapshot first, then pushed null settles.
    expect(
      selectNewestHostOperationStatusEnvelope(staleActive, freshSettled),
    ).toEqual(freshSettled);
  });

  it("accepts the first envelope when no current cache entry exists", () => {
    expect(
      selectNewestHostOperationStatusEnvelope(undefined, staleActive),
    ).toEqual(staleActive);
  });
});
