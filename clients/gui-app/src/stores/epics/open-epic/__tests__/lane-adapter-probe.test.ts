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

// ── Counting factories - trivial and honest, per the shared adapters' own
//    factory contracts ("(epicId, callbacks) => { close(): void }") ─────────

interface CountingStatusFactory {
  readonly factory: EpicStatusStreamClientFactory;
  openCount(): number;
  closeCount(): number;
}

function createCountingStatusFactory(): CountingStatusFactory {
  let opens = 0;
  let closes = 0;
  const factory: EpicStatusStreamClientFactory = (_epicId, _callbacks) => {
    opens += 1;
    return {
      close: () => {
        closes += 1;
      },
    };
  };
  return { factory, openCount: () => opens, closeCount: () => closes };
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
  readonly support: SupportController;
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
function buildRuntimeRig(): RuntimeRig {
  nextEpicSequence += 1;
  const legacy = createCountingLegacyFactory();
  const status = createCountingStatusFactory();
  const state = createCountingStateFactory();
  const support = createSupportController();
  const laneSelection: EpicLaneSelectionSources = {
    support: support.support,
    subscribeSupport: support.subscribeSupport,
    stateStreamClientFactory: state.factory,
    statusStreamClientFactory: status.factory,
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
  return { runtime, legacy, status, state, support };
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

  it("(a) the relay case: forever-unknown support opens the status probe alone, then adopts it once the lanes resolve", () => {
    const rig = buildRuntimeRig();
    runtimes.push(rig.runtime);

    // Support answers "unknown" for everything and never resolves on its
    // own - the remote-mux shape `epic-adapter-selection.ts` names as the
    // reason the probe is load-bearing rather than an optimisation.
    rig.runtime.start();

    // Exactly one status stream client was constructed (the probe), and ZERO
    // state clients - the records lane must not open before the arm is
    // settled.
    expect(rig.status.openCount()).toBe(1);
    expect(rig.state.openCount()).toBe(0);
    // The other half of "unknown is not a selection": no speculative fat
    // `epic.subscribe@1` stream either.
    expect(rig.legacy.openCount()).toBe(0);

    // The host resolves: all three lane methods answer "supported", and the
    // support reader notifies.
    markAllLaneMethodsSupported(rig.support);
    rig.support.notify();

    // The lanes are now fully attached: a state client was constructed...
    expect(rig.state.openCount()).toBe(1);
    // ...and the status client count is STILL exactly 1 - the probe's stream
    // was adopted, not replaced. A fix that opened a second status stream on
    // resolution would still look like it "worked" (the epic would render)
    // and must fail this assertion.
    expect(rig.status.openCount()).toBe(1);
    expect(rig.legacy.openCount()).toBe(0);
  });

  it("(b) forever-unknown then method-unsupported installs legacy and closes the probe's status stream", () => {
    const rig = buildRuntimeRig();
    runtimes.push(rig.runtime);

    rig.runtime.start();
    expect(rig.status.openCount()).toBe(1);
    expect(rig.legacy.openCount()).toBe(0);

    // One lane method comes back explicitly unsupported - the host has told
    // us it is an old host, which `readEpicAdapterVerdict` treats as
    // conclusive even with the other two methods still "unknown".
    rig.support.set("epic.state.subscribe", "unsupported");
    rig.support.notify();

    // The legacy adapter is now open.
    expect(rig.legacy.openCount()).toBe(1);
    // Status client construction count is 1 - one attempted open (the
    // probe), not zero and not two.
    expect(rig.status.openCount()).toBe(1);
    // The probe must not leak a socket once its question is answered.
    expect(rig.status.closeCount()).toBe(1);
    // The records lane was never attached on this connection.
    expect(rig.state.openCount()).toBe(0);
  });

  describe("(c) the already-resolved paths are unchanged", () => {
    it("support already SUPPORTED at start() attaches the lanes directly - legacy never opens", () => {
      const rig = buildRuntimeRig();
      runtimes.push(rig.runtime);
      markAllLaneMethodsSupported(rig.support);

      rig.runtime.start();

      expect(rig.state.openCount()).toBe(1);
      expect(rig.legacy.openCount()).toBe(0);
    });

    it("support already UNSUPPORTED at start() installs legacy directly - no status client is ever constructed", () => {
      const rig = buildRuntimeRig();
      runtimes.push(rig.runtime);
      rig.support.set("epic.state.subscribe", "unsupported");

      rig.runtime.start();

      expect(rig.legacy.openCount()).toBe(1);
      // Nothing to probe when the answer is already known at start().
      expect(rig.status.openCount()).toBe(0);
      expect(rig.state.openCount()).toBe(0);
    });
  });

  describe("(d) teardown with a probe outstanding does not leak", () => {
    it("dispose() closes the probe's status client", () => {
      const rig = buildRuntimeRig();
      runtimes.push(rig.runtime);

      rig.runtime.start();
      expect(rig.status.openCount()).toBe(1);
      expect(rig.status.closeCount()).toBe(0);

      rig.runtime.dispose();

      expect(rig.status.closeCount()).toBe(1);
    });

    it("detachTransport() closes the probe's status client", () => {
      const rig = buildRuntimeRig();
      runtimes.push(rig.runtime);

      rig.runtime.start();
      expect(rig.status.openCount()).toBe(1);
      expect(rig.status.closeCount()).toBe(0);

      rig.runtime.detachTransport();

      expect(rig.status.closeCount()).toBe(1);
    });
  });
});
