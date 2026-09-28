import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { DesktopPresenceOnExit } from "@traycer/protocol/config/desktop-presence";
import {
  serializeHostLifecyclePolicy,
  type HostLifecycleMode,
} from "@traycer/protocol/config/host-lifecycle-policy";
import {
  formatDarwinProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle/process-start-identity";
import { SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1 } from "@traycer/protocol/config/supervisor-record";
import {
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
} from "@traycer-clients/shared/host-lock/process-identity";
import type {
  HostLifecycleSetResult,
  HostLifecycleStopChoice,
  HostLifecycleView,
  LocalHostCapability,
} from "../../../ipc-contracts/host-lifecycle-types";
import type {
  ConvergeReadyOk,
  ConvergeReadyVersionPolicy,
  GuardedMutationOutcome,
  LocalHostMutationIntent,
  MutationOutcome,
  ServiceDefinitionRefreshOk,
  StopHostOutcome,
  StopHostRequest,
} from "../host-controller-types";
import type { AutomaticIntentHold } from "../host-controller";
import { HostLifecyclePolicyStore } from "../host-lifecycle-policy";
import {
  HostLifecycleService,
  presenceVerdictForMode,
  type HostLifecycleRecordWatch,
  type HostLifecycleTransitionsController,
} from "../host-lifecycle-transitions";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

import { log } from "../../app/logger";

const OWN_PID = 4242;
const POLL_MS = 3_600_000;

function requireIdentity(
  value: ProcessStartIdentity | null,
): ProcessStartIdentity {
  if (value === null) throw new Error("test fixture: identity was null");
  return value;
}

const OWN_IDENTITY = requireIdentity(
  formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
);

interface ConvergeCall {
  readonly force: boolean;
  readonly intent: LocalHostMutationIntent;
  readonly versionPolicy: ConvergeReadyVersionPolicy;
}

class FakeController implements HostLifecycleTransitionsController {
  readonly converges: ConvergeCall[] = [];
  readonly stops: StopHostRequest[] = [];
  quiesceCount = 0;
  holdCount = 0;
  releaseCount = 0;
  stopOutcome: StopHostOutcome = { kind: "stopped", forced: false };
  onStop: () => Promise<void> = () => Promise.resolve();

  /** Open `holdAutomaticIntents` holds right now (hold +1, release -1). */
  openHolds = 0;
  /** `openHolds` as it stood at the moment of each `convergeReady` call. */
  readonly convergeOpenHolds: number[] = [];
  /** `openHolds` as it stood at the moment of each `stopHost` call. */
  readonly holdsAtStop: number[] = [];

  /** `refreshServiceDefinition` calls, in the order made. */
  readonly refreshCalls: number[] = [];
  refreshOutcome: MutationOutcome<ServiceDefinitionRefreshOk> = {
    kind: "ok",
    value: { result: "current", appliesAt: null },
  };
  refreshRejection: Error | null = null;
  refreshNeverSettles = false;
  /** Hook for order assertions against another spied-on call. */
  onRefreshCall: () => void = () => undefined;

  /** Every barrier passed to `deferMutationsUntil`, in call order. */
  readonly deferredBarriers: Promise<unknown>[] = [];

  deferMutationsUntil(barrier: Promise<unknown>): void {
    this.deferredBarriers.push(barrier);
  }

  /**
   * `applyStaged("launch", false)` is the launch reconcile's step
   * (`host apply --respect-hold`, a no-op when nothing is staged), called
   * once when a `"foreground"` run is followed by anything else while the
   * lanes are active.
   */
  applyStaged = vi.fn(async () => ({
    kind: "ok" as const,
    value: { appliedVersion: "x", runningActivated: true, applied: true },
  }));

  convergeReady(
    force: boolean,
    intent: LocalHostMutationIntent,
    versionPolicy: ConvergeReadyVersionPolicy,
  ): Promise<GuardedMutationOutcome<ConvergeReadyOk>> {
    this.converges.push({ force, intent, versionPolicy });
    this.convergeOpenHolds.push(this.openHolds);
    return Promise.resolve({
      kind: "ok",
      value: { running: true, version: null },
    });
  }

  async stopHost(request: StopHostRequest): Promise<StopHostOutcome> {
    this.stops.push(request);
    this.holdsAtStop.push(this.openHolds);
    await this.onStop();
    return this.stopOutcome;
  }

  refreshServiceDefinition(): Promise<
    MutationOutcome<ServiceDefinitionRefreshOk>
  > {
    this.refreshCalls.push(this.refreshCalls.length + 1);
    this.onRefreshCall();
    if (this.refreshNeverSettles) {
      return new Promise(() => undefined);
    }
    if (this.refreshRejection !== null) {
      return Promise.reject(this.refreshRejection);
    }
    return Promise.resolve(this.refreshOutcome);
  }

  quiesce(): void {
    this.quiesceCount += 1;
  }

  holdAutomaticIntents(): AutomaticIntentHold {
    this.holdCount += 1;
    this.openHolds += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseCount += 1;
        this.openHolds -= 1;
      },
    };
  }

  totalCalls(): number {
    return (
      this.converges.length +
      this.stops.length +
      this.quiesceCount +
      this.holdCount
    );
  }
}

class FakeRecords implements HostLifecycleRecordWatch {
  private readonly listeners = new Set<() => void>();
  watchCount = 0;

  watchLifecycleRecords(): Promise<void> {
    this.watchCount += 1;
    return Promise.resolve();
  }

  onLifecycleRecordsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  fire(): void {
    for (const listener of [...this.listeners]) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

interface Harness {
  readonly service: HostLifecycleService;
  readonly store: HostLifecyclePolicyStore;
  readonly controller: FakeController;
  readonly records: FakeRecords;
  readonly views: HostLifecycleView[];
}

let root: string;
let hostHome: string;
let pidFile: string;
let created: HostLifecycleService[];

function makeHarnessWithIdentity(
  capability: LocalHostCapability,
  pollIntervalMs: number,
  readOwnStartIdentity: () => Promise<ProcessStartIdentity | null>,
): Harness {
  const store = new HostLifecyclePolicyStore({
    hostHomeDir: hostHome,
    pidMetadataFile: pidFile,
    ownPid: OWN_PID,
    readOwnStartIdentity,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
  });
  const controller = new FakeController();
  const records = new FakeRecords();
  const service = new HostLifecycleService({
    store,
    controller,
    records,
    localHostCapability: capability,
    pollIntervalMs,
  });
  created.push(service);
  const views: HostLifecycleView[] = [];
  service.onChange((view) => {
    views.push(view);
  });
  return { service, store, controller, records, views };
}

function makeHarness(
  capability: LocalHostCapability,
  pollIntervalMs: number,
): Harness {
  return makeHarnessWithIdentity(capability, pollIntervalMs, () =>
    Promise.resolve(OWN_IDENTITY),
  );
}

async function writeCliPolicy(
  store: HostLifecyclePolicyStore,
  rev: number,
  mode: HostLifecycleMode,
): Promise<void> {
  await mkdir(hostHome, { recursive: true });
  await writeFile(
    store.policyPath,
    serializeHostLifecyclePolicy({
      v: 1,
      rev,
      mode,
      updatedAt: "2026-09-24T09:00:00.000Z",
      updatedBy: "cli",
    }),
    "utf8",
  );
}

async function writePidJson(): Promise<void> {
  await mkdir(hostHome, { recursive: true });
  await writeFile(
    pidFile,
    JSON.stringify({
      hostId: "host-1",
      websocketUrl: "ws://127.0.0.1:1234",
      version: "1.0.0",
      pid: 1234,
    }),
    "utf8",
  );
}

async function presenceVerdict(
  store: HostLifecyclePolicyStore,
): Promise<DesktopPresenceOnExit | null> {
  const presence = await store.readPresence();
  return presence === null ? null : presence.onExit;
}

/** A real-time pause that lets already-queued fire-and-forget work run. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
}

function reasonOf(result: HostLifecycleSetResult): string | null {
  return result.kind === "stop-refused" || result.kind === "failed"
    ? result.reason
    : null;
}

function messageOf(result: HostLifecycleSetResult): string | null {
  return result.kind === "stop-refused" || result.kind === "failed"
    ? result.message
    : null;
}

async function runNone(
  harness: Harness,
  stop: HostLifecycleStopChoice | null,
): Promise<HostLifecycleSetResult> {
  return harness.service.setMode({ mode: "none", stop });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "host-lifecycle-transitions-"));
  hostHome = join(root, "host-home");
  pidFile = join(hostHome, "pid.json");
  created = [];
});

afterEach(async () => {
  for (const service of created) service.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("presenceVerdictForMode", () => {
  it("is stop for linked and keep for every other mode", () => {
    expect(presenceVerdictForMode("linked")).toBe("stop");
    const others: readonly HostLifecycleMode[] = [
      "background",
      "ask",
      "stop-if-idle",
      "none",
    ];
    for (const mode of others) {
      expect(presenceVerdictForMode(mode)).toBe("keep");
    }
  });
});

describe("writeLaunchPresence", () => {
  const cases: readonly (readonly [
    HostLifecycleMode,
    DesktopPresenceOnExit,
  ])[] = [
    ["background", "keep"],
    ["ask", "keep"],
    ["stop-if-idle", "keep"],
    ["linked", "stop"],
  ];

  for (const [mode, verdict] of cases) {
    it(`publishes ${verdict} for ${mode}, stamped with the policy rev`, async () => {
      const harness = makeHarness("managed", POLL_MS);
      await writeCliPolicy(harness.store, 3, mode);
      await harness.service.writeLaunchPresence();
      const presence = await harness.store.readPresence();
      expect(presence?.onExit).toBe(verdict);
      expect(presence?.policyRev).toBe(3);
      expect(presence?.pid).toBe(OWN_PID);
    });
  }

  it("publishes keep at rev 0 when no policy file exists", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("keep");
    expect(presence?.policyRev).toBe(0);
  });

  it("writes no presence file at all with the none capability", async () => {
    const harness = makeHarness("none", POLL_MS);
    await writeCliPolicy(harness.store, 3, "linked");
    await harness.service.writeLaunchPresence();
    expect(await harness.store.readPresence()).toBeNull();
  });
});

describe("setMode: modes other than none", () => {
  it("any -> background writes the policy and publishes keep", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 2, "linked");
    await harness.service.writeLaunchPresence();
    expect(await presenceVerdict(harness.store)).toBe("stop");

    const result = await harness.service.setMode({
      mode: "background",
      stop: null,
    });
    expect(result.kind).toBe("applied");
    const read = await harness.store.readPolicy();
    expect(read.mode).toBe("background");
    expect(read.rev).toBe(3);
    expect(read.policy?.updatedBy).toBe("desktop");
    expect(await presenceVerdict(harness.store)).toBe("keep");
    expect((await harness.store.readPresence())?.policyRev).toBe(3);
    expect(harness.controller.totalCalls()).toBe(0);
  });

  const keepModes: readonly HostLifecycleMode[] = ["ask", "stop-if-idle"];
  for (const mode of keepModes) {
    it(`any -> ${mode} writes the policy and publishes keep`, async () => {
      const harness = makeHarness("managed", POLL_MS);
      await writeCliPolicy(harness.store, 2, "linked");
      await harness.service.writeLaunchPresence();
      const result = await harness.service.setMode({ mode, stop: null });
      expect(result.kind).toBe("applied");
      expect((await harness.store.readPolicy()).mode).toBe(mode);
      expect(await presenceVerdict(harness.store)).toBe("keep");
      expect(harness.controller.totalCalls()).toBe(0);
    });
  }

  it("any -> linked with the host down publishes stop and converges once", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    const result = await harness.service.setMode({
      mode: "linked",
      stop: null,
    });
    expect(result.kind).toBe("applied");
    const read = await harness.store.readPolicy();
    expect(read.mode).toBe("linked");
    expect(read.policy?.updatedBy).toBe("desktop");
    expect(await presenceVerdict(harness.store)).toBe("stop");
    await vi.waitFor(() => {
      expect(harness.controller.converges.length).toBe(1);
    });
    expect(harness.controller.converges[0]).toEqual({
      force: false,
      intent: { kind: "background" },
      versionPolicy: "keep-installed",
    });
    expect(harness.controller.stops.length).toBe(0);
    expect(harness.controller.quiesceCount).toBe(0);
  });

  it("any -> linked over an old supervisor reports restart-host and does not converge", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writePidJson();
    await harness.service.writeLaunchPresence();
    const result = await harness.service.setMode({
      mode: "linked",
      stop: null,
    });
    expect(result.kind).toBe("applied");
    expect(result.view.pending).toBe("restart-host");
    expect(await presenceVerdict(harness.store)).toBe("stop");
    await settle();
    expect(harness.controller.converges.length).toBe(0);
  });

  it("writes nothing when the file already has the requested mode", async () => {
    const harness = makeHarness("managed", POLL_MS);
    const result = await harness.service.setMode({
      mode: "background",
      stop: null,
    });
    expect(result.kind).toBe("applied");
    expect((await harness.store.readPolicy()).policy).toBeNull();
    expect((await harness.store.readPolicy()).rev).toBe(0);

    // Positive control: a different mode does write.
    await harness.service.setMode({ mode: "ask", stop: null });
    expect((await harness.store.readPolicy()).rev).toBe(1);
  });
});

describe("setMode: -> none while the lanes run", () => {
  async function activeHarness(): Promise<Harness> {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "ask");
    await harness.service.writeLaunchPresence();
    return harness;
  }

  it("refuses without a confirmed stop and touches nothing", async () => {
    const harness = await activeHarness();
    const result = await runNone(harness, null);
    expect(result.kind).toBe("failed");
    expect(reasonOf(result)).toBe("confirmation-required");
    expect(harness.controller.stops.length).toBe(0);
    expect(harness.controller.holdCount).toBe(0);
    expect(harness.controller.quiesceCount).toBe(0);
    expect((await harness.store.readPolicy()).mode).toBe("ask");
    expect(await presenceVerdict(harness.store)).toBe("keep");
  });

  const stopChoices: readonly HostLifecycleStopChoice[] = ["if-idle", "force"];
  for (const choice of stopChoices) {
    it(`commits after a ${choice} stop: policy, presence, quiesce, hold released`, async () => {
      const harness = await activeHarness();
      harness.controller.stopOutcome = {
        kind: "stopped",
        forced: choice === "force",
      };
      const result = await runNone(harness, choice);
      expect(result.kind).toBe("applied");
      expect(harness.controller.stops).toEqual([
        { mode: choice, spawn: "attached", withdrawal: null },
      ]);
      const read = await harness.store.readPolicy();
      expect(read.mode).toBe("none");
      expect(read.rev).toBe(5);
      expect(read.policy?.updatedBy).toBe("desktop");
      expect(await harness.store.readPresence()).toBeNull();
      expect(harness.controller.quiesceCount).toBe(1);
      expect(harness.controller.holdCount).toBe(1);
      expect(harness.controller.releaseCount).toBe(1);
      // The hold taken before the stop is still open AT the stop call -
      // the automatic intents (health monitor, ensure port) cannot bring the
      // host back while the stop, and the commit behind it, are in flight.
      expect(harness.controller.holdsAtStop).toEqual([1]);
      // This process booted with the lanes on and the renderer still runs
      // them: `none` applies at the next launch.
      expect(result.view.pending).toBe("restart-app");
      expect(result.view.applied.localHostCapability).toBe("managed");
    });
  }

  // A stop that succeeds but whose commit's policy write then throws
  // must not have quiesced the automatic intents, and must leave the hold
  // released and the live presence (still naming this process) in place -
  // the write is the commitment, and it did not happen.
  it("a policy write that fails after a successful stop commits nothing and releases the hold", async () => {
    const harness = await activeHarness();
    const realWritePolicy = harness.store.writePolicy.bind(harness.store);
    vi.spyOn(harness.store, "writePolicy").mockImplementation(async (mode) => {
      if (mode === "none") {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return realWritePolicy(mode);
    });
    const result = await runNone(harness, "if-idle");
    expect(result.kind).toBe("failed");
    expect(reasonOf(result)).toBe("write-failed");
    expect(harness.controller.quiesceCount).toBe(0);
    expect(await harness.store.readPresence()).not.toBeNull();
    expect(harness.controller.releaseCount).toBe(1);
    expect((await harness.store.readPolicy()).mode).not.toBe("none");
  });

  const refusals: readonly (readonly [StopHostOutcome, string])[] = [
    [{ kind: "host-busy", message: "work in progress" }, "host-busy"],
    [{ kind: "lock-busy", message: "another process" }, "lock-busy"],
    [{ kind: "update-active", message: "update running" }, "update-active"],
  ];
  for (const [outcome, reason] of refusals) {
    it(`a ${reason} stop is refused and commits nothing`, async () => {
      const harness = await activeHarness();
      harness.controller.stopOutcome = outcome;
      const result = await runNone(harness, "if-idle");
      expect(result.kind).toBe("stop-refused");
      expect(reasonOf(result)).toBe(reason);
      expect((await harness.store.readPolicy()).mode).toBe("ask");
      expect((await harness.store.readPolicy()).rev).toBe(4);
      expect(await presenceVerdict(harness.store)).toBe("keep");
      expect(harness.controller.quiesceCount).toBe(0);
      expect(harness.controller.holdCount).toBe(1);
      expect(harness.controller.releaseCount).toBe(1);
    });
  }

  const failures: readonly StopHostOutcome[] = [
    { kind: "failed", message: "cli exploded" },
    { kind: "withdrawn" },
  ];
  for (const outcome of failures) {
    it(`a ${outcome.kind} stop fails with stop-failed and commits nothing`, async () => {
      const harness = await activeHarness();
      harness.controller.stopOutcome = outcome;
      const result = await runNone(harness, "force");
      expect(result.kind).toBe("failed");
      expect(reasonOf(result)).toBe("stop-failed");
      expect((await harness.store.readPolicy()).mode).toBe("ask");
      expect((await harness.store.readPolicy()).rev).toBe(4);
      expect(await presenceVerdict(harness.store)).toBe("keep");
      expect(harness.controller.quiesceCount).toBe(0);
      expect(harness.controller.releaseCount).toBe(1);
    });
  }

  it("is superseded when a newer non-none policy appears during the stop", async () => {
    const harness = await activeHarness();
    harness.controller.onStop = () =>
      writeCliPolicy(harness.store, 5, "linked");
    const result = await runNone(harness, "if-idle");
    expect(result.kind).toBe("superseded");
    const read = await harness.store.readPolicy();
    expect(read.mode).toBe("linked");
    expect(read.rev).toBe(5);
    expect(read.policy?.updatedBy).toBe("cli");
    expect(await presenceVerdict(harness.store)).toBe("keep");
    expect(harness.controller.quiesceCount).toBe(0);
    expect(harness.controller.releaseCount).toBe(1);
  });

  it("applies without a second write when the newer policy is also none", async () => {
    const harness = await activeHarness();
    harness.controller.onStop = () => writeCliPolicy(harness.store, 5, "none");
    const result = await runNone(harness, "if-idle");
    expect(result.kind).toBe("applied");
    const read = await harness.store.readPolicy();
    expect(read.mode).toBe("none");
    expect(read.rev).toBe(5);
    expect(read.policy?.updatedBy).toBe("cli");
    expect(await harness.store.readPresence()).toBeNull();
    expect(harness.controller.quiesceCount).toBe(1);
    expect(harness.controller.releaseCount).toBe(1);
  });

  it("still takes the stop path when the file already says none", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 3, "none");
    await harness.service.writeLaunchPresence();
    const refused = await runNone(harness, null);
    expect(reasonOf(refused)).toBe("confirmation-required");
    expect(harness.controller.stops.length).toBe(0);

    const applied = await runNone(harness, "if-idle");
    expect(applied.kind).toBe("applied");
    expect(harness.controller.stops.length).toBe(1);
    expect(harness.controller.quiesceCount).toBe(1);
    expect(await harness.store.readPresence()).toBeNull();
    // Already none on disk: the choice is recorded, so nothing is rewritten.
    const read = await harness.store.readPolicy();
    expect(read.rev).toBe(3);
    expect(read.policy?.updatedBy).toBe("cli");
    expect(applied.view.pending).toBe("restart-app");
  });
});

describe("setMode: none -> any", () => {
  it("with the none capability writes the policy only", async () => {
    const harness = makeHarness("none", POLL_MS);
    await writeCliPolicy(harness.store, 2, "none");
    const result = await harness.service.setMode({
      mode: "linked",
      stop: null,
    });
    expect(result.kind).toBe("applied");
    const read = await harness.store.readPolicy();
    expect(read.mode).toBe("linked");
    expect(read.rev).toBe(3);
    expect(read.policy?.updatedBy).toBe("desktop");
    expect(await harness.store.readPresence()).toBeNull();
    await settle();
    expect(harness.controller.totalCalls()).toBe(0);
    expect(result.view.pending).toBe("restart-app");
  });

  it("after none committed this session writes the policy only", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    const committed = await runNone(harness, "force");
    expect(committed.kind).toBe("applied");
    expect(harness.controller.stops.length).toBe(1);
    expect(harness.controller.quiesceCount).toBe(1);
    expect(harness.controller.holdCount).toBe(1);

    const result = await harness.service.setMode({
      mode: "linked",
      stop: null,
    });
    expect(result.kind).toBe("applied");
    const read = await harness.store.readPolicy();
    expect(read.mode).toBe("linked");
    expect(read.policy?.updatedBy).toBe("desktop");
    expect(await harness.store.readPresence()).toBeNull();
    await settle();
    expect(harness.controller.converges.length).toBe(0);
    expect(harness.controller.stops.length).toBe(1);
    expect(harness.controller.quiesceCount).toBe(1);
    expect(harness.controller.holdCount).toBe(1);
    expect(result.view.pending).toBe("restart-app");
  });

  it("writes nothing when the file already has the requested mode", async () => {
    const harness = makeHarness("none", POLL_MS);
    await writeCliPolicy(harness.store, 2, "none");
    const result = await harness.service.setMode({ mode: "none", stop: null });
    expect(result.kind).toBe("applied");
    expect((await harness.store.readPolicy()).rev).toBe(2);
    expect(harness.controller.totalCalls()).toBe(0);
  });
});

describe("CLI observation", () => {
  it("an external policy write rewrites the presence, emits a view and stops nothing", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    harness.service.startObserving();
    await vi.waitFor(() => {
      expect(harness.views.length).toBeGreaterThan(0);
    });
    expect(await presenceVerdict(harness.store)).toBe("keep");
    const viewsBefore = harness.views.length;

    await writeCliPolicy(harness.store, 1, "linked");
    harness.records.fire();
    await vi.waitFor(() => {
      expect(harness.views.at(-1)?.desired.rev).toBe(1);
    });
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("stop");
    expect(presence?.policyRev).toBe(1);
    expect(harness.views.length).toBeGreaterThan(viewsBefore);
    expect(harness.views.at(-1)?.desired.mode).toBe("linked");
    expect(harness.views.at(-1)?.desired.updatedBy).toBe("cli");
    expect(harness.controller.totalCalls()).toBe(0);
  });

  it("a CLI-written none while the lanes run keeps the host and reports restart-app", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    harness.service.startObserving();
    await writeCliPolicy(harness.store, 1, "none");
    harness.records.fire();
    await vi.waitFor(() => {
      expect(harness.views.at(-1)?.desired.rev).toBe(1);
    });
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("keep");
    expect(presence?.policyRev).toBe(1);
    expect(harness.views.at(-1)?.pending).toBe("restart-app");
    expect(harness.controller.totalCalls()).toBe(0);
  });

  it("the poll backstop observes a change with no watcher edge and re-installs the watch", async () => {
    const harness = makeHarness("managed", 15);
    await harness.service.writeLaunchPresence();
    harness.service.startObserving();
    await writeCliPolicy(harness.store, 1, "linked");
    await vi.waitFor(() => {
      expect(harness.views.at(-1)?.desired.rev).toBe(1);
    });
    expect(await presenceVerdict(harness.store)).toBe("stop");
    await vi.waitFor(() => {
      expect(harness.records.watchCount).toBeGreaterThan(1);
    });
    expect(harness.controller.totalCalls()).toBe(0);
  });

  it("dispose stops observing: a later change is neither followed nor emitted", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    harness.service.startObserving();
    expect(harness.records.listenerCount()).toBe(1);
    harness.service.dispose();
    expect(harness.records.listenerCount()).toBe(0);

    const viewsBefore = harness.views.length;
    await writeCliPolicy(harness.store, 1, "linked");
    harness.records.fire();
    await settle();
    expect(await presenceVerdict(harness.store)).toBe("keep");
    expect(harness.views.length).toBe(viewsBefore);
  });
});

describe("quit verdicts", () => {
  it("handoff is published and survives a later CLI change until released", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    expect(await harness.service.writeQuitVerdict("handoff")).toBe("written");
    expect(await presenceVerdict(harness.store)).toBe("handoff");

    harness.service.startObserving();
    await writeCliPolicy(harness.store, 1, "linked");
    harness.records.fire();
    await vi.waitFor(() => {
      expect(harness.views.at(-1)?.desired.rev).toBe(1);
    });
    const held = await harness.store.readPresence();
    expect(held?.onExit).toBe("handoff");
    expect(held?.policyRev).toBe(0);

    await harness.service.releaseQuitVerdict();
    const released = await harness.store.readPresence();
    expect(released?.onExit).toBe("stop");
    expect(released?.policyRev).toBe(1);
  });

  it("a mode change while a verdict is held does not overwrite it", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    await harness.service.writeQuitVerdict("stop");
    const result = await harness.service.setMode({ mode: "ask", stop: null });
    expect(result.kind).toBe("applied");
    expect((await harness.store.readPolicy()).mode).toBe("ask");
    expect(await presenceVerdict(harness.store)).toBe("stop");

    await harness.service.releaseQuitVerdict();
    expect(await presenceVerdict(harness.store)).toBe("keep");
  });

  it("releasing with no held verdict changes nothing", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    const before = await harness.store.readPresence();
    await harness.service.releaseQuitVerdict();
    expect(await harness.store.readPresence()).toEqual(before);
  });

  // `setMode({mode:"linked"})` and `writeQuitVerdict("keep")` fired
  // concurrently must not race - `writeQuitVerdict` is serialized behind the
  // in-flight mode change, so its write can only ever be the LAST one to
  // land, whatever `setMode`'s own writePresence call is doing. Gate the
  // `"stop"` write (setMode's) so it stays pending while `writeQuitVerdict`
  // is submitted, then release it and check the calls landed in program
  // order, not by relative speed.
  it("writeQuitVerdict fired alongside setMode(linked) is serialized behind it and wins", async () => {
    const harness = makeHarness("managed", POLL_MS);
    const callOrder: DesktopPresenceOnExit[] = [];
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const realWritePresence = harness.store.writePresence.bind(harness.store);
    vi.spyOn(harness.store, "writePresence").mockImplementation(
      async (onExit, rev) => {
        callOrder.push(onExit);
        if (onExit === "stop") await gate;
        return realWritePresence(onExit, rev);
      },
    );

    const linked = harness.service.setMode({ mode: "linked", stop: null });
    const quit = harness.service.writeQuitVerdict("keep");
    // Give any code that is NOT properly serialized a window to race ahead
    // while the "stop" write is still gated.
    await settle();
    releaseGate();
    await Promise.all([linked, quit]);

    expect(callOrder).toEqual(["stop", "keep"]);
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("keep");
  });

  it("reports no-local-host and writes nothing when the lanes are off", async () => {
    const harness = makeHarness("none", POLL_MS);
    expect(await harness.service.writeQuitVerdict("handoff")).toBe(
      "no-local-host",
    );
    expect(await harness.store.readPresence()).toBeNull();
  });
});

describe("readQuitPolicy / localHostLanesActive", () => {
  it("reads the file's mode fresh while the lanes run, CLI writes included", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 3, "stop-if-idle");
    expect(harness.service.localHostLanesActive()).toBe(true);
    expect(await harness.service.readQuitPolicy()).toEqual({
      mode: "stop-if-idle",
      rev: 3,
    });

    // The CLI co-writes the policy: the next read sees it without an observe tick.
    await writeCliPolicy(harness.store, 4, "linked");
    expect(await harness.service.readQuitPolicy()).toEqual({
      mode: "linked",
      rev: 4,
    });
  });

  it("is none when the app booted in none, whatever the file says", async () => {
    const harness = makeHarness("none", POLL_MS);
    await writeCliPolicy(harness.store, 2, "linked");
    expect(harness.service.localHostLanesActive()).toBe(false);
    expect((await harness.service.readQuitPolicy()).mode).toBe("none");
  });

  it("is none after none was committed this session, even if the file is rewritten", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "ask");
    await harness.service.writeLaunchPresence();
    expect((await harness.service.readQuitPolicy()).mode).toBe("ask");

    const result = await runNone(harness, "if-idle");
    expect(result.kind).toBe("applied");
    expect(harness.service.localHostLanesActive()).toBe(false);
    expect((await harness.service.readQuitPolicy()).mode).toBe("none");

    await writeCliPolicy(harness.store, 9, "linked");
    expect((await harness.service.readQuitPolicy()).mode).toBe("none");
  });

  it("reports a CLI-written none as none while the lanes still run", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 5, "none");
    expect(harness.service.localHostLanesActive()).toBe(true);
    expect(await harness.service.readQuitPolicy()).toEqual({
      mode: "none",
      rev: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// `refreshDefinitionAfterWrite` - the fire-and-forget `host service
// refresh` call `applySetMode`/`commitNone` make after a policy write that
// parks (`refreshOnModeChange`: previous !== next && next !== "background").
// Mechanism, not just end state - call counts, and order against
// `writePolicy`.
// ---------------------------------------------------------------------------
describe("refreshDefinitionAfterWrite", () => {
  it("background -> ask calls refreshServiceDefinition exactly once, only after writePolicy resolves", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    const order: string[] = [];
    const realWritePolicy = harness.store.writePolicy.bind(harness.store);
    vi.spyOn(harness.store, "writePolicy").mockImplementation(
      async (mode: HostLifecycleMode) => {
        const written = await realWritePolicy(mode);
        order.push("writePolicy");
        return written;
      },
    );
    harness.controller.onRefreshCall = () => {
      order.push("refreshServiceDefinition");
    };

    const result = await harness.service.setMode({ mode: "ask", stop: null });

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
    expect(order).toEqual(["writePolicy", "refreshServiceDefinition"]);
  });

  it("ask -> ask (unchanged) makes zero refreshServiceDefinition calls", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 2, "ask");
    await harness.service.writeLaunchPresence();

    const result = await harness.service.setMode({ mode: "ask", stop: null });

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(0);
  });

  it("ask -> background makes zero refreshServiceDefinition calls (background parks nothing)", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 2, "ask");
    await harness.service.writeLaunchPresence();

    const result = await harness.service.setMode({
      mode: "background",
      stop: null,
    });

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(0);
  });

  it("linked -> stop-if-idle calls refreshServiceDefinition exactly once (positive control for the ask zero-call cases above)", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 2, "linked");
    await harness.service.writeLaunchPresence();

    const result = await harness.service.setMode({
      mode: "stop-if-idle",
      stop: null,
    });

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
  });

  it("stays applied when the refresh outcome is non-ok, and warns with mode+reason only", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    harness.controller.refreshOutcome = {
      kind: "failed",
      message: "refresh failed",
    };

    const result = await harness.service.setMode({ mode: "ask", stop: null });

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
    await vi.waitFor(() => {
      expect(vi.mocked(log.warn)).toHaveBeenCalled();
    });
    const call = vi.mocked(log.warn).mock.calls.at(-1);
    expect(call?.[0]).toBe(
      "[host-lifecycle] service definition refresh failed",
    );
    const payload = call?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ mode: "ask", reason: "failed" });
    expect(Object.keys(payload).sort()).toEqual(["mode", "reason"]);
  });

  it('stays applied when the refresh promise rejects, and warns with reason "threw"', async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    harness.controller.refreshRejection = new Error("cli exploded");

    const result = await harness.service.setMode({ mode: "ask", stop: null });

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
    await vi.waitFor(() => {
      expect(vi.mocked(log.warn)).toHaveBeenCalled();
    });
    const call = vi.mocked(log.warn).mock.calls.at(-1);
    expect(call?.[0]).toBe(
      "[host-lifecycle] service definition refresh failed",
    );
    const payload = call?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ mode: "ask", reason: "threw" });
    expect(Object.keys(payload).sort()).toEqual(["mode", "reason"]);
  });

  // A real-time race against a fixed 250 ms timer can pass vacuously
  // under load (the timer, not the code, decides the winner). `vi.waitFor`
  // instead polls the actual fact - the setMode promise settled - so the test
  // is red only when `applySetMode` genuinely blocks on the never-settling
  // refresh, whatever the machine's load is.
  it("applySetMode resolves even when the refresh promise never settles", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();
    harness.controller.refreshNeverSettles = true;

    let settled = false;
    const setModePromise = harness.service
      .setMode({ mode: "ask", stop: null })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });
    const result = await setModePromise;
    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
  });

  it("still runs on the !lanesActive early-return path (booted with the none capability)", async () => {
    const harness = makeHarness("none", POLL_MS);
    await harness.service.writeLaunchPresence();

    const result = await harness.service.setMode({ mode: "ask", stop: null });

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
  });

  it("commitNone calls refreshServiceDefinition once when the prior mode was background", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();

    const result = await runNone(harness, "if-idle");

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
  });

  it("commitNone calls refreshServiceDefinition once when the prior mode was linked", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "linked");
    await harness.service.writeLaunchPresence();

    const result = await runNone(harness, "if-idle");

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(1);
  });

  it("commitNone makes zero refreshServiceDefinition calls when the policy is already none", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 3, "none");
    await harness.service.writeLaunchPresence();

    const result = await runNone(harness, "if-idle");

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(0);
  });

  it("commitNone makes zero refreshServiceDefinition calls when a CLI none write races the stop (positive controls above establish the mechanism fires)", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "ask");
    await harness.service.writeLaunchPresence();
    harness.controller.onStop = () => writeCliPolicy(harness.store, 5, "none");

    const result = await runNone(harness, "if-idle");

    expect(result.kind).toBe("applied");
    expect(harness.controller.refreshCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A presence that never landed - a timed-out identity probe at
// launch, or a failed write - is retried by `observe()` on every later tick
// instead of being lost for the process's whole life. Mechanism, not just end
// state: call counts on `store.writePresence` and the attempt-numbered log
// lines `notePresenceFailure` produces.
//
// A short poll interval (real timers, like the existing "poll backstop"
// test above) drives the ticks; `identitySequence` controls exactly which
// call to `readOwnStartIdentity` fails and which succeeds.
// ---------------------------------------------------------------------------
describe("presence retry", () => {
  /** Answers `answers[call]`, repeating the last entry once exhausted. */
  function identitySequence(
    answers: readonly (ProcessStartIdentity | null)[],
  ): () => Promise<ProcessStartIdentity | null> {
    let call = 0;
    return () => {
      const index = Math.min(call, answers.length - 1);
      call += 1;
      return Promise.resolve(answers[index] ?? null);
    };
  }

  /** Wait for one more observation tick to complete, via a fired watcher edge. */
  async function fireOneTick(
    harness: Harness,
    writeSpy: MockInstance<HostLifecyclePolicyStore["writePresence"]>,
    expectedCalls: number,
  ): Promise<void> {
    harness.records.fire();
    await vi.waitFor(() => {
      expect(writeSpy).toHaveBeenCalledTimes(expectedCalls);
    });
  }

  it("a launch presence that failed identity is retried on the next tick and lands with an attempts count", async () => {
    const harness = makeHarnessWithIdentity(
      "managed",
      POLL_MS,
      identitySequence([null, OWN_IDENTITY]),
    );
    const writeSpy = vi.spyOn(harness.store, "writePresence");
    await writeCliPolicy(harness.store, 2, "ask");

    await harness.service.writeLaunchPresence();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await harness.store.readPresence()).toBeNull();

    const infoCallsBefore = vi.mocked(log.info).mock.calls.length;
    harness.service.startObserving();
    await fireOneTick(harness, writeSpy, 2);
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("keep");
    expect(presence?.policyRev).toBe(2);
    const infoCalls = vi.mocked(log.info).mock.calls.slice(infoCallsBefore);
    expect(infoCalls).toContainEqual([
      "[host-lifecycle] presence written after retry",
      { onExit: "keep", rev: 2, attempts: 2 },
    ]);

    // The write already landed: a further tick does not call it again.
    harness.records.fire();
    await settle();
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  it("repeated tick failures warn once for the streak, then log DEBUG for the rest", async () => {
    const harness = makeHarnessWithIdentity("managed", POLL_MS, () =>
      Promise.resolve(null),
    );
    const writeSpy = vi.spyOn(harness.store, "writePresence");
    await writeCliPolicy(harness.store, 1, "ask");

    const warnCallsBefore = vi.mocked(log.warn).mock.calls.length;
    const debugCallsBefore = vi.mocked(log.debug).mock.calls.length;
    harness.service.startObserving();
    await vi.waitFor(() => {
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });
    await fireOneTick(harness, writeSpy, 2);
    await fireOneTick(harness, writeSpy, 3);

    const warnCalls = vi
      .mocked(log.warn)
      .mock.calls.slice(warnCallsBefore)
      .filter(
        ([message]) => message === "[host-lifecycle] presence not written",
      );
    const debugCalls = vi
      .mocked(log.debug)
      .mock.calls.slice(debugCallsBefore)
      .filter(
        ([message]) => message === "[host-lifecycle] presence not written",
      );
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]?.[1]).toMatchObject({ attempt: 1 });
    expect(debugCalls.length).toBe(2);
    expect(
      debugCalls.map(([, fields]) => (fields as { attempt: number }).attempt),
    ).toEqual([2, 3]);
  });

