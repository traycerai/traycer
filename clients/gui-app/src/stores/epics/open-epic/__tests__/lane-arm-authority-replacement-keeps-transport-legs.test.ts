/**
 * An authority-epoch replacement over an already-open lane session must keep
 * both transport legs OPEN, and the sync pill must never read "reconnecting"
 * for it.
 *
 * ## Why this suite exists
 *
 * `resetAllPlanes` (`runtime/epic-replica-runtime.ts`), reached whenever the
 * state lane delivers a snapshot with `basis: "authorityEpochChanged"` (or
 * the status lane observes the same epoch move), used to call
 * `control.beginFreshCycle()`. That method resets `hostTransportStatus` /
 * `recordsTransportStatus` back to `"connecting"` WITHOUT closing either
 * socket - but an authority-side replacement does not close the sockets at
 * all, it replaces the replica underneath them. A `StreamSession` that is
 * already `open` never re-reports `open`, so both legs sat on `"connecting"`
 * for the rest of the session and `deriveEpicSyncPillState` derived
 * `"reconnecting"` over a link that was never actually down - the staging
 * "Still reconnecting…" pill (2026-09-04).
 *
 * The fix: `resetAllPlanes` now calls `control.beginAuthorityReplacementCycle()`
 * instead, which resets the per-cycle proofs (snapshot freshness, cloud-sync
 * freshness, migration, fetch error) but leaves both transport legs, the
 * aggregate, `hasConnectedOnce` and `cloudSyncStatus` exactly as the sessions
 * last reported them. `requestFreshSnapshot()` - the CLIENT-driven redial -
 * still uses `beginFreshCycle()`, because it closes and reopens the lane
 * transports itself, so resetting to `"connecting"` there is honest: the
 * legs really do go away and have to report `"open"` again.
 *
 * This suite pins both halves: the authority-replacement path that must keep
 * the legs, and the client-redial path that must still reset them, so a
 * future edit cannot "simplify" one into the other.
 */
import { describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import type { EpicStatusSnapshotFrame } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStateSnapshotFrame } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type {
  EpicLaneSelectionSources,
  EpicLaneUnaries,
} from "../runtime/epic-replica-runtime";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";
import {
  deriveEpicSyncPillState,
  summarizeEpicWriteCommands,
  type EpicHostDirtyState,
  type EpicSyncPillState,
} from "@/lib/epic-sync-pill-state";
import type { OpenEpicState } from "../store";

const EPIC_ID = "epic-lane-authority-replacement";

interface LaneRigOptions {
  /** Explicit, exactly as the sibling open-cycle suite's rig: no default. */
  readonly unaries: EpicLaneUnaries;
}

interface LaneRig {
  readonly handle: OpenedStoreForTest;
  /**
   * The two lane sockets' `onConnectionStatus("open", null)`. Called once at
   * the rig's cold open; the replacement test never calls it again, because
   * the whole point is that no transport event accompanies a replacement.
   */
  readonly openLaneSockets: () => void;
  /** Deliver a status snapshot at the given epoch, on the LATEST factory call. */
  readonly deliverStatusSnapshot: (authorityEpoch: string) => void;
  /** Deliver a state snapshot at the given epoch/basis/position. */
  readonly deliverStateSnapshot: (
    authorityEpoch: string,
    basis: "cold" | "authorityEpochChanged",
    position: number,
  ) => void;
  /** How many times each lane's stream factory has been invoked. */
  readonly statusFactoryInvocations: () => number;
  readonly stateFactoryInvocations: () => number;
}

