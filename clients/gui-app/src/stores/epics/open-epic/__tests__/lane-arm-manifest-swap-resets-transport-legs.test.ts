/**
 * The manifest-driven legacy→lanes arm swap REPLACES the sockets, so its reset
 * must put the transport legs back to `connecting`.
 *
 * ## Why this suite exists
 *
 * `resetAllPlanes` keeps the transport legs for an in-band authority
 * replacement, because those sessions stay open and never re-report `open`
 * (see `lane-arm-authority-replacement-keeps-transport-legs.test.ts`). The
 * arm swap in `executeTransition` goes through the SAME reset but detaches the
 * outgoing arm first and attaches the incoming one after: its replacement
 * sessions start from `connecting` and report `open` on their own. Keeping the
 * outgoing arm's `open` there would read as synced while the new sockets were
 * still dialing, and a stalled dial would never be seen. `replacesTransportUnderReset`
 * is the split this pins.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EPIC_LANE_METHODS } from "@traycer-clients/shared/epic-lanes";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
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

interface SwapRig {
  readonly runtime: EpicReplicaRuntime;
  /** The projection as the runtime last published it, patch by patch. */
  readonly projection: () => Partial<EpicRuntimeProjection>;
  readonly legacyCallbacks: () => EpicStreamCallbacks;
  readonly statusCallbacks: () => EpicStatusStreamCallbacks;
  readonly stateCallbacks: () => EpicStateStreamCallbacks;
  readonly legacyCloseCount: () => number;
  readonly laneOpenCount: () => number;
  readonly setSupport: (value: StreamMethodSupport) => void;
  readonly notifySupport: () => void;
}

function buildSwapRig(): SwapRig {
  let projection: Partial<EpicRuntimeProjection> = {};
  let legacyLive: EpicStreamCallbacks | null = null;
  let statusLive: EpicStatusStreamCallbacks | null = null;
  let stateLive: EpicStateStreamCallbacks | null = null;
  let legacyCloses = 0;
  let laneOpens = 0;
  const support = new Map<string, StreamMethodSupport>();
  const listeners = new Set<() => void>();

  const legacyFactory: EpicStreamClientFactory = (
    _epicId,
    callbacks,
    _seedOfferProvider,
  ) => {
    legacyLive = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => {
        legacyCloses += 1;
      },
    };
  };
  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    laneOpens += 1;
    statusLive = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    laneOpens += 1;
    stateLive = callbacks;
    return { close: () => undefined };
  };
  const artifactFactory: ArtifactStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    close: () => undefined,
  });

  const laneSelection: EpicLaneSelectionSources = {
    support: (method) => support.get(method) ?? "unknown",
    subscribeSupport: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
    unaries: absentLaneUnaries(),
  };
  const runtime = createEpicReplicaRuntime({
    epicId: "epic-manifest-swap",
    environment: createRendererRuntimeEnvironment(),
    streamClientFactory: legacyFactory,
    delivery: createBatchingDelivery((patch) => {
      projection = { ...projection, ...patch };
    }),
    accounting: createRecordingAccountingPort(),
    getCurrentUserId: () => null,
    getDocArm: () => DOC_IS_THE_ONLY_RECORD_SOURCE,
    onAuthError: null,
    commandIdFactory: { next: () => "command-id" },
    writeCommandSender: {
      currentHostId: () => null,
      send: (_commandId: string, _intent: EpicWriteCommandIntent) =>
        Promise.reject<{ readonly hostId: string }>(
          new Error("write command sender not exercised in this suite"),
        ),
    },
    laneSelection,
  });

  function require<T>(value: T | null, what: string): T {
    if (value === null) throw new Error(`${what} was not constructed`);
    return value;
  }

  return {
    runtime,
    projection: () => projection,
    legacyCallbacks: () => require(legacyLive, "the legacy client"),
    statusCallbacks: () => require(statusLive, "the status lane client"),
    stateCallbacks: () => require(stateLive, "the state lane client"),
    legacyCloseCount: () => legacyCloses,
    laneOpenCount: () => laneOpens,
    setSupport: (value) => {
      for (const method of EPIC_LANE_METHODS) support.set(method, value);
    },
    notifySupport: () => {
      for (const listener of listeners) listener();
    },
  };
}

describe("a manifest-driven arm swap resets the transport legs", () => {
  const runtimes: EpicReplicaRuntime[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });

  it("drops both legs to connecting when the legacy arm is retired, then takes the lanes' own open reports", () => {
    const rig = buildSwapRig();
    runtimes.push(rig.runtime);

    // Support known UNSUPPORTED at start: the legacy arm installs directly.
    rig.setSupport("unsupported");
    rig.runtime.start();
    // A host the legacy arm serves negotiated no durability pair.
    rig.legacyCallbacks().onConnectionStatus("open", null, false);
    expect(rig.projection().hostTransportStatus).toBe("open");
    expect(rig.projection().recordsTransportStatus).toBe("open");

    // The host upgraded under the tab: the manifest now serves the lanes.
    // `executeTransition` detaches legacy, resets with `manifest-changed`,
    // and attaches the lanes - whose sockets have not reported anything.
    rig.setSupport("supported");
    rig.notifySupport();

    expect(rig.legacyCloseCount()).toBe(1);
    expect(rig.laneOpenCount()).toBe(2);
    // THE REDDENING ASSERTION: with the in-band cycle applied here too, the
    // retired arm's `open` survived into the new arm and the pill read synced
    // over sockets that were still dialing.
    expect(rig.projection().hostTransportStatus).toBe("connecting");
    expect(rig.projection().recordsTransportStatus).toBe("connecting");
    expect(rig.projection().hasConnectedOnce).toBe(false);

    // The replacement sessions report for themselves.
    rig.statusCallbacks().onConnectionStatus("open", null);
    rig.stateCallbacks().onConnectionStatus("open", null);
    expect(rig.projection().hostTransportStatus).toBe("open");
    expect(rig.projection().recordsTransportStatus).toBe("open");
  });
});
