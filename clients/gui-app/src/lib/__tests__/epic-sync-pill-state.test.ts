import { describe, expect, it } from "vitest";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import {
  deriveEpicSyncPillState,
  type EpicSyncPillInputs,
  type EpicSyncPillState,
} from "@/lib/epic-sync-pill-state";

const HEALTHY_INPUTS: EpicSyncPillInputs = {
  hostTransportStatus: "open",
  cloudSyncStatus: "connected",
  hasDirtyArtifactRooms: false,
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
const BOOLEANS: readonly boolean[] = [false, true];

function allCombinations(): readonly EpicSyncPillInputs[] {
  return HOST_TRANSPORT_STATUSES.flatMap((hostTransportStatus) =>
    CLOUD_SYNC_STATUSES.flatMap((cloudSyncStatus) =>
      BOOLEANS.flatMap((hasDirtyArtifactRooms) =>
        BOOLEANS.flatMap((hasUnsyncedLocalChanges) =>
          BOOLEANS.map((hasConnectedOnce): EpicSyncPillInputs => ({
            hostTransportStatus,
            cloudSyncStatus,
            hasDirtyArtifactRooms,
            hasUnsyncedLocalChanges,
            hasConnectedOnce,
          })),
        ),
      ),
    ),
  );
}

const DURABILITY_CLAIMS: ReadonlySet<EpicSyncPillState> = new Set([
  "synced",
  "syncing",
  "offlineChangesSavedLocally",
]);

describe("deriveEpicSyncPillState", () => {
  it("negative control: every leg clean and connected reads synced", () => {
    expect(deriveEpicSyncPillState(HEALTHY_INPUTS)).toBe("synced");
  });

  it("RCA case: dirty artifact rooms alone forces syncing even though every other leg reads healthy — this is the state that used to read 'All changes synced' while 49 artifact bodies existed nowhere but the host", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hasDirtyArtifactRooms: true,
    });
    expect(result).toBe("syncing");
  });

  it("unsynced local changes alone forces syncing", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      hasUnsyncedLocalChanges: true,
    });
    expect(result).toBe("syncing");
  });

  it("cloud disconnected with outstanding work reads offlineChangesSavedLocally", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "disconnected",
      hasDirtyArtifactRooms: true,
    });
    expect(result).toBe("offlineChangesSavedLocally");
  });

  it("cloud reconnecting with outstanding work reads offlineChangesSavedLocally", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "reconnecting",
      hasUnsyncedLocalChanges: true,
    });
    expect(result).toBe("offlineChangesSavedLocally");
  });

  it("cloud disconnected with nothing outstanding falls back to reconnecting (link-status report, no durability claim)", () => {
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

  it("cloud reconnecting with nothing outstanding falls back to reconnecting", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "reconnecting",
    });
    expect(result).toBe("reconnecting");
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

  it("host transport reconnecting reads reconnecting when hasConnectedOnce, connecting otherwise", () => {
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        hostTransportStatus: "reconnecting",
        hasConnectedOnce: true,
      }),
    ).toBe("reconnecting");
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        hostTransportStatus: "reconnecting",
        hasConnectedOnce: false,
      }),
    ).toBe("connecting");
  });

  describe("exhaustive invariants over all 96 combinations", () => {
    const combos = allCombinations();
    // Sanity on the matrix itself: 4 * 3 * 2 * 2 * 2 = 96.
    it("the enumerated matrix has exactly 96 combinations", () => {
      expect(combos.length).toBe(96);
    });

    it("synced is returned iff hostTransportStatus is open AND cloudSyncStatus is connected AND both dirty flags are false", () => {
      for (const inputs of combos) {
        const result = deriveEpicSyncPillState(inputs);
        const expectedSynced =
          inputs.hostTransportStatus === "open" &&
          inputs.cloudSyncStatus === "connected" &&
          !inputs.hasDirtyArtifactRooms &&
          !inputs.hasUnsyncedLocalChanges;
        if (expectedSynced) {
          expect(result).toBe("synced");
        } else {
          expect(result).not.toBe("synced");
        }
      }
    });

    it("never claims durability (synced/syncing/offlineChangesSavedLocally) while the host transport is not open", () => {
      for (const inputs of combos) {
        if (inputs.hostTransportStatus === "open") continue;
        const result = deriveEpicSyncPillState(inputs);
        expect(DURABILITY_CLAIMS.has(result)).toBe(false);
      }
    });
  });

  describe("old-host compatibility (hasDirtyArtifactRooms pinned false)", () => {
    it("degrades rather than narrows: the three pre-@1.1 inputs alone still reach every pill state", () => {
      const reached = new Set<EpicSyncPillState>(
        allCombinations()
          .filter((inputs) => !inputs.hasDirtyArtifactRooms)
          .map((inputs) => deriveEpicSyncPillState(inputs)),
      );

      expect(Array.from(reached).sort()).toEqual([
        "connecting",
        "offline",
        "offlineChangesSavedLocally",
        "reconnecting",
        "synced",
        "syncing",
      ]);
    });

    it("reaches syncing from hasUnsyncedLocalChanges alone with everything else healthy", () => {
      const result = deriveEpicSyncPillState({
        hostTransportStatus: "open",
        cloudSyncStatus: "connected",
        hasDirtyArtifactRooms: false,
        hasUnsyncedLocalChanges: true,
        hasConnectedOnce: true,
      });
      expect(result).toBe("syncing");
    });

    it("reaches offlineChangesSavedLocally from hasUnsyncedLocalChanges alone when the cloud link is down", () => {
      const result = deriveEpicSyncPillState({
        hostTransportStatus: "open",
        cloudSyncStatus: "disconnected",
        hasDirtyArtifactRooms: false,
        hasUnsyncedLocalChanges: true,
        hasConnectedOnce: true,
      });
      expect(result).toBe("offlineChangesSavedLocally");
    });

    it("reaches synced when every remaining leg is clean", () => {
      const result = deriveEpicSyncPillState({
        hostTransportStatus: "open",
        cloudSyncStatus: "connected",
        hasDirtyArtifactRooms: false,
        hasUnsyncedLocalChanges: false,
        hasConnectedOnce: true,
      });
      expect(result).toBe("synced");
    });
  });
});
