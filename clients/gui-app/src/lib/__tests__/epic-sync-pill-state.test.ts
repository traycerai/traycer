import { describe, expect, it } from "vitest";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import {
  deriveEpicSyncPillState,
  type EpicHostDirtyState,
  type EpicSyncPillInputs,
  type EpicSyncPillState,
} from "@/lib/epic-sync-pill-state";

const HEALTHY_INPUTS: EpicSyncPillInputs = {
  hostTransportStatus: "open",
  cloudSyncStatus: "connected",
  hasFreshCloudSyncStatus: true,
  hostDirtyState: "clean",
  hasUnsyncedLocalChanges: false,
  hasConnectedOnce: true,
};

const HOST_TRANSPORT_STATUSES: readonly StreamConnectionStatus[] = [
  "connecting",
  "open",
  "reconnecting",
  "closed",
];
const CLOUD_SYNC_STATUSES: readonly EpicCloudSyncStatus[] = [
  "connected",
  "reconnecting",
  "disconnected",
];
const HOST_DIRTY_STATES: readonly EpicHostDirtyState[] = [
  "unknown",
  "clean",
  "dirty",
];
const BOOLEANS: readonly boolean[] = [false, true];

function allCombinations(): readonly EpicSyncPillInputs[] {
  return HOST_TRANSPORT_STATUSES.flatMap((hostTransportStatus) =>
    CLOUD_SYNC_STATUSES.flatMap((cloudSyncStatus) =>
      BOOLEANS.flatMap((hasFreshCloudSyncStatus) =>
        HOST_DIRTY_STATES.flatMap((hostDirtyState) =>
          BOOLEANS.flatMap((hasUnsyncedLocalChanges) =>
            BOOLEANS.map((hasConnectedOnce): EpicSyncPillInputs => ({
              hostTransportStatus,
              cloudSyncStatus,
              hasFreshCloudSyncStatus,
              hostDirtyState,
              hasUnsyncedLocalChanges,
              hasConnectedOnce,
            })),
          ),
        ),
      ),
    ),
  );
}

const DURABILITY_CLAIMS: ReadonlySet<EpicSyncPillState> = new Set([
  "synced",
  "offlineChangesSavedLocally",
]);

describe("deriveEpicSyncPillState", () => {
  it("negative control: every leg clean and connected reads synced", () => {
    expect(deriveEpicSyncPillState(HEALTHY_INPUTS)).toBe("synced");
  });

  it("distinguishes host-durable cloud-pending work from renderer-only work", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostDirtyState: "dirty",
    });
    expect(result).toBe("hostPending");
  });

  it("unsynced local changes alone force syncing", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hasUnsyncedLocalChanges: true,
    });
    expect(result).toBe("syncing");
  });

  it("cloud disconnected with aggregate host-pending work makes no durability claim", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
      hostDirtyState: "dirty",
    });
    expect(result).toBe("offlineWithHostPending");
  });

  it("cloud reconnecting with known host-durable work reads offlineChangesSavedLocally", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "reconnecting",
      hostDirtyState: "dirty",
    });
    expect(result).toBe("offlineWithHostPending");
  });

  it("warns immediately without calling renderer-only work saved locally while the cloud is down", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
      hostDirtyState: "dirty",
      hasUnsyncedLocalChanges: true,
    });
    expect(result).toBe("offlineWithUnsavedChanges");
  });

  it("uses neutral connected while the host-dirty snapshot is unknown", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostDirtyState: "unknown",
    });
    expect(result).toBe("connected");
  });

  it("uses neutral connected until this open cycle receives a cloud-status frame", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hasFreshCloudSyncStatus: false,
    });
    expect(result).toBe("connected");
  });

  it("cloud disconnected with nothing outstanding falls back to reconnecting", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
    });
    expect(result).toBe("reconnecting");
  });

  it("cloud disconnected with nothing outstanding falls back to connecting when never connected before", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
      hasConnectedOnce: false,
    });
    expect(result).toBe("connecting");
  });

  it("host transport closed reads offline regardless of hasConnectedOnce", () => {
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        hostTransportStatus: "closed",
      }),
    ).toBe("offline");
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        hostTransportStatus: "closed",
        hasConnectedOnce: false,
      }),
    ).toBe("offline");
  });

  it("host transport connecting reads connecting when never connected before", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostTransportStatus: "connecting",
      hasConnectedOnce: false,
    });
    expect(result).toBe("connecting");
  });

  it("host transport connecting reads reconnecting once already connected before", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hostTransportStatus: "connecting",
      hasConnectedOnce: true,
    });
    expect(result).toBe("reconnecting");
  });

  describe("exhaustive invariants over all 288 combinations", () => {
    const combos = allCombinations();

    it("the enumerated matrix has exactly 288 combinations", () => {
      expect(combos.length).toBe(288);
    });

    it("synced is returned iff transport and cloud status are fresh/connected, host dirtiness is clean, and no renderer-only work exists", () => {
      for (const inputs of combos) {
        const result = deriveEpicSyncPillState(inputs);
        const expectedSynced =
          inputs.hostTransportStatus === "open" &&
          inputs.cloudSyncStatus === "connected" &&
          inputs.hasFreshCloudSyncStatus &&
          inputs.hostDirtyState === "clean" &&
          !inputs.hasUnsyncedLocalChanges;
        if (expectedSynced) {
          expect(result).toBe("synced");
        } else {
          expect(result).not.toBe("synced");
        }
      }
    });

    it("never claims durability while the host transport is not open", () => {
      for (const inputs of combos) {
        if (inputs.hostTransportStatus === "open") continue;
        const result = deriveEpicSyncPillState(inputs);
        expect(DURABILITY_CLAIMS.has(result)).toBe(false);
      }
    });
  });

  describe("old-host compatibility (host dirtiness stays unknown)", () => {
    it("never claims synced for a clean-looking @1.0 session", () => {
      const result = deriveEpicSyncPillState({
        hostTransportStatus: "open",
        cloudSyncStatus: "connected",
        hasFreshCloudSyncStatus: true,
        hostDirtyState: "unknown",
        hasUnsyncedLocalChanges: false,
        hasConnectedOnce: true,
      });
      expect(result).toBe("connected");
    });

    it("warns about renderer-only work when the known cloud link is down", () => {
      const result = deriveEpicSyncPillState({
        hostTransportStatus: "open",
        cloudSyncStatus: "disconnected",
        hasFreshCloudSyncStatus: true,
        hostDirtyState: "unknown",
        hasUnsyncedLocalChanges: true,
        hasConnectedOnce: true,
      });
      expect(result).toBe("offlineWithUnsavedChanges");
    });
  });
});
