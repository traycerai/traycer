/**
 * The lane-probe refusal, seen from the PROJECTION rather than from the socket
 * counts.
 *
 * `lane-adapter-probe.test.ts` already pins what a method-incompatible close on
 * the probe's `epic.status.subscribe` does to the ARMS (legacy installs, the
 * probe's stream is retired). This suite asks the other half of the same event:
 * what the user sees while that happens, because the same `reportStatus`
 * callback that answers the probe ALSO routes the fatal close into the control
 * replica as a `transport-status` event with `ownsControlCycle: true` - and
 * `applyTransportStatus` turns a fatal close into `snapshotFetchError`, which
 * the UI renders as "Host update needed" with a Retry button.
 *
 * The question this suite answers is whether that error survives the legacy
 * arm's own open + root snapshot, or whether `noteSnapshotLanded` clears it.
 *
 * Nothing here is a fixture shortcut: the runtime is the real
 * `createEpicReplicaRuntime`, support is forever-unknown (the relay shape, so
 * the probe is the only thing that can decide), and every projection the
 * delivery commits is recorded in order.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicAdapterArm } from "../runtime/epic-adapter-selection";
import {
  createEpicReplicaRuntime,
  type EpicLaneSelectionSources,
  type EpicReplicaRuntime,
} from "../runtime/epic-replica-runtime";
import type { EpicStreamClientFactory } from "../runtime/legacy-epic-stream-adapter";
import type { EpicRuntimeProjection } from "../runtime/epic-runtime-projection";
import type { EpicWriteCommandIntent } from "../runtime/epic-write-command";
import { createRendererRuntimeEnvironment } from "../runtime/runtime-environment";
import { createRecordingAccountingPort } from "../runtime/__tests__/accounting-port-fixture";
import { createBatchingDelivery } from "../runtime/projection-delivery";
import { DOC_IS_THE_ONLY_RECORD_SOURCE } from "../projection-helpers";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";

/**
 * The close an OLD host (or the client's own open-ack mirror check) produces
 * for a lane method it does not serve: a fatal `INCOMPATIBLE`, naming the
 * method and carrying upgrade guidance - the exact payload the "Host update
 * needed" empty state renders.
 */
// A shipped 1.2.0 host has no `epic.status.subscribe` at all, so the probe's
// handshake dies on the host-missing-method arm with host-side guidance.
const INCOMPATIBLE_STATUS_CLOSE: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "INCOMPATIBLE",
    reason: "Incompatible methods: epic.status.subscribe",
    incompatibleMethods: [
      {
        method: "epic.status.subscribe",
        clientCanonical: { major: 1, minor: 0 },
        hostCanonical: null,
        blocking: "host-missing-method",
      },
    ],
    upgradeGuidance: { clientShouldUpgrade: false, hostShouldUpgrade: true },
  },
};

interface StatusRig {
  readonly factory: EpicStatusStreamClientFactory;
  openCount(): number;
  refuseAsIncompatible(): void;
}

function createStatusRig(): StatusRig {
  let opens = 0;
  let live: EpicStatusStreamCallbacks | null = null;
  const factory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    opens += 1;
    live = callbacks;
    return { close: () => undefined };
  };
  return {
    factory,
    openCount: () => opens,
    refuseAsIncompatible(): void {
      if (live === null) throw new Error("no status client was constructed");
      live.onConnectionStatus("closed", INCOMPATIBLE_STATUS_CLOSE);
    },
  };
}

interface LegacyRig {
  readonly factory: EpicStreamClientFactory;
  openCount(): number;
  /** The `@1` socket reaching `open` - the arm's own control cycle boundary. */
  open(): void;
  /** The root snapshot `@1` answers a subscribe with. */
  deliverRootSnapshot(): void;
  /**
   * Ordinary traffic on a still-healthy `@1` socket - the proof that the
   * session behind the error banner is alive and simply has no further
   * snapshot to send.
   */
  deliverOrdinaryTraffic(): void;
}

function legacySnapshotMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "2.0.0",
    roomId: "room-legacy",
    epicLight: null,
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function createLegacyRig(): LegacyRig {
  let opens = 0;
  let live: EpicStreamCallbacks | null = null;
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    opens += 1;
    live = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  function requireLive(): EpicStreamCallbacks {
    if (live === null) throw new Error("no legacy client was constructed");
    return live;
  }
  return {
    factory,
    openCount: () => opens,
    open: () => requireLive().onConnectionStatus("open", null),
    deliverRootSnapshot(): void {
      const source = new Y.Doc();
      source.getMap("epic").set("title", "Legacy fallback epic");
      const update = Y.encodeStateAsUpdate(source);
      source.destroy();
      requireLive().onSnapshot(legacySnapshotMeta(), update);
    },
    deliverOrdinaryTraffic(): void {
      const source = new Y.Doc();
      source.getMap("epic").set("title", "Edited after the re-probe");
      const update = Y.encodeStateAsUpdate(source);
      source.destroy();
      requireLive().onUpdate(update);
      requireLive().onCloudSyncStatus("connected");
    },
  };
}

