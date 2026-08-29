/**
 * The forever-unknown-support pin.
 *
 * `epic-adapter-selection.ts` names three verdicts - `"lanes"`, `"legacy"`,
 * `"undecided"` - and states that `"undecided"` is not a selection: nothing
 * may be installed while it holds. `epic-replica-runtime.ts`'s
 * `applySelection()` is supposed to answer that with a PROBE
 * (`laneArm.probe()`) rather than silence, because a client only learns a
 * method's support from a subscribe completing. A runtime that installed no
 * arm while undecided would open no subscribe, learn nothing, and stall
 * forever on a connection whose support never resolves on its own - which is
 * exactly what a remote mux transport does (`RemoteStreamClient` hardcodes
 * `"unknown"`).
 *
 * A prior round of tests covered `readEpicAdapterVerdict` and
 * `planEpicAdapterTransition` in isolation and never started a real runtime
 * with unresolved support, so the probe wiring itself went unpinned. Every
 * test below drives the real `createEpicReplicaRuntime` - the same
 * construction `store.ts` uses, minus the zustand wrapper - through real
 * (counting) client factories, and asserts on how many times each factory
 * was invoked or told to close. Nothing here asserts on the verdict function
 * alone: that function was already correct, and the bug lived in what the
 * runtime DID with an undecided answer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EPIC_LANE_METHODS } from "@traycer-clients/shared/epic-lanes";
import type {
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import type { ArtifactStreamClientFactory } from "@traycer-clients/shared/epic-lanes";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import { artifactSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import {
  createEpicReplicaRuntime,
  type EpicLaneSelectionSources,
  type EpicReplicaRuntime,
} from "../runtime/epic-replica-runtime";
import type { EpicStreamClientFactory } from "../runtime/legacy-epic-stream-adapter";
import type { EpicMethodSupportReader } from "../runtime/epic-adapter-selection";
import type { EpicWriteCommandIntent } from "../runtime/epic-write-command";
import { createRendererRuntimeEnvironment } from "../runtime/runtime-environment";
import { createBatchingDelivery } from "../runtime/projection-delivery";
import { DOC_IS_THE_ONLY_RECORD_SOURCE } from "../projection-helpers";

// ── A controllable support reader ───────────────────────────────────────────

interface SupportController {
  readonly support: EpicMethodSupportReader;
  readonly subscribeSupport: (listener: () => void) => () => void;
  set(method: string, value: StreamMethodSupport): void;
  /** Fire every listener registered through `subscribeSupport`. */
  notify(): void;
}