function statusSnapshot(authorityEpoch: string): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    securityEpoch: 1,
    // EDITOR: this suite's write-gate assertions are incidental to its real
    // subject (the transport legs and the pill), but a viewer role would
    // still shut writes for a second, unrelated reason.
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function stateSnapshot(
  authorityEpoch: string,
  basis: "cold" | "authorityEpochChanged",
  position: number,
): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    basis,
    position,
    reconciledWithCloud: true,
    artifactRecords: [],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: {
      revision: 1,
      meta: { title: "Lane epic", updatedAt: 1000 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function openLaneRig(options: LaneRigOptions): LaneRig {
  // The LATEST callbacks only, reassigned on every factory call - which is
  // exactly what a re-dial through `requestFreshSnapshot` produces: the
  // adapter's `openTransport()` calls the factory again, and this rig must
  // hand the newly opened socket's callbacks to whatever drives it next.
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let stateCallbacks: EpicStateStreamCallbacks | null = null;
  let statusFactoryInvocations = 0;
  let stateFactoryInvocations = 0;

  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    statusFactoryInvocations += 1;
    statusCallbacks = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    stateFactoryInvocations += 1;
    stateCallbacks = callbacks;
    return { close: () => undefined };
  };
  const artifactFactory: ArtifactStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    close: () => undefined,
  });

  const laneSelection: EpicLaneSelectionSources = {
    // Declared support, as the sibling open-cycle suite does: this suite is
    // about what a lane-arm SESSION does once installed, not about how it
    // gets chosen.
    support: () => "supported",
    subscribeSupport: () => () => {},
    unaries: options.unaries,
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };

  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error(
          "the legacy stream must not open: this suite is the LANE arm",
        );
      },
      laneSelection,
    },
    writeCommand: null,
  });

  function openLaneSockets(): void {
    if (statusCallbacks === null || stateCallbacks === null) {
      throw new Error("the lane factories were not invoked");
    }
    statusCallbacks.onConnectionStatus("open", null);
    stateCallbacks.onConnectionStatus("open", null);
  }

  function deliverStatusSnapshot(authorityEpoch: string): void {
    if (statusCallbacks === null) {
      throw new Error("the status lane factory was not invoked");
    }
    statusCallbacks.onSnapshot(statusSnapshot(authorityEpoch));
  }

  function deliverStateSnapshot(
    authorityEpoch: string,
    basis: "cold" | "authorityEpochChanged",
    position: number,
  ): void {
    if (stateCallbacks === null) {
      throw new Error("the state lane factory was not invoked");
    }
    stateCallbacks.onSnapshot(stateSnapshot(authorityEpoch, basis, position));
  }

  return {
    handle,
    openLaneSockets,
    deliverStatusSnapshot,
    deliverStateSnapshot,
    statusFactoryInvocations: () => statusFactoryInvocations,
    stateFactoryInvocations: () => stateFactoryInvocations,
  };
}