const NO_BODIES: ArtifactStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  close: () => undefined,
});

const NO_STATE_LANE: EpicStateStreamClientFactory = () => ({
  close: () => undefined,
});

/**
 * The four keys this suite reads, pulled out of every committed patch.
 *
 * `snapshotFetchError` is flattened to its message - the whole point of the
 * banner is what it SAYS, and a structural compare would drown that in the
 * code/guidance fields the snapshot already proves are carried through.
 */
interface ControlReading {
  readonly snapshotFetchError: string | null;
  readonly connectionStatus: StreamConnectionStatus | undefined;
  readonly hostTransportStatus: StreamConnectionStatus | undefined;
  readonly installedArm: EpicAdapterArm | null | undefined;
}

interface Rig {
  readonly runtime: EpicReplicaRuntime;
  readonly status: StatusRig;
  readonly legacy: LegacyRig;
  /**
   * The reconnect edge, as the relay delivers it: support is still `"unknown"`
   * for every method - a relay has nothing to report - but the negotiated
   * manifest was rewritten by the re-handshake, so the listener fires. This is
   * what makes `applySelection` re-probe (see `lane-adapter-probe.test.ts`'s
   * (b2)/(b3)); nothing here can resolve support by hand.
   */
  notifySupport(): void;
  /** How many write commands actually reached the (fake) host. */
  sentCommandCount(): number;
  /** Every patch the delivery committed, in commit order. */
  readonly patches: ReadonlyArray<Partial<EpicRuntimeProjection>>;
  /** The folded projection: the last value committed for each key. */
  reading(): ControlReading;
  /** Only the patches that touched one of the four keys, as readings. */
  timeline(): ReadonlyArray<Partial<ControlReading>>;
}

let nextEpicSequence = 0;

function buildRig(): Rig {
  nextEpicSequence += 1;
  const status = createStatusRig();
  const legacy = createLegacyRig();
  const patches: Array<Partial<EpicRuntimeProjection>> = [];
  let folded: Partial<EpicRuntimeProjection> = {};
  const supportListeners = new Set<() => void>();
  let sentCommands = 0;
  let nextCommandId = 0;
  const laneSelection: EpicLaneSelectionSources = {
    // The relay shape: forever unknown. The probe is the only thing that can
    // decide the arm here, and there is deliberately no way to resolve support
    // by hand - only the listener can fire.
    support: () => "unknown",
    subscribeSupport: (listener) => {
      supportListeners.add(listener);
      return () => {
        supportListeners.delete(listener);
      };
    },
    stateStreamClientFactory: NO_STATE_LANE,
    statusStreamClientFactory: status.factory,
    artifactStreamClientFactory: NO_BODIES,
    unaries: absentLaneUnaries(),
  };
  const runtime = createEpicReplicaRuntime({
    epicId: `epic-probe-refusal-${nextEpicSequence}`,
    environment: createRendererRuntimeEnvironment(),
    streamClientFactory: legacy.factory,
    delivery: createBatchingDelivery((patch) => {
      patches.push(patch);
      folded = { ...folded, ...patch };
    }),
    accounting: createRecordingAccountingPort(),
    getCurrentUserId: () => null,
    getDocArm: () => DOC_IS_THE_ONLY_RECORD_SOURCE,
    onAuthError: null,
    commandIdFactory: {
      next: () => `probe-refusal-command-${(nextCommandId += 1)}`,
    },
    writeCommandSender: {
      currentHostId: () => "probe-refusal-test-host",
      send: (_commandId: string, _intent: EpicWriteCommandIntent) => {
        sentCommands += 1;
        return Promise.resolve({ hostId: "probe-refusal-test-host" });
      },
    },
    laneSelection,
  });
  const readOf = (patch: Partial<EpicRuntimeProjection>): ControlReading => ({
    snapshotFetchError: patch.snapshotFetchError?.message ?? null,
    connectionStatus: patch.connectionStatus,
    hostTransportStatus: patch.hostTransportStatus,
    installedArm: patch.installedArm,
  });
  return {
    runtime,
    status,
    legacy,
    notifySupport: () => {
      for (const listener of [...supportListeners]) listener();
    },
    sentCommandCount: () => sentCommands,
    patches,
    reading: () => readOf(folded),
    timeline: () => {
      const rows: Array<Partial<ControlReading>> = [];
      for (const patch of patches) {
        const reading = readOf(patch);
        const row: Partial<ControlReading> = {
          // Only the keys this patch actually carried, so the recorded
          // sequence shows which frame moved what rather than restating the
          // whole projection four times.
          ...("snapshotFetchError" in patch
            ? { snapshotFetchError: reading.snapshotFetchError }
            : {}),
          ...("connectionStatus" in patch
            ? { connectionStatus: reading.connectionStatus }
            : {}),
          ...("hostTransportStatus" in patch
            ? { hostTransportStatus: reading.hostTransportStatus }
            : {}),
          ...("installedArm" in patch
            ? { installedArm: reading.installedArm }
            : {}),
        };
        if (Object.keys(row).length > 0) rows.push(row);
      }
      return rows;
    },
  };
}

