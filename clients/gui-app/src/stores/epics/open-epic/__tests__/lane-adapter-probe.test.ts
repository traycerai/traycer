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
import type {
  EpicStateSnapshotFrame,
  EpicStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import type { EpicMigrationStatus } from "@traycer/protocol/host/epic/status-subscribe";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
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
import { createRecordingAccountingPort } from "../runtime/__tests__/accounting-port-fixture";
import { createBatchingDelivery } from "../runtime/projection-delivery";
import { DOC_IS_THE_ONLY_RECORD_SOURCE } from "../projection-helpers";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";

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
   * How many constructed body clients have had `close()` invoked, summed
   * across every artifact this factory has ever built one for.
   *
   * Added for the lease-closure idempotency pin below - no pre-existing test
   * in this file reads it, and `close()` itself stays a no-op otherwise.
   */
  closeCount(): number;
  /**
   * Deliver a terminal `staleAuthorityEpoch` for the named body, the way the
   * host does when the generation it attached under is no longer served.
   */
  deliverStaleAuthorityEpoch(artifactId: string): void;
  /**
   * Resolve the named body as method-incompatible, the way the mux does when
   * `artifact.subscribe` itself is refused - a statement about the ARM, not
   * the tile. Keyed per artifact because more than one body lane may be open
   * at once, each with its own captured callbacks.
   */
  deliverMethodUnsupported(artifactId: string): void;
}

/**
 * The body-lane factory, capturing each constructed body's OWN callbacks -
 * keyed by artifact id - so a test can deliver frames to one tile among
 * several without disturbing the others.
 */
function createCountingArtifactFactory(): CountingArtifactFactory {
  let opens = 0;
  let closes = 0;
  const live = new Map<string, ArtifactStreamCallbacks>();
  const factory: ArtifactStreamClientFactory = ({ artifactId, callbacks }) => {
    opens += 1;
    live.set(artifactId, callbacks);
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => {
        closes += 1;
      },
    };
  };
  function requireLive(artifactId: string): ArtifactStreamCallbacks {
    const callbacks = live.get(artifactId);
    if (callbacks === undefined) {
      throw new Error(`no artifact client was constructed for ${artifactId}`);
    }
    return callbacks;
  }
  return {
    factory,
    openCount: () => opens,
    closeCount: () => closes,
    deliverStaleAuthorityEpoch(artifactId): void {
      const callbacks = requireLive(artifactId);
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
      callbacks.onUnavailable(parsed);
    },
    deliverMethodUnsupported(artifactId): void {
      const callbacks = requireLive(artifactId);
      callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "artifact.subscribe is not served by this host",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
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
  /**
   * Resolve the records lane as method-incompatible, the way the mux does for
   * a lane behind a flag or a rolling upgrade - a fatal close carrying
   * `INCOMPATIBLE`. Mirrors `CountingStatusFactory.deliverMethodUnsupported`:
   * this is the only capability evidence a REMOTE session ever produces for
   * this lane.
   */
  deliverMethodUnsupported(): void;
}

function createCountingStateFactory(): CountingStateFactory {
  let opens = 0;
  let closes = 0;
  let live: EpicStateStreamCallbacks | null = null;
  const factory: EpicStateStreamClientFactory = (
    _epicId,
    callbacks,
    _resumeProvider,
  ) => {
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
    deliverMethodUnsupported(): void {
      if (live === null) throw new Error("no state client was constructed");
      live.onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "epic.state.subscribe is not served by this host",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    },
  };
}

interface CountingLegacyFactory {
  readonly factory: EpicStreamClientFactory;
  openCount(): number;
  /**
   * How many `@1` clients have been closed. The mirror of the status lane's
   * own `closeCount`, and what makes "legacy was RETIRED, not left running
   * beside the lanes" observable on the re-probe upgrade path.
   */
  closeCount(): number;
}

/** The `epic.subscribe@1` factory - the "speculative fat stream" this pin forbids. */
function createCountingLegacyFactory(): CountingLegacyFactory {
  let opens = 0;
  let closes = 0;
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
      close: () => {
        closes += 1;
      },
    };
  };
  return { factory, openCount: () => opens, closeCount: () => closes };
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
type SupportMode =
  | "forever-unknown"
  | "forever-unknown-notifiable"
  | "controllable";