  it("a quit verdict held through a failed identity probe is what the retry publishes, not the mode's verdict", async () => {
    const harness = makeHarnessWithIdentity(
      "managed",
      POLL_MS,
      identitySequence([null, OWN_IDENTITY]),
    );
    // "ask"'s presence verdict is "keep" - the retry must publish the held
    // "stop" quit verdict instead.
    await writeCliPolicy(harness.store, 1, "ask");

    expect(await harness.service.writeQuitVerdict("stop")).toBe(
      "identity-unavailable",
    );
    expect(await harness.store.readPresence()).toBeNull();

    const writeSpy = vi.spyOn(harness.store, "writePresence");
    harness.service.startObserving();
    await fireOneTick(harness, writeSpy, 1);
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("stop");
  });

  it("booted with the none capability, observation ticks never call writePresence", async () => {
    const harness = makeHarnessWithIdentity("none", POLL_MS, () =>
      Promise.resolve(null),
    );
    const writeSpy = vi.spyOn(harness.store, "writePresence");
    harness.service.startObserving();
    harness.records.fire();
    harness.records.fire();
    await settle();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("after none is committed this session, observation ticks never call writePresence", async () => {
    const harness = makeHarnessWithIdentity("managed", POLL_MS, () =>
      Promise.resolve(OWN_IDENTITY),
    );
    await harness.service.writeLaunchPresence();
    const committed = await runNone(harness, "force");
    expect(committed.kind).toBe("applied");

    const writeSpy = vi.spyOn(harness.store, "writePresence");
    harness.service.startObserving();
    harness.records.fire();
    harness.records.fire();
    await settle();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("a thrown write (write-failed) at launch is also retried on the next tick", async () => {
    const harness = makeHarnessWithIdentity("managed", POLL_MS, () =>
      Promise.resolve(OWN_IDENTITY),
    );
    await writeCliPolicy(harness.store, 3, "ask");
    const realWritePresence = harness.store.writePresence.bind(harness.store);
    const writeSpy = vi
      .spyOn(harness.store, "writePresence")
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      });

    const warnCallsBefore = vi.mocked(log.warn).mock.calls.length;
    await harness.service.writeLaunchPresence();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await harness.store.readPresence()).toBeNull();
    const warnCalls = vi.mocked(log.warn).mock.calls.slice(warnCallsBefore);
    expect(warnCalls).toContainEqual([
      "[host-lifecycle] presence write failed",
      expect.objectContaining({ reason: "write-failed", attempt: 1 }),
    ]);

    writeSpy.mockImplementation(realWritePresence);
    harness.service.startObserving();
    await fireOneTick(harness, writeSpy, 2);
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("keep");
    expect(presence?.policyRev).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// `observe()`'s change-detection keys on `rev` alone
// (`read.rev !== this.presenceRev`). An external write that lands at the
// SAME rev this desktop already published under - a different mode, at an
// equal rev, from a co-writer racing the same bump - is invisible to that
// check, so the stale presence verdict is never corrected.
// ---------------------------------------------------------------------------
describe("change detection keys on (rev, mode), not rev", () => {
  it("an equal-rev CLI write with a different mode republishes the presence", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "ask");
    await harness.service.writeLaunchPresence();
    await harness.service.setMode({ mode: "background", stop: null });
    expect((await harness.store.readPolicy()).rev).toBe(5);
    expect(await presenceVerdict(harness.store)).toBe("keep");
    expect((await harness.store.readPresence())?.policyRev).toBe(5);

    const writeSpy = vi.spyOn(harness.store, "writePresence");
    // Equal rev, different mode: the CLI and this desktop's own write raced
    // onto the same rev number.
    await writeCliPolicy(harness.store, 5, "linked");
    harness.service.startObserving();
    harness.records.fire();

    await vi.waitFor(() => {
      expect(writeSpy).toHaveBeenCalledWith("stop", 5);
    });
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("stop");
    expect(presence?.policyRev).toBe(5);
  });

  it("GREEN control: an unequal-rev CLI write (rev 6, linked) also republishes stop", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "ask");
    await harness.service.writeLaunchPresence();
    await harness.service.setMode({ mode: "background", stop: null });
    expect((await harness.store.readPolicy()).rev).toBe(5);

    await writeCliPolicy(harness.store, 6, "linked");
    harness.service.startObserving();
    harness.records.fire();

    await vi.waitFor(() => {
      expect(harness.views.at(-1)?.desired.rev).toBe(6);
    });
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("stop");
    expect(presence?.policyRev).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// A quit verdict's presence write that failed (a transient EPERM/rename
// failure) must be retried by the NEXT observation, exactly like a launch
// presence or a mode-change presence is (see the presence-retry tests above). Today `observe()`'s retry
// branch (`presenceRev === null`) only fires when NOTHING has ever landed,
// and its "external write" branch is gated on `quitVerdict === null` - so a
// verdict write that fails while a PRIOR write already set `presenceRev`
// (the common case: launch presence lands, then a quit verdict's write
// fails) hits neither branch and is silently never retried.
// ---------------------------------------------------------------------------
describe("a quit verdict whose write failed is retried", () => {
  it("a failed quit-verdict write is retried by the next observation", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await harness.service.writeLaunchPresence();

    const writeSpy = vi.spyOn(harness.store, "writePresence");
    writeSpy.mockRejectedValueOnce(
      Object.assign(new Error("rename failed"), { code: "EPERM" }),
    );
    expect(await harness.service.writeQuitVerdict("stop")).toBe("write-failed");

    harness.service.startObserving();
    harness.records.fire();

    await vi.waitFor(() => {
      expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(writeSpy.mock.calls[1]?.[0]).toBe("stop");
    const presence = await harness.store.readPresence();
    expect(presence?.onExit).toBe("stop");
  });

  it("a failed release is retried back to the mode's verdict", async () => {
    const harness = makeHarness("managed", POLL_MS);
    expect(await harness.service.writeQuitVerdict("stop")).toBe("written");

    const writeSpy = vi.spyOn(harness.store, "writePresence");
    writeSpy.mockRejectedValueOnce(
      Object.assign(new Error("rename failed"), { code: "EPERM" }),
    );
    await harness.service.releaseQuitVerdict();

    harness.service.startObserving();
    harness.records.fire();

    await vi.waitFor(async () => {
      expect((await harness.store.readPresence())?.onExit).toBe("keep");
    });
  });

  it("GREEN control: with no injected failure, writeQuitVerdict lands and a later fire makes no extra writePresence call", async () => {
    const harness = makeHarness("managed", POLL_MS);
    expect(await harness.service.writeQuitVerdict("stop")).toBe("written");

    const writeSpy = vi.spyOn(harness.store, "writePresence");
    const callsBefore = writeSpy.mock.calls.length;
    harness.service.startObserving();
    harness.records.fire();
    await settle();
    expect(writeSpy.mock.calls.length).toBe(callsBefore);
    expect((await harness.store.readPresence())?.onExit).toBe("stop");
  });
});

// ---------------------------------------------------------------------------
// Every job the service runs - `setMode`, `writeQuitVerdict`,
// `releaseQuitVerdict`, an observation tick - goes through the SAME strict
// FIFO `serialize()` chain, so a `→ none` commit's `stopHost` await (which
// can run for as long as the host takes to drain) blocks every quit-path
// call submitted after it starts, even though none of them touch the host
// the stop is acting on. The quit path must not wait behind it.
// ---------------------------------------------------------------------------
describe("quit-path calls do not wait behind an in-flight none stop", () => {
  function sleep(ms: number): Promise<"blocked"> {
    return new Promise((resolve) => {
      setTimeout(() => resolve("blocked"), ms);
    });
  }

  function makeGate(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  } {
    let resolveFn: () => void = () => undefined;
    const promise = new Promise<void>((res) => {
      resolveFn = res;
    });
    return { promise, resolve: resolveFn };
  }

  async function startNoneStop(harness: Harness): Promise<{
    readonly none: Promise<HostLifecycleSetResult>;
    readonly resolveGate: () => void;
  }> {
    const gate = makeGate();
    harness.controller.onStop = () => gate.promise;
    await writeCliPolicy(harness.store, 4, "ask");
    await harness.service.writeLaunchPresence();
    const none = harness.service.setMode({ mode: "none", stop: "if-idle" });
    await vi.waitFor(() => {
      expect(harness.controller.stops.length).toBe(1);
    });
    return { none, resolveGate: gate.resolve };
  }

  it("writeQuitVerdict resolves while a none stop is still running", async () => {
    const harness = makeHarness("managed", POLL_MS);
    const { none, resolveGate } = await startNoneStop(harness);

    const raced = await Promise.race([
      harness.service.writeQuitVerdict("stop"),
      sleep(1000),
    ]);
    expect(raced).toBe("written");
    expect(await presenceVerdict(harness.store)).toBe("stop");

    resolveGate();
    const noneResult = await none;
    expect(noneResult.kind).toBe("applied");
    expect((await harness.store.readPolicy()).mode).toBe("none");
    expect(await harness.store.readPresence()).toBeNull();
    expect(harness.controller.quiesceCount).toBe(1);
  });

  it("releaseQuitVerdict and an observation also resolve during the stop", async () => {
    const harness = makeHarness("managed", POLL_MS);
    const { none, resolveGate } = await startNoneStop(harness);

    await Promise.race([harness.service.writeQuitVerdict("stop"), sleep(1000)]);

    const releaseRaced = await Promise.race([
      harness.service.releaseQuitVerdict().then(() => "released" as const),
      sleep(1000),
    ]);
    expect(releaseRaced).toBe("released");

    harness.service.startObserving();
    const viewsBefore = harness.views.length;
    const observedRaced = await Promise.race([
      new Promise<"observed">((resolve) => {
        const unsubscribe = harness.service.onChange(() => {
          unsubscribe();
          resolve("observed");
        });
        harness.records.fire();
      }),
      sleep(1000),
    ]);
    expect(observedRaced).toBe("observed");
    expect(harness.views.length).toBeGreaterThan(viewsBefore);

    resolveGate();
    await none;
  });

  it("a mode chosen during the none stop supersedes it, and linked converges once the hold is released", async () => {
    const harness = makeHarness("managed", POLL_MS);
    const { none, resolveGate } = await startNoneStop(harness);

    const linkedRaced = await Promise.race([
      harness.service
        .setMode({ mode: "linked", stop: null })
        .then((result) => result.kind),
      sleep(1000),
    ]);
    expect(linkedRaced).toBe("applied");

    resolveGate();
    const noneResult = await none;
    expect(noneResult.kind).toBe("superseded");
    expect(harness.controller.quiesceCount).toBe(0);
    expect((await harness.store.readPolicy()).mode).toBe("linked");

    await vi.waitFor(() => {
      expect(
        harness.controller.convergeOpenHolds.some((count) => count === 0),
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// (Desktop side) `convergeIfDown` only brings a down host back when
// `readSupervisorState()` says `not-running`. Once that read also verifies
// the recorded supervisor's liveness/identity, a `supervisor.json` left
// behind by a dead or recycled-pid supervisor must read as stale (so the
// converge fires) rather than `enforcing` (which suppresses it, per the
// existing `any -> linked over an old supervisor` test's baseline).
// ---------------------------------------------------------------------------
describe("a stale supervisor.json does not suppress the linked converge", () => {
  const RECORDED_PID = 777_001;
  const RECORDED_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
  );
  const OBSERVED_DIFFERENT_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Mon Jul 7 09:00:00 2026"),
  );

  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(null);
    __setAsyncProcessStartIdentityReaderForTest(null);
  });

  async function writeRawSupervisor(
    store: HostLifecyclePolicyStore,
    pid: number,
    startIdentity: ProcessStartIdentity | null,
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    const record: Record<string, unknown> = {
      v: 1,
      pid,
      cliVersion: "1.0.0",
      capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
      startedAt: "2026-09-24T09:00:00.000Z",
    };
    if (startIdentity !== null) record.startIdentity = startIdentity;
    await writeFile(store.supervisorPath, JSON.stringify(record), "utf8");
  }

  it("dead recorded pid: the record is stale and linked converges", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisor(harness.store, RECORDED_PID, null);
    __setAsyncProcessLivenessReaderForTest((pid) =>
      Promise.resolve(pid === RECORDED_PID ? "dead" : "alive"),
    );

    const result = await harness.service.setMode({
      mode: "linked",
      stop: null,
    });
    expect(result.kind).toBe("applied");

    await vi.waitFor(() => {
      expect(harness.controller.converges.length).toBe(1);
    });
    const view = await harness.service.getView();
    expect(view.applied.supervisor).toBe("not-running");
  });

  it("alive pid with a different start identity: stale, linked converges", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisor(harness.store, RECORDED_PID, RECORDED_IDENTITY);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(OBSERVED_DIFFERENT_IDENTITY),
    );

    const result = await harness.service.setMode({
      mode: "linked",
      stop: null,
    });
    expect(result.kind).toBe("applied");

    await vi.waitFor(() => {
      expect(harness.controller.converges.length).toBe(1);
    });
    const view = await harness.service.getView();
    expect(view.applied.supervisor).toBe("not-running");
  });

  it("GREEN control: alive pid with the same identity is enforcing, no converge", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisor(harness.store, RECORDED_PID, RECORDED_IDENTITY);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(RECORDED_IDENTITY),
    );

    await harness.service.setMode({ mode: "linked", stop: null });
    await settle();
    expect(harness.controller.converges.length).toBe(0);
    const view = await harness.service.getView();
    expect(view.applied.supervisor).toBe("enforcing");
  });

  it("GREEN control: legacy record, alive pid is enforcing", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisor(harness.store, RECORDED_PID, null);
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));

    await harness.service.setMode({ mode: "linked", stop: null });
    await settle();
    expect(harness.controller.converges.length).toBe(0);
    const view = await harness.service.getView();
    expect(view.applied.supervisor).toBe("enforcing");
  });

  it("GREEN control: indeterminate liveness is enforcing", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisor(harness.store, RECORDED_PID, null);
    __setAsyncProcessLivenessReaderForTest(() =>
      Promise.resolve("indeterminate"),
    );

    await harness.service.setMode({ mode: "linked", stop: null });
    await settle();
    expect(harness.controller.converges.length).toBe(0);
    const view = await harness.service.getView();
    expect(view.applied.supervisor).toBe("enforcing");
  });
});