/** Drains the command queue's async send chain - native promises only. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("a refused lane probe never reaches the control replica", () => {
  const runtimes: EpicReplicaRuntime[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });

  it("installs legacy without ever publishing the probe's close as an error", () => {
    const rig = buildRig();
    runtimes.push(rig.runtime);

    rig.runtime.start();
    expect(rig.status.openCount()).toBe(1);
    expect(rig.legacy.openCount()).toBe(0);

    // 1. The old host refuses `epic.status.subscribe` with a fatal
    //    INCOMPATIBLE. This one callback answers the probe (installing
    //    legacy) - and does nothing else.
    rig.status.refuseAsIncompatible();
    expect(rig.legacy.openCount()).toBe(1);
    expect(rig.reading()).toEqual({
      snapshotFetchError: null,
      // Nothing has reported a transport status: the probe's stream never
      // opened, and its refusal is not a status of the epic's connection.
      connectionStatus: undefined,
      hostTransportStatus: undefined,
      installedArm: "legacy",
    });

    // 2. The legacy `epic.subscribe@1` socket reaches open and answers with
    //    the root snapshot - the first and only status the projection sees.
    rig.legacy.open();
    rig.legacy.deliverRootSnapshot();
    expect(rig.reading()).toEqual({
      snapshotFetchError: null,
      connectionStatus: "open",
      hostTransportStatus: "open",
      installedArm: "legacy",
    });

    // No patch anywhere in the sequence carried an error or a close; the
    // "Host update needed" flash the old routing produced is gone, not merely
    // cleared a frame later.
    for (const row of rig.timeline()) {
      expect(row.snapshotFetchError ?? null).toBeNull();
      expect(row.connectionStatus).not.toBe("closed");
      expect(row.hostTransportStatus).not.toBe("closed");
    }
  });

  /**
   * The same refusal, one reconnect later - the case with nothing owed to
   * clear an error, so the only correct behaviour is to publish none.
   *
   * On a relay the verdict is `"undecided"` for the life of the runtime, so
   * `applySelection` re-probes on every support notification. When the host
   * is genuinely old, that re-probe is refused exactly as the first one was -
   * and `applyProbeOutcome` finds legacy already installed, so it plans no
   * transition: no reset, no re-attach, no root snapshot. The `@1` session
   * underneath is healthy the whole time, and must keep reading as such.
   */
  it("a REFUSED re-probe leaves a healthy legacy session untouched and writable", async () => {
    const rig = buildRig();
    runtimes.push(rig.runtime);

    rig.runtime.start();
    rig.status.refuseAsIncompatible();
    rig.legacy.open();
    rig.legacy.deliverRootSnapshot();

    // The steady state a user is actually looking at: legacy serving, open,
    // no error, writable.
    const settled = rig.reading();
    expect(settled).toEqual({
      snapshotFetchError: null,
      connectionStatus: "open",
      hostTransportStatus: "open",
      installedArm: "legacy",
    });
    rig.runtime.enqueueWriteCommand({
      kind: "update-epic-title",
      title: "before the reconnect",
      updatedAt: 1000,
    });
    await flushMicrotasks();
    expect(rig.sentCommandCount()).toBe(1);

    // The reconnect edge. Support has not moved and cannot on this source, so
    // the re-probe opens a second status stream...
    rig.notifySupport();
    expect(rig.status.openCount()).toBe(2);
    // ...which the old host refuses exactly as it refused the first.
    rig.status.refuseAsIncompatible();
    // No new legacy socket: the `@1` session that was already open is
    // untouched, and so is everything the projection says about it.
    expect(rig.legacy.openCount()).toBe(1);
    expect(rig.reading()).toEqual(settled);

    // Ordinary traffic on the still-open `@1` socket keeps landing...
    rig.legacy.deliverOrdinaryTraffic();
    expect(rig.reading()).toEqual(settled);

    // ...and the write gate the old routing cleared (`ownsControlCycle: true`
    // on a fatal close reset `hasFreshRootSnapshotForOpenCycle`, with no
    // snapshot owed to restore it) is still open: the epic stays writable.
    rig.runtime.enqueueWriteCommand({
      kind: "update-epic-title",
      title: "after the refused re-probe",
      updatedAt: 2000,
    });
    await flushMicrotasks();
    expect(rig.sentCommandCount()).toBe(2);
  });
});
