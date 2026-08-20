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
  // A pre-@1.4 peer, which is what every case in this file was written
  // against. The undefined key PLUS a handshake that never negotiated the
  // legs is how the derivation identifies one, so these keep asserting
  // exactly the behaviour they always did.
  durability: undefined,
  localProtection: undefined,
  durabilityLegsNegotiated: false,
  cloudFreshness: undefined,
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
              durability: undefined,
              localProtection: undefined,
              durabilityLegsNegotiated: false,
              cloudFreshness: undefined,
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

  it("cloud reconnecting with host-pending work makes no durability claim on a pre-@1.4 peer", () => {
    const result = deriveEpicSyncPillState({
      ...HEALTHY_INPUTS,
      cloudSyncStatus: "reconnecting",
      hostDirtyState: "dirty",
    });
    expect(result).toBe("offlineWithHostPending");
  });

  it("an ARMED session with the cloud down claims local durability", () => {
    // The positive statement the claim needs. Without `armed` this returns
    // `offlineWithHostPending` and `offlineChangesSavedLocally` is
    // unreachable - a union member, a pill rendering and its tests for a
    // state the derivation never produced.
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        cloudSyncStatus: "disconnected",
        hostDirtyState: "dirty",
        localProtection: "armed",
      }),
    ).toBe("offlineChangesSavedLocally");
  });

  it("keeps unknown protection on the no-claim state", () => {
    expect(
      deriveEpicSyncPillState({
        ...HEALTHY_INPUTS,
        cloudSyncStatus: "disconnected",
        hostDirtyState: "dirty",
        localProtection: "unknown",
      }),
    ).toBe("offlineWithHostPending");
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
        durability: undefined,
        localProtection: undefined,
        durabilityLegsNegotiated: false,
        cloudFreshness: undefined,
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
        durability: undefined,
        localProtection: undefined,
        durabilityLegsNegotiated: false,
        cloudFreshness: undefined,
      });
      expect(result).toBe("offlineWithUnsavedChanges");
    });
  });

  // ── `s5-status-truthfulness` instance 1 ─────────────────────────────────
  //
  // The pill and the durability badge are mounted inches apart by the epic
  // shell, and the pill ignored durability entirely. A local-homed epic's
  // `LocalRoomConnection` reports connected + clean, so the settled free-tier
  // session rendered "All changes synced" beside "Stored locally", about an
  // epic no cloud has ever seen. Every case below returns `synced` on the
  // pre-fix derivation.
  describe("the synced claim needs a cloud durability fact behind it", () => {
    it("keeps a negotiated @1.4 peer's omitted legs indeterminate", () => {
      // The schema marks every `@1.4` leg optional and an absent one means
      // UNKNOWN. Presence-probing alone read this frame as a pre-`@1.4` peer
      // and claimed "All changes synced" off an absence - the negotiated
      // handshake is what tells the two silences apart.
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: undefined,
          localProtection: undefined,
          durabilityLegsNegotiated: true,
        }),
      ).toBe("connected");
    });

    it("still claims synced for a genuinely pre-@1.4 peer", () => {
      expect(deriveEpicSyncPillState(HEALTHY_INPUTS)).toBe("synced");
    });

    it("does not claim synced for a local-homed epic", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: "local",
          localProtection: "armed",
        }),
      ).toBe("storedLocally");
    });

    it("does not claim synced while an epic is still promoting", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: "promoting",
          localProtection: "armed",
        }),
      ).toBe("storedLocally");
    });

    it("does not claim saved-on-device when a NEGOTIATED peer omits the protection key", () => {
      // The sibling of the synced-claim case above, and the path that kept
      // reading an absence as protection after that one was fixed.
      // `storedLocally` tells the reader their bytes are on this disk, which
      // is every bit as positive a claim as "All changes synced" - a
      // negotiated `@1.4` peer omitting the optional key is stating UNKNOWN
      // per the schema's own absence rule, and unknown licenses neither.
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: "local",
          localProtection: undefined,
          durabilityLegsNegotiated: true,
        }),
      ).toBe("connected");
    });

    it("does not claim saved-on-device while protection is UNAVAILABLE", () => {
      // "Stored locally" is a durability claim, and the local-room connection
      // satisfying `cloudSyncStatus: "connected"` says nothing about it: an
      // unavailable session's edits live only in the document and are lost on
      // process exit, graceful quit included. The pill must not encourage
      // closing work that is not persisted anywhere.
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: "local",
          localProtection: "unavailable",
        }),
      ).toBe("unprotected");
    });

    it("claims nothing on a local epic whose protection is UNKNOWN", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: "local",
          localProtection: "unknown",
        }),
      ).toBe("connected");
    });

    it("does not claim synced when the host says durability is unknown", () => {
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: "unknown",
          localProtection: "unknown",
        }),
      ).toBe("connected");
    });

    it("does not claim synced on an absent durability key alone", () => {
      // The @1.4 absence rule. A peer that speaks the minor and says nothing
      // about durability has said UNKNOWN, and the calm claim needs the
      // positive `armed` beside it before it may render.
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: undefined,
          localProtection: "unknown",
        }),
      ).toBe("connected");
    });

    it("claims synced only on the POSITIVE cloud member, never on an absence", () => {
      // `durability: "cloud"` is the `@1.4` statement the calm claim rests
      // on. Absence beside `armed` used to buy the same rendering, which let
      // a schema-permitted omission read as "All changes synced".
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: "cloud",
          localProtection: "armed",
        }),
      ).toBe("synced");
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: undefined,
          localProtection: "armed",
        }),
      ).not.toBe("synced");
    });

    it("keeps a pre-@1.4 peer on exactly its old rendering", () => {
      expect(deriveEpicSyncPillState(HEALTHY_INPUTS)).toBe("synced");
    });
  });

  // ── `s5-unarmed-session`, rendering half ────────────────────────────────
  describe("an unprotected session may not read as offline-but-saved", () => {
    it("warns when the cloud is down and there is no local WAL", () => {
      // Pre-fix this is `offlineWithHostPending` - "Offline — changes
      // pending" - which implies something is holding the work. Nothing is.
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          cloudSyncStatus: "disconnected",
          hostDirtyState: "dirty",
          durability: undefined,
          localProtection: "unavailable",
        }),
      ).toBe("unprotected");
    });

    it("stays quiet about protection while the cloud IS connected", () => {
      // The work is reaching the cloud, so the pill has nothing alarming to
      // say; the durability badge carries the protection warning instead.
      expect(
        deriveEpicSyncPillState({
          ...HEALTHY_INPUTS,
          durability: undefined,
          localProtection: "unavailable",
        }),
      ).toBe("connected");
    });
  });
});