// ---------------------------------------------------------------------------
// (Lifecycle side) "the desktop leaves a host that a person started in a
// terminal untouched; the mode governs the service run only." A live,
// capable, identity-matching supervisor record now also carries `admittedAs`
// ("service" for a labelled/unattended start, "foreground" for a person's own
// terminal). `getView().applied.admittedAs` surfaces it, and a foreground run
// under an ENFORCED mode (linked/ask/stop-if-idle) reports `restart-host`
// even though the record itself reads `enforcing` - the mode is not
// considered satisfied by a run this desktop did not start under service
// control. `background` and a `"service"` record are unaffected.
// ---------------------------------------------------------------------------
describe("getView surfaces admittedAs, and a foreground run pends a restart under an enforced mode", () => {
  const RECORDED_PID = 777_002;
  const RECORDED_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
  );

  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(null);
    __setAsyncProcessStartIdentityReaderForTest(null);
  });

  async function writeRawSupervisorRun(
    store: HostLifecyclePolicyStore,
    pid: number,
    admittedAs: "service" | "foreground" | null,
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    const record: Record<string, unknown> = {
      v: 1,
      pid,
      cliVersion: "1.0.0",
      capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
      startedAt: "2026-09-24T09:00:00.000Z",
      startIdentity: RECORDED_IDENTITY,
    };
    if (admittedAs !== null) record.admittedAs = admittedAs;
    await writeFile(store.supervisorPath, JSON.stringify(record), "utf8");
  }

  function stubLiveIdentityMatch(): void {
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(RECORDED_IDENTITY),
    );
  }

  it("a live foreground record's view reports admittedAs 'foreground'", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    const view = await harness.service.getView();
    expect(view.applied.admittedAs).toBe("foreground");
  });

  it("a legacy record's view reports admittedAs null", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisorRun(harness.store, RECORDED_PID, null);
    stubLiveIdentityMatch();

    const view = await harness.service.getView();
    expect(view.applied.admittedAs).toBeNull();
  });

  it("no host's view reports admittedAs null", async () => {
    const harness = makeHarness("managed", POLL_MS);

    const view = await harness.service.getView();
    expect(view.applied.admittedAs).toBeNull();
  });

  const enforcedModes: readonly HostLifecycleMode[] = [
    "linked",
    "ask",
    "stop-if-idle",
  ];

  it.each(enforcedModes)(
    "a live foreground record under %s pends restart-host",
    async (mode) => {
      const harness = makeHarness("managed", POLL_MS);
      await writeCliPolicy(harness.store, 4, mode);
      await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
      stubLiveIdentityMatch();

      const view = await harness.service.getView();
      expect(view.pending).toBe("restart-host");
    },
  );

  it("a live foreground record under background pends none", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "background");
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    const view = await harness.service.getView();
    expect(view.pending).toBe("none");
  });

  it("a live service record under linked pends none", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "linked");
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "service");
    stubLiveIdentityMatch();

    const view = await harness.service.getView();
    expect(view.pending).toBe("none");
  });

  it("readRunAdmission() freshly reads the live foreground record", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    expect(await harness.service.readRunAdmission()).toBe("foreground");
  });

  it("currentRunAdmission() is null before any view is derived, and reflects the last derived view after", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    expect(harness.service.currentRunAdmission()).toBeNull();
    await harness.service.getView();
    expect(harness.service.currentRunAdmission()).toBe("foreground");
  });

  it("an observation pushes a view carrying the live foreground record's admittedAs", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    harness.service.startObserving();
    const before = harness.views.length;
    harness.records.fire();
    await vi.waitFor(() => {
      expect(harness.views.length).toBeGreaterThan(before);
    });
    expect(harness.views[harness.views.length - 1].applied.admittedAs).toBe(
      "foreground",
    );
  });
});