/**
 * The relay case AFTER the worker's manifest-registry subscription exists.
 *
 * Support is still `"unknown"` for every method and forever - this is a relay,
 * and `RemoteStreamClient` has nothing to report - but the listener CAN fire.
 * That pairing is not a contrivance: `spawn-epic-runtime-worker` re-emits its
 * manifest on `subscribeNegotiatedManifests`, and the negotiated registry is
 * rewritten on every session re-attach, so a relay reconnect now reaches
 * `applySelection` while every support answer it reads stays `"unknown"`.
 *
 * `FOREVER_UNKNOWN_SUPPORT` deliberately cannot do this - its listener is a
 * no-op - which is why the re-probe pins need their own source rather than a
 * flag on that one.
 */
function createForeverUnknownNotifiableSupport(): SupportController {
  const listeners = new Set<() => void>();
  return {
    support: () => "unknown",
    subscribeSupport: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set() {
      throw new Error(
        "this source is forever-unknown by construction; resolving support by hand is the mistake it exists to prevent",
      );
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
}

/** `null` for `"forever-unknown"`, which has no controller by design. */
function buildSupportSource(mode: SupportMode): SupportController | null {
  if (mode === "controllable") return createSupportController();
  if (mode === "forever-unknown-notifiable") {
    return createForeverUnknownNotifiableSupport();
  }
  return null;
}

function buildRuntimeRig(mode: SupportMode): RuntimeRig {
  nextEpicSequence += 1;
  const legacy = createCountingLegacyFactory();
  const status = createCountingStatusFactory();
  const state = createCountingStateFactory();
  const artifacts = createCountingArtifactFactory();
  const support = buildSupportSource(mode);
  const laneSelection: EpicLaneSelectionSources = {
    support: support?.support ?? FOREVER_UNKNOWN_SUPPORT.support,
    subscribeSupport:
      support?.subscribeSupport ?? FOREVER_UNKNOWN_SUPPORT.subscribeSupport,
    stateStreamClientFactory: state.factory,
    statusStreamClientFactory: status.factory,
    artifactStreamClientFactory: artifacts.factory,
    unaries: absentLaneUnaries(),
  };
  const runtime = createEpicReplicaRuntime({
    epicId: `epic-lane-probe-${nextEpicSequence}`,
    environment: createRendererRuntimeEnvironment(),
    streamClientFactory: legacy.factory,
    delivery: createBatchingDelivery(() => {}),
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

  /**
   * (b2) The RE-PROBE, and the reason the arm's single answer is per
   * ATTACHMENT rather than per runtime.
   *
   * Over a relay the verdict is `"undecided"` for the life of the runtime, so
   * the manifest can never move an arm. Once (b) installs legacy, the whole
   * "a host that upgrades under this tab moves onto the lanes" contract used
   * to be dead on exactly the transport that needs it most: the tab stayed on
   * `@1` until something recreated the runtime.
   *
   * The stimulus is a support NOTIFY with support still unknown - which is
   * what a relay re-attach now delivers, since the negotiated-manifest
   * registry is rewritten on every re-handshake and the worker re-emits on it.
   */
  it("(b2) a relay host upgraded in place re-probes on the reconnect edge and moves the legacy tab onto the lanes", () => {
    const rig = buildRuntimeRig("forever-unknown-notifiable");
    runtimes.push(rig.runtime);
    const support = requireSupport(rig);

    rig.runtime.start();
    rig.status.deliverMethodUnsupported();
    expect(rig.legacy.openCount()).toBe(1);
    expect(rig.status.openCount()).toBe(1);
    expect(rig.status.closeCount()).toBe(1);

    // The re-handshake. Support has NOT moved and cannot - this source has no
    // `set` - so nothing here resolves a manifest verdict. The only thing that
    // can decide is another subscribe.
    support.notify();

    // THE REDDENING ASSERTION: a second status stream was opened. Under the
    // old `installedArm === null` guard this stayed at 1 forever.
    expect(rig.status.openCount()).toBe(2);
    // The legacy arm is still serving while the question is outstanding - a
    // probe must not blank the epic it is asking about.
    expect(rig.legacy.closeCount()).toBe(0);
    expect(rig.state.openCount()).toBe(0);

    // The upgraded host serves it.
    rig.status.deliverSnapshot();

    expect(rig.state.openCount()).toBe(1);
    // The re-probe's own stream was adopted, exactly as the first probe's is
    // on the (a) path - not replaced by a third.
    expect(rig.status.openCount()).toBe(2);
    // And legacy was retired rather than left running beside the lanes.
    expect(rig.legacy.closeCount()).toBe(1);
  });

  /**
   * (b3) A refused RE-probe has to clean up after itself, or there is exactly
   * ONE re-probe ever.
   *
   * The first refusal is tidied by `attachArm("legacy")`, which detaches the
   * arm on its way to installing `@1`. A refusal that finds legacy ALREADY
   * installed plans no transition steps, so it never reaches that code - which
   * left the probe's stream open and the arm's single answer spent. The next
   * reconnect's `probe()` then found the status lane attached, emitted no
   * subscribe, and every re-probe after the first was silently inert.
   *
   * This is the pin that distinguishes "re-probes once" from "re-probes".
   */
  it("(b3) a refused re-probe retires its own stream, so the NEXT reconnect probes again", () => {
    const rig = buildRuntimeRig("forever-unknown-notifiable");
    runtimes.push(rig.runtime);
    const support = requireSupport(rig);

    rig.runtime.start();
    rig.status.deliverMethodUnsupported();
    support.notify();
    expect(rig.status.openCount()).toBe(2);

    // Still an old host: the re-probe is refused the same typed way.
    rig.status.deliverMethodUnsupported();
    expect(rig.legacy.openCount()).toBe(1);
    // The refused re-probe closed its own socket - 2 opens, 2 closes.
    expect(rig.status.closeCount()).toBe(2);

    // A THIRD reconnect. This is the one that was inert.
    support.notify();
    expect(rig.status.openCount()).toBe(3);

    // And it can still succeed, so the inertness was the only thing fixed -
    // the arm did not burn its answer on the refusal.
    rig.status.deliverSnapshot();
    expect(rig.state.openCount()).toBe(1);
    expect(rig.legacy.closeCount()).toBe(1);
  });

  /**
   * (b4) CONTROL, green both sides. A host whose support genuinely RESOLVED to
   * unsupported answers `"legacy"`, not `"undecided"`, so it must not re-probe
   * on every support change - that would be a refused subscribe per edge on a
   * population that has already told us the answer.
   *
   * Without this, the (b2)/(b3) pins would also pass on a re-probe keyed on
   * "legacy is installed" alone, which is a different and wrong rule.
   */
  it("(b4) a host whose support RESOLVED to unsupported does not re-probe on a support change", () => {
    const rig = buildRuntimeRig("controllable");
    runtimes.push(rig.runtime);
    const support = requireSupport(rig);

    for (const method of EPIC_LANE_METHODS) support.set(method, "unsupported");
    rig.runtime.start();

    // A decided `"legacy"` verdict installs `@1` with no probe at all.
    expect(rig.legacy.openCount()).toBe(1);
    expect(rig.status.openCount()).toBe(0);

    support.notify();
    support.notify();

    // Still zero. The verdict is decided, so the manifest is the authority and
    // there is nothing for a subscribe to add.
    expect(rig.status.openCount()).toBe(0);
    expect(rig.legacy.openCount()).toBe(1);
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

  it("(f) status success -> state INCOMPATIBLE -> legacy, while support stays unknown throughout", () => {
    const rig = buildRuntimeRig("forever-unknown");
    runtimes.push(rig.runtime);

    rig.runtime.start();
    rig.status.deliverSnapshot();
    expect(rig.state.openCount()).toBe(1);
    expect(rig.legacy.openCount()).toBe(0);

    // The records lane is REQUIRED, and support on this rig never moves off
    // "unknown" - see `FOREVER_UNKNOWN_SUPPORT`. Nothing but this typed close
    // could have produced the fallback below.
    rig.state.deliverMethodUnsupported();

    expect(rig.legacy.openCount()).toBe(1);
    // One attempted open (the records lane never reopens on this arm), not
    // zero and not two.
    expect(rig.state.openCount()).toBe(1);
    expect(rig.state.closeCount()).toBe(1);
    // The status lane is part of the same arm and comes down with it.
    expect(rig.status.closeCount()).toBe(1);
  });

  it("(g) status + state success -> first body INCOMPATIBLE -> legacy, exactly ONE replacement with N>1 tiles", () => {
    const rig = buildRuntimeRig("forever-unknown");
    runtimes.push(rig.runtime);

    rig.runtime.start();
    rig.status.deliverSnapshot();
    expect(rig.state.openCount()).toBe(1);

    const releaseA = rig.runtime.acquireArtifactBodyLease("art-1");
    const releaseB = rig.runtime.acquireArtifactBodyLease("art-2");
    const releaseC = rig.runtime.acquireArtifactBodyLease("art-3");
    expect(rig.artifacts.openCount()).toBe(3);

    const before = rig.runtime.replicaGeneration();

    // Only ONE of the three open tiles reports the refusal - the arm's
    // contract is to coalesce across every body under it, not to fall back
    // per tile.
    rig.artifacts.deliverMethodUnsupported("art-1");

    // Exactly one whole-epic legacy install, not one per open tile.
    expect(rig.legacy.openCount()).toBe(1);
    // `toBe`, not `toBeGreaterThan`: a per-tile fallback that replaced once
    // per open body would still "work" (end up on legacy) and must fail
    // here on the generation step count alone.
    expect(rig.runtime.replicaGeneration()).toBe(before + 1);

    releaseA();
    releaseB();
    releaseC();
  });

  it("(h) the typed manifest answer agrees with the close answer: artifact.subscribe unsupported installs legacy, not lanes", () => {
    const rig = buildRuntimeRig("controllable");
    runtimes.push(rig.runtime);
    const support = requireSupport(rig);
    markAllLaneMethodsSupported(support);
    // The real wire method name, read off the shared tuple rather than typed
    // by hand - `EPIC_LANE_METHODS` orders them state, status, artifact.
    support.set(EPIC_LANE_METHODS[2], "unsupported");

    rig.runtime.start();

    // Same destination as (g), reached through the manifest instead of a
    // close: one required lane refused is enough to keep the arm off
    // "lanes" entirely - never a partial install with two lanes serving and
    // one missing.
    expect(rig.legacy.openCount()).toBe(1);
    expect(rig.status.openCount()).toBe(0);
    expect(rig.state.openCount()).toBe(0);
    expect(rig.artifacts.openCount()).toBe(0);
  });

  it("(i) the required-lane latch is per ARM, not per session: two transitions on one arm object", () => {
    // The "controllable" rig, not the frozen one: this pin needs a SECOND
    // manifest resolution after the first fallback to legacy, and
    // `FOREVER_UNKNOWN_SUPPORT.subscribeSupport` is a hardcoded
    // `() => () => {}` with no `set` and nothing to `notify` - a rig built on
    // it cannot express that resolve at all. Building a second runtime for
    // that half would prove two transitions on TWO arm objects, not the one
    // this pin is about - `createEpicLaneArm` is constructed once per runtime
    // and outlives every arm it serves (see its own module doc). Left
    // entirely unset before `start()`, every method reads "unknown" by
    // `createSupportController`'s own default, which is the same undecided
    // verdict the frozen rig starts on - so the probe half below runs exactly
    // like (a)/(b) until the manifest is deliberately resolved.
    const rig = buildRuntimeRig("controllable");
    runtimes.push(rig.runtime);
    const support = requireSupport(rig);

    rig.runtime.start();
    expect(rig.status.openCount()).toBe(1);
    expect(rig.state.openCount()).toBe(0);
    expect(rig.legacy.openCount()).toBe(0);

    // The probe succeeds: lanes install as arm #1.
    rig.status.deliverSnapshot();
    expect(rig.state.openCount()).toBe(1);
    expect(rig.legacy.openCount()).toBe(0);

    // Transition 1: the records lane - required - is refused on arm #1.
    rig.state.deliverMethodUnsupported();
    expect(rig.legacy.openCount()).toBe(1);

    // A later host upgrade re-selects lanes on the SAME `laneArm` object -
    // the manifest resolving "lanes" mid-session, which is exactly what
    // `subscribeSupport`'s listener (registered in `start()`) exists to
    // carry without a reopen.
    markAllLaneMethodsSupported(support);
    support.notify();

    // Lanes are attached again as arm #2, on the object that already fell
    // back once: a fresh state client was opened, and legacy has not opened
    // a second time from this alone.
    expect(rig.state.openCount()).toBe(2);
    expect(rig.legacy.openCount()).toBe(1);

    // Transition 2: the records lane is refused again, on arm #2. With the
    // latch cleared in `detach()` this is arm #2's own first report and goes
    // through; with a session-scoped latch, arm #1's report already set it
    // and this call is silently swallowed - `onRequiredLaneUnsupported` never
    // fires, `installedArm` stays "lanes" on a dead records lane, and the
    // epic renders nothing with no path left to repair it.
    rig.state.deliverMethodUnsupported();

    // Asserted on the COUNT, not on a boolean "is legacy installed" - a
    // boolean would already read true from transition 1 and pass under the
    // bug. Only the second transition actually happening moves this to 2.
    expect(rig.legacy.openCount()).toBe(2);
  });

  it("(j) acquireArtifactBodyLease's lease closure is idempotent on the demand half, not just the tier half", () => {
    const rig = buildRuntimeRig("forever-unknown");
    runtimes.push(rig.runtime);

    rig.runtime.start();
    rig.status.deliverSnapshot();
    expect(rig.state.openCount()).toBe(1);

    // Two independent runtime leases on the SAME artifact - a canvas tile and
    // the mobile switcher's preview both wanting "art-1" open at once is the
    // ordinary case `EpicArtifactBodyLanes.release`'s own doc names.
    const releaseA = rig.runtime.acquireArtifactBodyLease("art-1");
    const releaseB = rig.runtime.acquireArtifactBodyLease("art-1");
    // One body client, not two: the second `ensureAttached` finds the lane
    // already open under the observed epoch and only adds demand.
    expect(rig.artifacts.openCount()).toBe(1);
    expect(rig.artifacts.closeCount()).toBe(0);

    // Lease A's own closure invoked TWICE - the `finally` backstop shape the
    // fix's doc comment names (an early release followed by a defensive
    // re-release on the same holder). The tier lease already guards itself
    // internally, so this is entirely about the demand half.
    releaseA();
    releaseA();

    // Still open: lease B never released and still wants this body. Without
    // the `released` flag the second `releaseA()` call is a second,
    // unguarded `laneArm.bodies.release("art-1", ...)`, which drives demand
    // 2 -> 1 -> 0 and closes a body lease B is still using - this is the
    // assertion that catches it; it reads 1 here without the fix.
    expect(rig.artifacts.closeCount()).toBe(0);

    // Lease B releases once. Demand is now genuinely at zero.
    releaseB();

    expect(rig.artifacts.closeCount()).toBe(1);
  });
});

// ── Replacement coalescing (FIX B) and resume-too-old scope (FIX C) ────────
//
// A separate rig from `buildRuntimeRig` above: those factories only ever
// deliver ONE hardcoded epoch-1 snapshot (`deliverSnapshot()`), which is
// enough for the probe-wiring pins above but cannot drive a SECOND epoch
// change, a chosen `basis`, or a migration state - all three of which these
// two fixes need. `ControllableStatusFactory` / `ControllableStateFactory`
// expose the raw captured callbacks instead, so a test can deliver whatever
// sequence of frames the fix's contract names.

function statusSnapshotFrameAt(
  authorityEpoch: string,
  migration: EpicMigrationStatus | null,
): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    securityEpoch: 1,
    permissionRole: "owner",
    cloudSyncStatus: "connected",
    dirty: false,
    migration,
    deletion: { state: "none" },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function stateSnapshotFrameAt(
  authorityEpoch: string,
  basis: "cold" | "resumeTooOld" | "authorityEpochChanged",
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
      meta: { title: "Coalescing epic", updatedAt: 1000 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

interface ControllableStatusFactory {
  readonly factory: EpicStatusStreamClientFactory;
  /** The control lane's transport reaching `"open"`. */
  open(): void;
  deliverSnapshot(frame: EpicStatusSnapshotFrame): void;
}

function createControllableStatusFactory(): ControllableStatusFactory {
  let live: EpicStatusStreamCallbacks | null = null;
  const factory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    live = callbacks;
    return { close: () => undefined };
  };
  function requireLive(): EpicStatusStreamCallbacks {
    if (live === null) throw new Error("no status client was constructed");
    return live;
  }
  return {
    factory,
    open: () => requireLive().onConnectionStatus("open", null),
    deliverSnapshot: (frame) => requireLive().onSnapshot(frame),
  };
}

interface ControllableStateFactory {
  readonly factory: EpicStateStreamClientFactory;
  /** The records lane's transport reaching `"open"`. */
  open(): void;
  deliverSnapshot(frame: EpicStateSnapshotFrame): void;
}

function createControllableStateFactory(): ControllableStateFactory {
  let live: EpicStateStreamCallbacks | null = null;
  const factory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    live = callbacks;
    return { close: () => undefined };
  };
  function requireLive(): EpicStateStreamCallbacks {
    if (live === null) throw new Error("no state client was constructed");
    return live;
  }
  return {
    factory,
    open: () => requireLive().onConnectionStatus("open", null),
    deliverSnapshot: (frame) => requireLive().onSnapshot(frame),
  };
}

/**
 * A lane-capable runtime with CONTROLLABLE status/state factories and a
 * recording write-command sender, for driving replacement coalescing
 * (FIX B) and the `resume-too-old` scope (FIX C) directly. Support is marked
 * fully supported before `start()`, so both lanes attach immediately -
 * unlike `buildRuntimeRig`, this rig is not about arm SELECTION.
 */
function buildCoalescingRig(): {
  readonly runtime: EpicReplicaRuntime;
  readonly status: ControllableStatusFactory;
  readonly state: ControllableStateFactory;
  readonly sentCommandCount: () => number;
} {
  nextEpicSequence += 1;
  const legacy = createCountingLegacyFactory();
  const status = createControllableStatusFactory();
  const state = createControllableStateFactory();
  const artifacts = createCountingArtifactFactory();
  const support = createSupportController();
  markAllLaneMethodsSupported(support);
  const laneSelection: EpicLaneSelectionSources = {
    support: support.support,
    subscribeSupport: support.subscribeSupport,
    stateStreamClientFactory: state.factory,
    statusStreamClientFactory: status.factory,
    artifactStreamClientFactory: artifacts.factory,
    unaries: absentLaneUnaries(),
  };
  let sentCommands = 0;
  let nextCommandId = 0;
  const runtime = createEpicReplicaRuntime({
    epicId: `epic-replacement-coalescing-${nextEpicSequence}`,
    environment: createRendererRuntimeEnvironment(),
    streamClientFactory: legacy.factory,
    delivery: createBatchingDelivery(() => {}),
    accounting: createRecordingAccountingPort(),
    getCurrentUserId: () => null,
    getDocArm: () => DOC_IS_THE_ONLY_RECORD_SOURCE,
    onAuthError: null,
    commandIdFactory: {
      next: () => `coalescing-command-${(nextCommandId += 1)}`,
    },
    writeCommandSender: {
      currentHostId: () => "coalescing-test-host",
      send: (_commandId: string, _intent: EpicWriteCommandIntent) => {
        sentCommands += 1;
        return Promise.resolve({ hostId: "coalescing-test-host" });
      },
    },
    laneSelection,
  });
  return { runtime, status, state, sentCommandCount: () => sentCommands };
}

/** Drains the command queue's async send chain - native Promises only, so one macrotask flushes it regardless of chain depth. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("replacement coalescing across the state and status lanes (FIX B)", () => {
  const runtimes: EpicReplicaRuntime[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });

  it("the state lane and the status lane both reporting the SAME authority epoch produce exactly ONE replica-generation bump", () => {
    const rig = buildCoalescingRig();
    runtimes.push(rig.runtime);
    rig.runtime.start();

    // Establish epoch-1 on both lanes; the first snapshot on each lane never
    // requests a replacement.
    rig.status.deliverSnapshot(statusSnapshotFrameAt("epoch-1", null));
    rig.state.deliverSnapshot(stateSnapshotFrameAt("epoch-1", "cold", 1));
    const before = rig.runtime.replicaGeneration();

    // ONE authority transition, reported by BOTH lanes. The status lane's
    // own epoch fold fires first and requests the replacement; its own
    // emits (control-snapshot-complete, permission-changed, ...) are the
    // "accompanying frame" that used to clear the OLD reason-keyed guard
    // (`noteInboundFrameApplied`, which ran on every inbound frame applied).
    // The state lane then reports the very same epoch change and must be
    // coalesced against the transition TOKEN, not re-cleared by the status
    // lane's own emit landing first.
    rig.status.deliverSnapshot(statusSnapshotFrameAt("epoch-2", null));
    rig.state.deliverSnapshot(
      stateSnapshotFrameAt("epoch-2", "authorityEpochChanged", 2),
    );

    // Exactly one rebuild for the one true occurrence. Under the old guard
    // this read `before + 2`: the status lane's own accompanying snapshot
    // cleared its reason-keyed latch microseconds after requesting, so the
    // state lane's report of the SAME epoch change fired a second,
    // guard-erasing `resetAllPlanes`.
    expect(rig.runtime.replicaGeneration()).toBe(before + 1);
  });

  it("two reports naming DIFFERENT reasons for the same epoch still collapse to ONE rebuild", () => {
    const rig = buildCoalescingRig();
    runtimes.push(rig.runtime);
    rig.runtime.start();

    // epoch-1, with a migration RUNNING - the fact that makes the status
    // lane call the upcoming epoch change "migration-completed" rather than
    // a bare "authority-epoch-changed".
    rig.status.deliverSnapshot(
      statusSnapshotFrameAt("epoch-1", { state: "running", progress: null }),
    );
    rig.state.deliverSnapshot(stateSnapshotFrameAt("epoch-1", "cold", 1));
    const before = rig.runtime.replicaGeneration();

    // The status lane names this transition "migration-completed" (a
    // migration was in flight under the previous epoch); the state lane,
    // which has no memory of the migration, always calls the same
    // transition "authority-epoch-changed". Both build
    // `authorityEpochTransition("epoch-2")`, and it is the TOKEN the
    // runtime coalesces on - a reason-keyed guard could never recognise
    // these two strings as one occurrence at all.
    rig.status.deliverSnapshot(statusSnapshotFrameAt("epoch-2", null));
    rig.state.deliverSnapshot(
      stateSnapshotFrameAt("epoch-2", "authorityEpochChanged", 2),
    );

    expect(rig.runtime.replicaGeneration()).toBe(before + 1);
  });

  it("a LATER, genuinely different epoch still rebuilds - the anti-latch control", () => {
    const rig = buildCoalescingRig();
    runtimes.push(rig.runtime);
    rig.runtime.start();

    rig.status.deliverSnapshot(statusSnapshotFrameAt("epoch-1", null));
    rig.state.deliverSnapshot(stateSnapshotFrameAt("epoch-1", "cold", 1));
    const before = rig.runtime.replicaGeneration();

    // epoch-1 -> epoch-2, reported by both lanes and coalesced to one bump.
    rig.status.deliverSnapshot(statusSnapshotFrameAt("epoch-2", null));
    rig.state.deliverSnapshot(
      stateSnapshotFrameAt("epoch-2", "authorityEpochChanged", 2),
    );
    expect(rig.runtime.replicaGeneration()).toBe(before + 1);

    // epoch-2 -> epoch-3: a SECOND, genuinely different transition. Without
    // this control a guard that simply never released (a latch, rather than
    // a coalescer) would also read as "exactly one bump" on the tests
    // above - it would just never bump again for the rest of the session.
    rig.status.deliverSnapshot(statusSnapshotFrameAt("epoch-3", null));
    rig.state.deliverSnapshot(
      stateSnapshotFrameAt("epoch-3", "authorityEpochChanged", 3),
    );

    expect(rig.runtime.replicaGeneration()).toBe(before + 2);
  });
});

describe("resume-too-old replacement scope (FIX C)", () => {
  const runtimes: EpicReplicaRuntime[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
  });

  it("does not clear the write gate and does not bump the generation, unlike an authority-epoch-changed replacement", async () => {
    const rig = buildCoalescingRig();
    runtimes.push(rig.runtime);
    rig.runtime.start();

    // Transport BEFORE the snapshots - opening after would wipe the
    // freshness the status snapshot is about to establish (see
    // `lane-arm-open-cycle.test.ts`'s `openLaneRig` for the same rule).
    rig.status.open();
    rig.state.open();
    // The status lane's snapshot is what adopts the role and opens the
    // write gate on the lane arm; the state lane's own snapshot never
    // touches control facts at all (FIX D's own point).
    rig.status.deliverSnapshot(statusSnapshotFrameAt("epoch-1", null));
    rig.state.deliverSnapshot(stateSnapshotFrameAt("epoch-1", "cold", 1));

    // The write gate is open: a command enqueued now is delivered.
    expect(
      rig.runtime.enqueueWriteCommand({
        kind: "update-epic-title",
        title: "before any replacement",
        updatedAt: 1000,
      }),
    ).not.toBeNull();
    await flushMicrotasks();
    expect(rig.sentCommandCount()).toBe(1);

    const before = rig.runtime.replicaGeneration();

    // A resume-too-old reply on the STATE lane, under the SAME authority
    // epoch: the offered cursor could no longer be served, which
    // `resetStateRecordsOnly` treats as a records-plane-only fact and never
    // reaches `control.beginFreshCycle()`. Driven through the state lane
    // ALONE (never touching the status lane again) so nothing here can be
    // explained by the status lane's own accompanying snapshot.
    rig.state.deliverSnapshot(
      stateSnapshotFrameAt("epoch-1", "resumeTooOld", 2),
    );

    // Neither half of a full replacement happened.
    expect(rig.runtime.replicaGeneration()).toBe(before);
    expect(
      rig.runtime.enqueueWriteCommand({
        kind: "update-epic-title",
        title: "after resume-too-old",
        updatedAt: 2000,
      }),
    ).not.toBeNull();
    await flushMicrotasks();
    // Still delivered: the control snapshot/role this cycle already adopted
    // were never touched.
    expect(rig.sentCommandCount()).toBe(2);

    // Contrast, driven the SAME way (through the state lane alone): a
    // genuine authority-epoch-changed replacement DOES both. This is the
    // point of pairing the two cases in one test.
    rig.state.deliverSnapshot(
      stateSnapshotFrameAt("epoch-2", "authorityEpochChanged", 3),
    );

    expect(rig.runtime.replicaGeneration()).toBe(before + 1);
    rig.runtime.enqueueWriteCommand({
      kind: "update-epic-title",
      title: "after an authority-epoch-changed replacement",
      updatedAt: 3000,
    });
    await flushMicrotasks();
    // The write gate is shut: `beginFreshCycle` reset this cycle's
    // freshness and the transport leg, and nothing has re-established
    // either for the new epoch, so this command never reaches the host.
    expect(rig.sentCommandCount()).toBe(2);
  });
});