/**
 * The ninth leg - `s5-mirror-first-serving`.
 *
 * Every other case in this file is about where WORK is going. These are about
 * what the reader is LOOKING at, which mirror-first serving made a separate
 * question: the host paints a WAL-backed document before reconciling it, so
 * "nothing outstanding, cloud link up" stopped implying "this is the cloud's
 * document".
 */
describe("cloud freshness gates the synced claim", () => {
  /**
   * The `@1.4` shape of {@link HEALTHY_INPUTS}: a positively-armed session
   * with no local-durability claim, i.e. durable in the cloud. Without a
   * freshness statement this is the one combination that legitimately reads
   * `synced`, which is what makes it the right baseline to perturb.
   */
  const CLOUD_DURABLE_ARMED: EpicSyncPillInputs = {
    ...HEALTHY_INPUTS,
    durability: "cloud",
    localProtection: "armed",
    cloudFreshness: undefined,
  };

  it("still claims synced when the host states the document is current", () => {
    expect(
      deriveEpicSyncPillState({
        ...CLOUD_DURABLE_ARMED,
        cloudFreshness: {
          kind: "lastCloudSyncAt",
          reconciledAtEpochMs: 1_700_000_000_000,
          state: "current",
        },
      }),
    ).toBe("synced");
  });

  it("keeps its exact pre-@1.4 answer when the host says nothing about freshness", () => {
    // The additive property, asserted rather than assumed: the host omits this
    // key wherever the question does not apply, and a peer below @1.4 cannot
    // send it at all. Neither may lose its current rendering.
    expect(deriveEpicSyncPillState(CLOUD_DURABLE_ARMED)).toBe("synced");
  });

  it.each([
    { state: "local-copy" as const },
    { state: "syncing" as const },
    { state: "stale" as const },
  ])(
    "refuses the synced claim over a document the host calls $state",
    ({ state }) => {
      const result = deriveEpicSyncPillState({
        ...CLOUD_DURABLE_ARMED,
        cloudFreshness: { kind: "freshnessUnknown", state },
      });
      // Neutral, not alarming: the WORK really is safe in the cloud, so the
      // pill claims nothing rather than warning about durability it has no
      // reason to doubt. The document's own staleness is the badge's line.
      expect(result).toBe("connected");
      expect(result).not.toBe("synced");
    },
  );

  it("refuses it for a TIMESTAMPED non-current document too, so the stamp is not mistaken for currency", () => {
    // A recorded reconciliation is evidence about the PAST. Reading the mere
    // presence of a timestamp as currency would be the absence-as-reassurance
    // inference one level down.
    expect(
      deriveEpicSyncPillState({
        ...CLOUD_DURABLE_ARMED,
        cloudFreshness: {
          kind: "lastCloudSyncAt",
          reconciledAtEpochMs: 1_700_000_000_000,
          state: "stale",
        },
      }),
    ).toBe("connected");
  });
});
