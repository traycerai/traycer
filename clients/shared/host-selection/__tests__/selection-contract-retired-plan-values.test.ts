import { describe, expect, it } from "vitest";
import {
  parseLeaseSnapshot,
  parseSelectionEvidenceReport,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";

/**
 * Remote hosts are on every plan, so the contract no longer has a
 * `plan-restricted` dead reason or a dial `refusalDetail`. A window on an
 * older build can still send both across the authority seam while an update
 * rolls out, so the raw-boundary parsers have to read them as the ordinary
 * values they now are rather than drop the report or keep the retired word.
 */
describe("retired plan values at the selection contract's raw boundary", () => {
  it("reads a dead lease with the retired plan-restricted reason as offline", () => {
    expect(
      parseLeaseSnapshot({
        hostId: "host-1",
        status: "dead",
        dead: { reason: "plan-restricted" },
      }),
    ).toEqual({
      hostId: "host-1",
      status: "dead",
      dead: { reason: "offline" },
    });
  });

  it("keeps the dead reasons that survive", () => {
    expect(
      parseLeaseSnapshot({
        hostId: "host-1",
        status: "dead",
        dead: { reason: "removed" },
      }),
    ).toEqual({
      hostId: "host-1",
      status: "dead",
      dead: { reason: "removed" },
    });
    expect(
      parseLeaseSnapshot({
        hostId: "host-1",
        status: "dead",
        dead: { reason: "offline" },
      }),
    ).toEqual({
      hostId: "host-1",
      status: "dead",
      dead: { reason: "offline" },
    });
  });

  it("reads a confirmed refusal carrying the retired refusalDetail as an ordinary refusal", () => {
    expect(
      parseSelectionEvidenceReport({
        kind: "dial",
        hostId: "host-1",
        attemptId: "attempt-1",
        outcome: "confirmed-refusal",
        refusalDetail: "plan-restricted",
        transportKind: "remote-relay",
        at: 1_000,
      }),
    ).toEqual({
      kind: "dial",
      hostId: "host-1",
      attemptId: "attempt-1",
      outcome: "confirmed-refusal",
      transportKind: "remote-relay",
      at: 1_000,
    });
  });
});