// ---------------------------------------------------------------------------
// The review's ruling: a `→ none` stop request against a host this desktop
// never started under service control reports `not-service-run`, not a
// failure - "the desktop leaves a host that a person started in a terminal
// untouched" means there is nothing for `host stop` to withdraw, but this
// desktop's OWN choice to no longer govern it must still commit. Before the
// fix, `not-service-run` fell into the same bucket as a genuine `failed` stop
// (see `stopNotCommitted`) and committed nothing.
// ---------------------------------------------------------------------------
describe("→ none commits on a not-service-run stop (the review's ruling)", () => {
  it("commits none when the stop reports not-service-run", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "ask");
    await harness.service.writeLaunchPresence();
    harness.controller.stopOutcome = {
      kind: "not-service-run",
      message: "the host is not running as a service",
    };
    const infoCallsBefore = vi.mocked(log.info).mock.calls.length;
    const warnCallsBefore = vi.mocked(log.warn).mock.calls.length;

    const result = await runNone(harness, "if-idle");

    expect(result.kind).toBe("applied");
    const read = await harness.store.readPolicy();
    expect(read.mode).toBe("none");
    expect(await harness.store.readPresence()).toBeNull();
    expect(harness.controller.quiesceCount).toBe(1);
    expect(harness.controller.openHolds).toBe(0);
    expect(harness.controller.releaseCount).toBe(1);
    // The terminal-host observability intent, carried onto the
    // committed path: the "none committed" INFO line names the reason a
    // person's terminal host was left untouched, and nothing here WARNs -
    // this was never a failure.
    const infoCalls = vi.mocked(log.info).mock.calls.slice(infoCallsBefore);
    const infoCall = infoCalls.find(
      ([message]) => message === "[host-lifecycle] none committed",
    );
    expect(infoCall?.[1]).toMatchObject({ reason: "not-service-run" });
    expect(vi.mocked(log.warn).mock.calls.length).toBe(warnCallsBefore);
  });
});