/** Defaults to `"unknown"` for any method never explicitly `set`. */
function createSupportController(): SupportController {
  const values = new Map<string, StreamMethodSupport>();
  const listeners = new Set<() => void>();
  return {
    support: (method) => values.get(method) ?? "unknown",
    subscribeSupport: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(method, value) {
      values.set(method, value);
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
}

function markAllLaneMethodsSupported(support: SupportController): void {
  for (const method of EPIC_LANE_METHODS) support.set(method, "supported");
}

/**
 * The relay transport, as a value a test CANNOT shortcut.
 *
 * `RemoteStreamClient.getMethodSupport` answers `"unknown"` forever - the mux
 * resolves an incompatible method as a fatal on the subscribe attempt rather
 * than as a queryable pre-check - and its listeners never fire, because there
 * is nothing to report. This is deliberately a frozen literal with no `set`
 * and no `notify` in scope: an earlier version of this pin used the mutable
 * controller and resolved support BY HAND, which drove the manifest branch and
 * left the relay invariant the test is named for completely unpinned.
 */
const FOREVER_UNKNOWN_SUPPORT: {
  readonly support: EpicMethodSupportReader;
  readonly subscribeSupport: (listener: () => void) => () => void;
} = Object.freeze({
  support: () => "unknown",
  subscribeSupport: () => () => {},
});

interface CountingArtifactFactory {
  readonly factory: ArtifactStreamClientFactory;
  openCount(): number;
  /**
   * Deliver a terminal `staleAuthorityEpoch` for the most recently opened
   * body, the way the host does when the generation a body attached under is
   * no longer served.
   */
  deliverStaleAuthorityEpoch(artifactId: string): void;
}

/** The body-lane factory, capturing callbacks so a test can deliver frames. */
function createCountingArtifactFactory(): CountingArtifactFactory {
  let opens = 0;
  let live: ArtifactStreamCallbacks | null = null;
  const factory: ArtifactStreamClientFactory = (
    _epicId,
    _artifactId,
    _authorityEpoch,
    callbacks,
    _seedOfferProvider,
  ) => {
    opens += 1;
    live = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    };
  };
  return {
    factory,
    openCount: () => opens,
    deliverStaleAuthorityEpoch(artifactId): void {
      if (live === null) throw new Error("no artifact client was constructed");
      const parsed = artifactSubscribeServerFrameSchemaV10.parse({
        kind: "unavailable",
        hasBinaryPayload: false,
        authorityEpoch: "epoch-1",
        artifactId,
        code: "staleAuthorityEpoch",
        reason: "the epic replica was replaced",
        terminal: true,
      });
      if (parsed.kind !== "unavailable") {
        throw new Error(`expected an unavailable frame, got ${parsed.kind}`);
      }
      live.onUnavailable(parsed);
    },
  };
}

// ── Counting factories - trivial and honest, per the shared adapters' own
//    factory contracts ("(epicId, callbacks) => { close(): void }") ─────────

interface CountingStatusFactory {
  readonly factory: EpicStatusStreamClientFactory;
  openCount(): number;
  closeCount(): number;
  deliverSnapshot(): void;
  deliverMethodUnsupported(): void;
}

function createCountingStatusFactory(): CountingStatusFactory {
  let opens = 0;
  let closes = 0;
  let live: EpicStatusStreamCallbacks | null = null;
  const factory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    opens += 1;
    live = callbacks;
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  return {
    factory,
    openCount: () => opens,
    closeCount: () => closes,
    /**
     * Deliver the control lane's first frame, the way a served subscription
     * does. This is the SUCCESS signal the probe reads: a frame can only
     * arrive if the host is serving the method.
     */
    deliverSnapshot(): void {
      if (live === null) throw new Error("no status client was constructed");
      live.onSnapshot(statusSnapshotFrame());
    },
    /**
     * Resolve the subscribe as method-incompatible, the way the mux does -
     * a fatal close carrying `INCOMPATIBLE`, which `isMethodIncompatibleClose`
     * is the shared predicate for. This is the only capability evidence a
     * REMOTE session ever produces.
     */
    deliverMethodUnsupported(): void {
      if (live === null) throw new Error("no status client was constructed");
      live.onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "epic.status.subscribe is not served by this host",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    },
  };
}

/**
 * A real control-lane snapshot, built through the wire schema's own `parse`.
 *
 * Hand-rolling the object would let a field drift out of the contract without
 * any test noticing - vitest does not type-check - so this goes through the
 * exported discriminated union and narrows the result.
 */
function statusSnapshotFrame(): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    // The text-only marker every frame on the two RECORD lanes carries.
    // Omitting it is a parse error, which is the point of building this
    // through the schema instead of by hand.
    hasBinaryPayload: false,
    authorityEpoch: "epoch-1",
    securityEpoch: 1,
    permissionRole: "owner",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a snapshot frame, got ${parsed.kind}`);
  }
  return parsed;
}

interface CountingStateFactory {
  readonly factory: EpicStateStreamClientFactory;
  openCount(): number;
  closeCount(): number;
}

function createCountingStateFactory(): CountingStateFactory {
  let opens = 0;
  let closes = 0;
  const factory: EpicStateStreamClientFactory = (
    _epicId,
    _callbacks,
    _resumeProvider,
  ) => {
    opens += 1;
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  return { factory, openCount: () => opens, closeCount: () => closes };
}

interface CountingLegacyFactory {
  readonly factory: EpicStreamClientFactory;
  openCount(): number;
}

/** The `epic.subscribe@1` factory - the "speculative fat stream" this pin forbids. */
function createCountingLegacyFactory(): CountingLegacyFactory {
  let opens = 0;
  const factory: EpicStreamClientFactory = (
    _epicId,
    _callbacks,
    _seedOfferProvider,
  ) => {
    opens += 1;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  return { factory, openCount: () => opens };
}

// ── Runtime construction ─────────────────────────────────────────────────────

interface RuntimeRig {
  readonly runtime: EpicReplicaRuntime;
  readonly legacy: CountingLegacyFactory;
  readonly status: CountingStatusFactory;
  readonly state: CountingStateFactory;
  /** `null` on the forever-unknown rig - there is nothing to control. */
  readonly support: SupportController | null;
  readonly artifacts: CountingArtifactFactory;
}

let nextEpicSequence = 0;

/**
 * Builds a real `createEpicReplicaRuntime`, with a real (lane-capable)
 * `laneSelection` wired to counting factories. Every non-lane source is the
 * same one `store.ts` passes in production - `createRendererRuntimeEnvironment`,
 * `createBatchingDelivery`, `DOC_IS_THE_ONLY_RECORD_SOURCE` - reused rather
 * than reinvented, so the only thing under test is the lane-selection wiring
 * itself.
 */
/**
 * The two support sources a pin may run against.
 *
 * `"forever-unknown"` is the relay case and hands back NO controller, so a test
 * on it physically cannot resolve support by hand - which is the mistake the
 * first version of this suite made.
 */
type SupportMode = "forever-unknown" | "controllable";

function buildRuntimeRig(mode: SupportMode): RuntimeRig {
  nextEpicSequence += 1;
  const legacy = createCountingLegacyFactory();
  const status = createCountingStatusFactory();
  const state = createCountingStateFactory();
  const artifacts = createCountingArtifactFactory();
  const support = mode === "controllable" ? createSupportController() : null;
  const laneSelection: EpicLaneSelectionSources = {
    support: support?.support ?? FOREVER_UNKNOWN_SUPPORT.support,
    subscribeSupport:
      support?.subscribeSupport ?? FOREVER_UNKNOWN_SUPPORT.subscribeSupport,
    stateStreamClientFactory: state.factory,
    statusStreamClientFactory: status.factory,
    artifactStreamClientFactory: artifacts.factory,
  };
  const runtime = createEpicReplicaRuntime({
    epicId: `epic-lane-probe-${nextEpicSequence}`,
    hostId: "host-1",
    environment: createRendererRuntimeEnvironment(),
    streamClientFactory: legacy.factory,
    delivery: createBatchingDelivery(() => {}),
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
  return { runtime, legacy, status, state, support, artifacts };
}

/**
 * Narrow the rig's nullable controller for the `"controllable"` pins.
 *
 * A throw rather than a non-null assertion: the two are the same claim, but
 * this one states which rig the caller asked for when it is wrong.
 */
function requireSupport(rig: RuntimeRig): SupportController {
  if (rig.support === null) {
    throw new Error("this rig was built forever-unknown and has no controller");
  }
  return rig.support;
}

describe("lane adapter probe - forever-unknown support must still reach the lanes", () => {
  const runtimes: EpicReplicaRuntime[] = [];

  afterEach(() => {
    // `dispose()` is idempotent, so this is safe whether or not a test already
    // tore its own runtime down.
    for (const runtime of runtimes.splice(0)) {
      runtime.dispose();
    }
  });

  it("(a) the relay case: forever-unknown support installs the lanes off the PROBE'S OWN OUTCOME, adopting its stream", () => {
    const rig = buildRuntimeRig("forever-unknown");
    runtimes.push(rig.runtime);

    rig.runtime.start();

    // Exactly one status stream client was constructed (the probe), and ZERO
    // state clients - the records lane must not open before the arm is
    // settled. No speculative fat `epic.subscribe@1` either.
    expect(rig.status.openCount()).toBe(1);
    expect(rig.state.openCount()).toBe(0);
    expect(rig.legacy.openCount()).toBe(0);

    // The host serves the subscription: its first control frame arrives.
    //
    // This is the ONLY thing that happens. Support is still `"unknown"` for
    // every method and no listener ever fires - `FOREVER_UNKNOWN_SUPPORT` has
    // no `set` and no `notify` to reach. So if the runtime installed the arm
    // by re-reading the manifest, nothing here could ever make it do so, and
    // the epic would never render. That is the relay stall this pin exists
    // for, and resolving support by hand is precisely how a previous version
    // of this test hid it.
    rig.status.deliverSnapshot();

    // The lanes are now fully attached: a state client was constructed...
    expect(rig.state.openCount()).toBe(1);
    // ...and the status client count is STILL exactly 1 - the probe's stream
    // was adopted, not replaced. A fix that opened a second status stream on
    // resolution would still look like it "worked" and must fail here.
    expect(rig.status.openCount()).toBe(1);
    expect(rig.legacy.openCount()).toBe(0);
    // Nothing asked for a body, so no body lane opened.
    expect(rig.artifacts.openCount()).toBe(0);
  });

  it("(b) forever-unknown then a typed method-incompatible close installs legacy and closes the probe", () => {
    const rig = buildRuntimeRig("forever-unknown");
    runtimes.push(rig.runtime);

    rig.runtime.start();
    expect(rig.status.openCount()).toBe(1);
    expect(rig.legacy.openCount()).toBe(0);

    // The mux refuses the method: a fatal close carrying `INCOMPATIBLE`.
    // This is the ONLY capability evidence a remote session produces - it
    // never updates `getMethodSupport` - so a runtime that waits for the
    // manifest waits forever here too.
    rig.status.deliverMethodUnsupported();

    // The legacy adapter is now open.
    expect(rig.legacy.openCount()).toBe(1);
    // One attempted open (the probe), not zero and not two.
    expect(rig.status.openCount()).toBe(1);
    // The probe must not leak a socket once its question is answered.
    expect(rig.status.closeCount()).toBe(1);
    // The records lane was never attached on this connection.
    expect(rig.state.openCount()).toBe(0);
  });

  it("(e) one epoch change reported TWICE rebuilds the replica exactly once", () => {
    const rig = buildRuntimeRig("forever-unknown");
    runtimes.push(rig.runtime);

    rig.runtime.start();
    rig.status.deliverSnapshot();
    expect(rig.state.openCount()).toBe(1);

    // Open one body, so a body lane exists to report a stale epoch.
    const release = rig.runtime.acquireArtifactBodyLease("art-1");
    expect(rig.artifacts.openCount()).toBe(1);

    const before = rig.runtime.replicaGeneration();

    // ONE frame, which the adapter reports through TWO paths: its translated
    // `doc-unavailable` (which `lane-body-translation` turns into
    // `replace-replica`) and its own explicit `requestReplacement` right
    // after. Both are true statements about the same event.
    rig.artifacts.deliverStaleAuthorityEpoch("art-1");

    // Exactly one rebuild. `replaceForAuthority` used to claim this
    // coalescing in its doc comment while `replicaGenerationCounter += 1` ran
    // unconditionally, so one epoch change bumped the generation twice and
    // asked every consumer to rebuild twice. `toBe(before + 1)` rather than
    // `toBeGreaterThan(before)`: the whole defect is the SIZE of the step.
    expect(rig.runtime.replicaGeneration()).toBe(before + 1);

    release();
  });

  describe("(c) the already-resolved paths are unchanged", () => {
    it("support already SUPPORTED at start() attaches the lanes directly - legacy never opens", () => {
      const rig = buildRuntimeRig("controllable");
      runtimes.push(rig.runtime);
      markAllLaneMethodsSupported(requireSupport(rig));

      rig.runtime.start();

      expect(rig.state.openCount()).toBe(1);
      expect(rig.legacy.openCount()).toBe(0);
    });

    it("support already UNSUPPORTED at start() installs legacy directly - no status client is ever constructed", () => {
      const rig = buildRuntimeRig("controllable");
      runtimes.push(rig.runtime);
      requireSupport(rig).set("epic.state.subscribe", "unsupported");

      rig.runtime.start();

      expect(rig.legacy.openCount()).toBe(1);
      // Nothing to probe when the answer is already known at start().
      expect(rig.status.openCount()).toBe(0);
      expect(rig.state.openCount()).toBe(0);
    });
  });

  describe("(d) teardown with a probe outstanding does not leak", () => {
    it("dispose() closes the probe's status client", () => {
      const rig = buildRuntimeRig("forever-unknown");
      runtimes.push(rig.runtime);

      rig.runtime.start();
      expect(rig.status.openCount()).toBe(1);
      expect(rig.status.closeCount()).toBe(0);

      rig.runtime.dispose();

      expect(rig.status.closeCount()).toBe(1);
    });

    it("detachTransport() closes the probe's status client", () => {
      const rig = buildRuntimeRig("forever-unknown");
      runtimes.push(rig.runtime);

      rig.runtime.start();
      expect(rig.status.openCount()).toBe(1);
      expect(rig.status.closeCount()).toBe(0);

      rig.runtime.detachTransport();

      expect(rig.status.closeCount()).toBe(1);
    });
  });
});