async function settle(handle: OpenedStoreForTest): Promise<void> {
  // As many drains as the sibling open-cycle suite names: the command
  // crosses to the worker queue, the send crosses back, the answer crosses
  // again to resolve the record. Nothing in this suite writes, but the same
  // number keeps every projection publish flushed before an assertion reads it.
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

/**
 * Replicates `selectHostDirtyState` from `@/lib/epic-selectors.ts`, which is
 * module-private. Duplicated rather than exported for one caller: this
 * suite reads the store's raw fields directly (`handle.store.getState()`,
 * not a React hook), so it builds the same `EpicSyncPillInputs` a component
 * would get from `useEpicSyncPillState()`.
 */
function hostDirtyStateOf(state: OpenEpicState): EpicHostDirtyState {
  if (!state.hasDirtySnapshotForOpenCycle || state.rootDirty === null) {
    return "unknown";
  }
  if (state.rootDirty) return "dirty";
  return Object.values(state.artifactRoomDirtyByArtifactRoomId).some(
    (dirty) => dirty,
  )
    ? "dirty"
    : "clean";
}

function pillStateOf(state: OpenEpicState): EpicSyncPillState {
  return deriveEpicSyncPillState({
    hostTransportStatus: state.hostTransportStatus,
    cloudSyncStatus: state.cloudSyncStatus,
    hasFreshCloudSyncStatus: state.hasFreshCloudSyncStatus,
    hostDirtyState: hostDirtyStateOf(state),
    hasUnsyncedDocClassChanges: state.isDirty,
    writeCommands: summarizeEpicWriteCommands(state.writeCommands),
    hasConnectedOnce: state.hasConnectedOnce,
  });
}

describe("an authority-epoch replacement over open lanes keeps both transport legs open and the pill never reads reconnecting", () => {
  it("keeps hostTransportStatus and recordsTransportStatus open across the replacement, and the pill stays synced", async () => {
    const rig = openLaneRig({ unaries: absentLaneUnaries() });
    rig.openLaneSockets();
    rig.deliverStatusSnapshot("authority-epoch-1");
    rig.deliverStateSnapshot("authority-epoch-1", "cold", 1);
    await settle(rig.handle);

    const opened = rig.handle.store.getState();
    expect(opened.hostTransportStatus).toBe("open");
    expect(opened.recordsTransportStatus).toBe("open");
    expect(opened.snapshotLoaded).toBe(true);
    expect(pillStateOf(opened)).toBe("synced");
    const bindingVersionBefore = opened.bindingVersion;

    // The replacement itself: NO transport event accompanies it - the
    // sockets stay exactly as they are, and only the two lanes' next
    // snapshots carry the new epoch. Status first, as the real host sends
    // it: `foldAuthorityEpoch` on the status snapshot is what actually fires
    // the replacement (`epic-status-lane-adapter.ts`), and the state
    // snapshot's own replacement request coalesces into the same one because
    // both name the same transition token.
    rig.deliverStatusSnapshot("authority-epoch-2");
    rig.deliverStateSnapshot("authority-epoch-2", "authorityEpochChanged", 1);
    await settle(rig.handle);

    const replaced = rig.handle.store.getState();
    // Proves the replacement actually ran, rather than the two snapshots
    // above being silently ignored as duplicates.
    expect(replaced.bindingVersion).toBe(bindingVersionBefore + 1);

    // THE REDDENING ASSERTIONS. Before the fix, `resetAllPlanes` called
    // `control.beginFreshCycle()`, which reset both legs to `"connecting"`
    // even though neither socket closed - an already-open `StreamSession`
    // never re-reports `"open"`, so these two stayed `"connecting"` for the
    // rest of the session and the pill derived `"reconnecting"` over a link
    // that was never actually down (the staging "Still reconnecting…" pill,
    // 2026-09-04).
    expect(replaced.hostTransportStatus).toBe("open");
    expect(replaced.recordsTransportStatus).toBe("open");
    expect(replaced.hasConnectedOnce).toBe(true);
    expect(replaced.snapshotLoaded).toBe(true);
    expect(pillStateOf(replaced)).toBe("synced");
    expect(pillStateOf(replaced)).not.toBe("reconnecting");
    expect(pillStateOf(replaced)).not.toBe("connecting");

    rig.handle.dispose();
  });
});

describe("a client-driven requestFreshSnapshot still resets the legs, because it redials and the reopened lanes report open again", () => {
  it("drops both legs to connecting on the redial, then recovers once the reopened sockets report open", async () => {
    const rig = openLaneRig({ unaries: absentLaneUnaries() });
    rig.openLaneSockets();
    rig.deliverStatusSnapshot("authority-epoch-1");
    rig.deliverStateSnapshot("authority-epoch-1", "cold", 1);
    await settle(rig.handle);

    expect(rig.handle.store.getState().hostTransportStatus).toBe("open");
    expect(rig.handle.store.getState().recordsTransportStatus).toBe("open");
    expect(rig.statusFactoryInvocations()).toBe(1);
    expect(rig.stateFactoryInvocations()).toBe(1);

    rig.handle.store.getState().requestFreshSnapshot();
    await settle(rig.handle);

    // The CONTRAST: this path genuinely closes and reopens the sockets, so
    // resetting to "connecting" is honest here - unlike the authority
    // replacement above, these legs really do have to report `"open"` again.
    const redialing = rig.handle.store.getState();
    expect(redialing.hostTransportStatus).toBe("connecting");
    expect(redialing.recordsTransportStatus).toBe("connecting");
    expect(redialing.hasConnectedOnce).toBe(false);

    // The factories were re-invoked by `openTransport()` - a redial that
    // reused the old (now-closed) socket's callbacks would silently do
    // nothing, and this is the assertion that catches that.
    expect(rig.statusFactoryInvocations()).toBe(2);
    expect(rig.stateFactoryInvocations()).toBe(2);

    // Drive the NEWLY captured callbacks - the rig always holds the latest
    // ones - back to open, exactly as a real reconnect would.
    rig.openLaneSockets();
    rig.deliverStatusSnapshot("authority-epoch-1");
    rig.deliverStateSnapshot("authority-epoch-1", "cold", 1);
    await settle(rig.handle);

    const reopened = rig.handle.store.getState();
    expect(reopened.hostTransportStatus).toBe("open");
    expect(reopened.recordsTransportStatus).toBe("open");
    expect(pillStateOf(reopened)).toBe("synced");

    rig.handle.dispose();
  });
});