// ---------------------------------------------------------------------------
// The review's ruling: "the ensure ladder finishes the update once the terminal
// host is gone." `observe()` follows the live supervisor's `admittedAs` from
// one observation to the next; when a `"foreground"` run (a person's own
// terminal) is followed by anything else - the record removed, stale, or now
// `"service"` - while the lanes are active, it runs the launch reconcile's
// step (`controller.applyStaged("launch", false)`, `host apply
// --respect-hold`, a no-op when nothing is staged) once, so a staged update
// that was waiting behind the foreground run lands as soon as it ends.
// ---------------------------------------------------------------------------
describe("a terminal run ending applies a ready launch stage", () => {
  const RECORDED_PID = 777_003;
  const RECORDED_IDENTITY = requireIdentity(
    formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
  );

  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(null);
    __setAsyncProcessStartIdentityReaderForTest(null);
  });

  async function writeRawSupervisorRun(
    store: HostLifecyclePolicyStore,
    pid: number,
    admittedAs: "service" | "foreground",
  ): Promise<void> {
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      store.supervisorPath,
      JSON.stringify({
        v: 1,
        pid,
        cliVersion: "1.0.0",
        capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
        startedAt: "2026-09-24T09:00:00.000Z",
        startIdentity: RECORDED_IDENTITY,
        admittedAs,
      }),
      "utf8",
    );
  }

  function stubLiveIdentityMatch(): void {
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(RECORDED_IDENTITY),
    );
  }

  it("case 1: a foreground run ending while lanes are active calls applyStaged once", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "background");
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    harness.service.startObserving();
    await vi.waitFor(() => {
      expect(harness.views.length).toBeGreaterThan(0);
    });

    await rm(harness.store.supervisorPath, { force: true });
    harness.records.fire();

    await vi.waitFor(() => {
      expect(harness.controller.applyStaged).toHaveBeenCalledTimes(1);
    });
    expect(harness.controller.applyStaged).toHaveBeenCalledWith(
      "launch",
      false,
    );
  });

  it("case 2: a foreground record observed twice with no edge does not call applyStaged", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "background");
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    harness.service.startObserving();
    await vi.waitFor(() => {
      expect(harness.views.length).toBeGreaterThan(0);
    });

    harness.records.fire();
    await settle();

    expect(harness.controller.applyStaged).not.toHaveBeenCalled();
  });

  it("case 3: a service run ending does not call applyStaged (only a foreground run ending does)", async () => {
    const harness = makeHarness("managed", POLL_MS);
    await writeCliPolicy(harness.store, 4, "background");
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "service");
    stubLiveIdentityMatch();

    harness.service.startObserving();
    await vi.waitFor(() => {
      expect(harness.views.length).toBeGreaterThan(0);
    });

    await rm(harness.store.supervisorPath, { force: true });
    harness.records.fire();
    await settle();

    expect(harness.controller.applyStaged).not.toHaveBeenCalled();
  });

  it("case 4: lanes off never calls applyStaged even across a foreground-run edge", async () => {
    const harness = makeHarness("none", POLL_MS);
    await writeRawSupervisorRun(harness.store, RECORDED_PID, "foreground");
    stubLiveIdentityMatch();

    harness.service.startObserving();
    await settle();

    await rm(harness.store.supervisorPath, { force: true });
    harness.records.fire();
    await settle();

    expect(harness.controller.applyStaged).not.toHaveBeenCalled();
  });
});
