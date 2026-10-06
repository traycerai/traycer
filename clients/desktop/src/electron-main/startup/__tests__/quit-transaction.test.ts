import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPresenceOnExit } from "@traycer/protocol/config/desktop-presence";
import type { HostLifecycleMode } from "@traycer/protocol/config/host-lifecycle-policy";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleView,
} from "../../../ipc-contracts/host-lifecycle-types";
import type {
  HostQuitDecision,
  HostQuitDecisionResponse,
  HostQuitStateEvent,
} from "../../../ipc-contracts/host-quit-types";
import type { AutomaticIntentHold } from "../../host/host-controller";
import type {
  LifecycleAdmissionBlock,
  MutationKind,
  StopHostOutcome,
  StopHostRequest,
} from "../../host/host-controller-types";
import type { QuitVerdictWriteOutcome } from "../../host/host-lifecycle-transitions";
import type { HostActivityProbe } from "@traycer-clients/shared/host-client/host-activity-probe";
import type { HostQuitPrompt } from "../../ipc/runner-ipc-bridge";
import {
  QuitTransactions,
  type BeforeQuitVerdict,
  type QuitReason,
  type UpdateInstallQuitHooks,
} from "../quit-transaction";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

// The quit transaction (host-lifecycle-modes), driven through fakes for
// every dependency. Every claim is asserted over the ORDERED event log the
// fakes write (verdicts, stops, mode changes, published states, the ending),
// so a row cannot pass by reaching the right end state through the wrong
// steps.

const VIEW: HostLifecycleView = {
  desired: { mode: "ask", rev: 1, updatedBy: "desktop", updatedAt: null },
  applied: {
    localHostCapability: "managed",
    supervisor: "not-running",
    admittedAs: null,
  },
  pending: "none",
};

const IDLE_STOP: StopHostOutcome = { kind: "stopped", forced: false };
const FORCE_STOP: StopHostOutcome = { kind: "stopped", forced: true };
const BUSY: StopHostOutcome = {
  kind: "host-busy",
  message: "2 agents running",
};
// The running host is a terminal's
// `traycer host start`, not the service's - the service stop reached
// nothing, and the host still runs. Never a reason to escalate to --force
// (that host is the terminal's), never a reason to re-prompt (asking would
// only be refused again): it settles like `deadline`/`withdrawn` in
// stop-if-idle, and like any other non-busy outcome everywhere else.
const NOT_SERVICE_RUN: StopHostOutcome = {
  kind: "not-service-run",
  message:
    "host stop: the running host was started in a terminal (supervisor pid 4242) and is not run by the service; stop it there with Ctrl-C, or pass --force",
};

/** A scripted answer to one host quit prompt. */
type PromptScript =
  | { readonly via: "renderer"; readonly decision: HostQuitDecision }
  /** The renderer path rejects (no listening window); main asks natively. */
  | { readonly via: "native"; readonly decision: HostQuitDecision }
  /** The renderer is asked and never answers until the question is withdrawn. */
  | { readonly via: "pending" }
  /**
   * The renderer answers, but only after `delayMs` (a real `setTimeout`,
   * so it works under fake timers) - modeling a prompt that stays up for a
   * while before the person answers it.
   */
  | {
      readonly via: "renderer-after";
      readonly delayMs: number;
      readonly decision: HostQuitDecision;
    };

/**
 * A scripted stop: an outcome, a stop that runs until withdrawn, or (lane
 * mode only) one that, once ADMITTED onto the lane, hangs until the test
 * settles it via `resolveStop` (an admitted stop with a hanging child).
 */
type StopScript = StopHostOutcome | "hang" | "deferred" | "lane-hang";

/**
 * A scripted `GET /activity` read (stop-if-idle's first step): an answer, a
 * read that stays pending until the test settles it via `resolveProbe`, or a
 * dep that rejects (a bug the transaction must survive, as it resolves
 * `unreachable` by contract).
 */
type ProbeScript = HostActivityProbe | "deferred" | "reject";

/** The two lane job kinds the corner-case tests hold ahead of the quit. */
type LaneHeldJobKind = "install" | "stopHost";

interface Scenario {
  readonly mode: HostLifecycleMode;
  readonly installing: boolean;
  readonly gate: "proceed" | "stay-open";
  readonly stops: readonly StopScript[];
  readonly prompts: readonly PromptScript[];
  readonly deadlineMs: number;
  readonly revealDelayMs: number;
  /**
   * Model the ONE exclusive lane `setMode(linked)`'s
   * `refreshServiceDefinition` job and `stopHost`'s own job share
   * (`host-lifecycle-transitions.ts:422-449`, `host-controller.ts:3146`).
   * When true, `setMode` and `stopHost` are driven through a FIFO lane
   * instead of their default scripted behavior.
   */
  readonly lane: boolean;
  /**
   * A job of this kind occupies the lane's head BEFORE the quit
   * starts, running until the test calls `releaseLane()`. Models another
   * lane job (an "install", or a `stopHost` from an unrelated `→ none`
   * commit) that is already running when the quit's own stop is enqueued
   * behind it - so the quit's stop is merely QUEUED, never ADMITTED, until
   * released. `null` means no held job (the quit's own stop, if any, is
   * admitted immediately).
   */
  readonly laneHeld: LaneHeldJobKind | null;
  /**
   * Whether a local host is reachable right now. Not on
   * `QuitTransactionDeps` at head - vitest does not type-check fixtures,
   * and head's transaction never reads it, so it has no effect there.
   */
  readonly isLocalHostRunning: boolean;
  /**
   * The running local host was started in a terminal (supervisor
   * `admittedAs: foreground`), not the service. Not on `QuitTransactionDeps`
   * at head - vitest does not type-check fixtures, and head's transaction
   * never reads it, so it has no effect there.
   */
  readonly foregroundRun: boolean;
  /**
   * What the host's activity probe says. The default is an answer that
   * reports no terminal count - the honest default for every test that is not
   * about terminals in use: stop-if-idle takes the path it took before the
   * count existed.
   */
  readonly probe: ProbeScript;
}

const DEFAULT_SCENARIO: Scenario = {
  mode: "background",
  installing: false,
  gate: "proceed",
  stops: [],
  prompts: [],
  deadlineMs: 5_000,
  revealDelayMs: 1_000,
  lane: false,
  laneHeld: null,
  isLocalHostRunning: true,
  foregroundRun: false,
  probe: { kind: "answered", busy: false, terminalsInUse: null },
};

interface Rig {
  readonly events: string[];
  readonly txs: QuitTransactions;
  readonly stopRequests: StopHostRequest[];
  readonly prompts: HostQuitPrompt[];
  readonly states: HostQuitStateEvent[];
  readonly setModeRequests: HostLifecycleSetRequest[];
  readonly withdrawals: Error[];
  readonly indicator: boolean[];
  /** The indicator log as it stood when each authorize fired. */
  readonly indicatorAtAuthorize: boolean[][];
  readonly state: { mode: HostLifecycleMode; installing: boolean };
  readonly counts: {
    gate: number;
    readPolicy: number;
    authorize: number;
    authorizeNow: number;
    stayOpen: number;
    reveal: number;
  };
  hooks(): UpdateInstallQuitHooks;
  /** How many `stopHost` lane jobs actually spawned (not withdrawn). */
  laneSpawned(): number;
  /** Release the `laneHeld` job, letting whatever is queued behind it run. */
  releaseLane(): void;
  /** The fake's own `lifecycleAdmissionBlock`, for the test to assert directly. */
  admissionBlock(): LifecycleAdmissionBlock | null;
  /** Settle the oldest `deferred` or `lane-hang` stop. */
  resolveStop(outcome: StopHostOutcome): void;
  /** How many times the transaction read the host's activity probe. */
  probeCalls(): number;
  /** Settle the pending `deferred` activity probe. */
  resolveProbe(answer: HostActivityProbe): void;
  /** Resolve the next held-back verdict write. */
  releaseVerdictWrites(): void;
  holdVerdictWrites(): void;
  /** Resolve every pending update sequence promise. */
  settleUpdateSequence(): void;
}

function buildRig(scenario: Scenario): Rig {
  const events: string[] = [];
  const stopRequests: StopHostRequest[] = [];
  const prompts: HostQuitPrompt[] = [];
  const states: HostQuitStateEvent[] = [];
  const setModeRequests: HostLifecycleSetRequest[] = [];
  const withdrawals: Error[] = [];
  const state: Rig["state"] = {
    mode: scenario.mode,
    installing: scenario.installing,
  };
  const counts = {
    gate: 0,
    readPolicy: 0,
    authorize: 0,
    authorizeNow: 0,
    stayOpen: 0,
    reveal: 0,
  };
  const indicator: boolean[] = [];
  const indicatorAtAuthorize: boolean[][] = [];
  const stopScripts = [...scenario.stops];
  const promptScripts = [...scenario.prompts];
  let requestSeq = 0;
  let pendingReject: ((error: Error) => void) | null = null;
  let hooks: UpdateInstallQuitHooks | null = null;
  let verdictGate: Promise<void> | null = null;
  let openVerdictGate: () => void = () => undefined;
  const updateSequenceWaiters: Array<() => void> = [];
  const deferredStops: Array<(outcome: StopHostOutcome) => void> = [];
  let probeCallCount = 0;
  let settleProbe: ((answer: HostActivityProbe) => void) | null = null;

  // A minimal FIFO lane. `enqueue` runs `job` only once every
  // job enqueued before it has settled, mirroring the exclusive mutation
  // lane `setMode(linked)`'s refresh and `stopHost` share.
  //
  // Also tracks the RUNNING job's kind, set in the same synchronous
  // stretch as the job starts and cleared once it settles - mirroring
  // production's `mutationStatus` (host-controller.ts:1394, then :1410) -
  // and exposed to the controller fake as `lifecycleAdmissionBlock`.
  let laneTail: Promise<void> = Promise.resolve();
  let runningLaneKind: MutationKind | null = null;
  const enqueueOnLane = <T>(
    kind: MutationKind,
    job: () => Promise<T>,
  ): Promise<T> => {
    const run = laneTail.then(async () => {
      runningLaneKind = kind;
      try {
        return await job();
      } finally {
        runningLaneKind = null;
      }
    });
    laneTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  let laneSpawnedCount = 0;
  let releaseHeldLane: (() => void) | null = null;
  if (scenario.lane && scenario.laneHeld !== null) {
    const held = new Promise<void>((resolve) => {
      releaseHeldLane = resolve;
    });
    void enqueueOnLane(scenario.laneHeld, () => held);
  }
  const currentAdmissionBlock = (): LifecycleAdmissionBlock | null => {
    if (runningLaneKind === null) return null;
    return {
      kind: "mutation",
      lane: {
        kind: runningLaneKind,
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
  };

  const rig: Rig = {
    events,
    stopRequests,
    prompts,
    states,
    setModeRequests,
    withdrawals,
    indicator,
    indicatorAtAuthorize,
    state,
    counts,
    resolveStop: (outcome) => {
      const resolve = deferredStops.shift();
      if (resolve === undefined) throw new Error("no deferred stop");
      resolve(outcome);
    },
    probeCalls: () => probeCallCount,
    resolveProbe: (answer) => {
      if (settleProbe === null) throw new Error("no deferred probe");
      settleProbe(answer);
      settleProbe = null;
    },
    hooks: () => {
      if (hooks === null) throw new Error("update sequence not started");
      return hooks;
    },
    laneSpawned: () => laneSpawnedCount,
    releaseLane: () => {
      if (releaseHeldLane === null) throw new Error("no held lane job");
      releaseHeldLane();
      releaseHeldLane = null;
    },
    admissionBlock: () => currentAdmissionBlock(),
    holdVerdictWrites: () => {
      verdictGate = new Promise<void>((resolve) => {
        openVerdictGate = resolve;
      });
    },
    releaseVerdictWrites: () => {
      openVerdictGate();
      verdictGate = null;
    },
    settleUpdateSequence: () => {
      for (const resolve of updateSequenceWaiters.splice(0)) resolve();
    },
    txs: new QuitTransactions({
      isRelaunchIntended: () => state.installing,
      isLocalHostRunning: () => Promise.resolve(scenario.isLocalHostRunning),
      isForegroundHostRun: () => Promise.resolve(scenario.foregroundRun),
      probeHostActivity: (): Promise<HostActivityProbe> => {
        probeCallCount += 1;
        if (scenario.probe === "reject") {
          return Promise.reject(new Error("probe dep rejected"));
        }
        if (scenario.probe === "deferred") {
          return new Promise<HostActivityProbe>((resolve) => {
            settleProbe = resolve;
          });
        }
        return Promise.resolve(scenario.probe);
      },
      lifecycle: {
        readQuitPolicy: () => {
          counts.readPolicy += 1;
          events.push("readPolicy");
          return Promise.resolve({ mode: state.mode, rev: 1 });
        },
        writeQuitVerdict: async (
          onExit: DesktopPresenceOnExit,
        ): Promise<QuitVerdictWriteOutcome> => {
          if (verdictGate !== null) await verdictGate;
          events.push(`verdict:${onExit}`);
          return "written";
        },
        releaseQuitVerdict: () => {
          events.push("releaseVerdict");
          return Promise.resolve();
        },
        setMode: (request): Promise<HostLifecycleSetResult> => {
          setModeRequests.push(request);
          events.push(`setMode:${request.mode}:${String(request.stop)}`);
          if (scenario.lane && request.mode === "linked") {
            // Models host-lifecycle-transitions.ts:422-449: a mode write
            // that parks queues a 400ms refresh job on the exclusive lane,
            // fire-and-forget (setMode's own promise does not wait on it).
            void enqueueOnLane(
              "refreshService",
              () => new Promise<void>((resolve) => setTimeout(resolve, 400)),
            );
          }
          return Promise.resolve({ kind: "applied", view: VIEW });
        },
      },
      controller: {
        stopHost: (request) => {
          stopRequests.push(request);
          events.push(`stop:${request.mode}:${request.spawn}`);
          if (scenario.lane) {
            // Models host-controller.ts:3146: stopHost enqueues on the same
            // exclusive lane and checks withdrawal.aborted at the lane head.
            const laneScript = stopScripts.shift();
            return enqueueOnLane(
              "stopHost",
              async (): Promise<StopHostOutcome> => {
                if (request.withdrawal?.aborted === true) {
                  return { kind: "withdrawn" };
                }
                laneSpawnedCount += 1;
                if (laneScript === "lane-hang") {
                  // Admitted and running, with a hanging child - held
                  // until the test settles it via `resolveStop`.
                  return new Promise<StopHostOutcome>((resolve) => {
                    deferredStops.push((outcome) => {
                      events.push("stop:settled");
                      resolve(outcome);
                    });
                  });
                }
                return { kind: "stopped", forced: request.mode === "force" };
              },
            );
          }
          const script = stopScripts.shift();
          if (script === undefined) {
            throw new Error("test fixture: no scripted stop outcome");
          }
          if (script === "deferred") {
            return new Promise<StopHostOutcome>((resolve) => {
              // An admitted CLI child settling - `resolveStop` invokes
              // this, so "stop:settled" always precedes whatever the
              // outcome's own promise reaction does next.
              deferredStops.push((outcome) => {
                events.push("stop:settled");
                resolve(outcome);
              });
            });
          }
          if (script === "lane-hang") {
            throw new Error("test fixture: lane-hang requires scenario.lane");
          }
          if (script !== "hang") return Promise.resolve(script);
          // Like the real controller: a queued stop resolves `withdrawn` once
          // its signal aborts; never spawned.
          return new Promise<StopHostOutcome>((resolve) => {
            request.withdrawal?.addEventListener("abort", () => {
              resolve({ kind: "withdrawn" });
            });
          });
        },
        holdAutomaticIntents: (): AutomaticIntentHold => {
          events.push("hold");
          return {
            release: () => {
              events.push("holdRelease");
            },
          };
        },
        quiesce: () => {
          events.push("quiesce");
        },
        // Not on `QuitTransactionController` at head - vitest does
        // not type-check fixtures, and head's `remember()` never calls it.
        // The fix reads it to spawn a detached refresh once a stop is
        // remembered, instead of the parked-mode refresh queued on the lane.
        spawnServiceDefinitionRefresh: (): Promise<"spawned" | "failed"> => {
          events.push("refresh:detached");
          return Promise.resolve("spawned");
        },
        // Not on `QuitTransactionController` at head - vitest does not
        // type-check fixtures, and head's `join()` never reads it. The fix
        // reads it to tell an ADMITTED stop (the lane's running job is
        // `stopHost`) from one merely queued behind something else.
        get lifecycleAdmissionBlock(): LifecycleAdmissionBlock | null {
          return currentAdmissionBlock();
        },
      },
      requestDecision: (prompt) => {
        prompts.push(prompt);
        events.push(`prompt:${prompt.mode}:${prompt.round}`);
        const script = promptScripts.shift();
        if (script === undefined) {
          throw new Error("test fixture: no scripted prompt answer");
        }
        if (script.via === "native") {
          return Promise.reject(new Error("no renderer window"));
        }
        if (script.via === "pending") {
          return new Promise<HostQuitDecisionResponse>((_resolve, reject) => {
            pendingReject = reject;
          });
        }
        if (script.via === "renderer-after") {
          requestSeq += 1;
          const requestId = `req-${requestSeq}`;
          return new Promise<HostQuitDecisionResponse>((resolve) => {
            setTimeout(() => {
              resolve({ requestId, decision: script.decision });
            }, script.delayMs);
          });
        }
        requestSeq += 1;
        return Promise.resolve({
          requestId: `req-${requestSeq}`,
          decision: script.decision,
        });
      },
      withdrawDecision: (error) => {
        withdrawals.push(error);
        events.push("withdraw");
        pendingReject?.(error);
        pendingReject = null;
      },
      askNatively: (prompt) => {
        events.push(`native:${prompt.mode}:${prompt.round}`);
        // The promptScripts entry was consumed by requestDecision, which
        // rejected for a native script; its decision is looked up here.
        const answer = nativeAnswers.shift();
        if (answer === undefined) {
          throw new Error("test fixture: no scripted native answer");
        }
        return Promise.resolve(answer);
      },
      publishState: (event) => {
        states.push(event);
        events.push(
          event.phase === "stopping"
            ? `state:stopping:${String(event.requestId)}:idleOnly=${String(event.idleOnly)}`
            : `state:${event.phase}:${String(event.requestId)}`,
        );
      },
      unsyncedEditsGate: () => {
        counts.gate += 1;
        events.push("gate");
        return Promise.resolve(scenario.gate);
      },
      runUpdateInstallSequence: (received) => {
        hooks = received;
        events.push("updateSeq");
        return new Promise<void>((resolve) => {
          updateSequenceWaiters.push(resolve);
        });
      },
      authorizeQuitAfterFlush: () => {
        counts.authorize += 1;
        indicatorAtAuthorize.push([...indicator]);
        events.push("authorize");
      },
      authorizeQuitNow: () => {
        counts.authorizeNow += 1;
        events.push("authorizeNow");
      },
      stayOpen: () => {
        counts.stayOpen += 1;
        events.push("stayOpen");
      },
      revealStopping: () => {
        counts.reveal += 1;
        events.push("reveal");
      },
      setStoppingIndicator: (stopping) => {
        indicator.push(stopping);
      },
      revealDelayMs: scenario.revealDelayMs,
      deadlineMs: scenario.deadlineMs,
    }),
  };
  // Native answers ride the same script list: a `native` entry's decision.
  const nativeAnswers: HostQuitDecision[] = scenario.prompts.flatMap((entry) =>
    entry.via === "native" ? [entry.decision] : [],
  );
  return rig;
}

function scenario(overrides: Partial<Scenario>): Scenario {
  return { ...DEFAULT_SCENARIO, ...overrides };
}

/** Let every already-resolved promise chain run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function quit(rig: Rig): Promise<BeforeQuitVerdict> {
  const verdict = rig.txs.onBeforeQuit();
  await flush();
  return verdict;
}

const USER_START = ["gate", "hold", "readPolicy"];
const QUITTING_TAIL = ["quiesce", "holdRelease"];

afterEach(() => {
  vi.useRealTimers();
});

describe("user quit: background / none", () => {
  const modes: readonly HostLifecycleMode[] = ["background", "none"];
  for (const mode of modes) {
    it(`${mode}: no verdict, no stop, quiesce, authorize`, async () => {
      const rig = buildRig(scenario({ mode }));
      expect(await quit(rig)).toBe("prevent");
      expect(rig.events).toEqual([
        ...USER_START,
        ...QUITTING_TAIL,
        "state:quitting:null",
        "authorize",
      ]);
      expect(rig.stopRequests).toEqual([]);
      expect(rig.counts.stayOpen).toBe(0);
    });
  }
});

describe("user quit: linked", () => {
  it("if-idle stopped: verdict stop, one detached if-idle stop, authorize", async () => {
    const rig = buildRig(scenario({ mode: "linked", stops: [IDLE_STOP] }));
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      "verdict:stop",
      "state:stopping:null:idleOnly=false",
      "stop:if-idle:detached",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ]);
    expect(rig.prompts).toEqual([]);
  });

  it("if-idle host-busy then force stopped: the mode is the consent", async () => {
    const rig = buildRig(
      scenario({ mode: "linked", stops: [BUSY, FORCE_STOP] }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      "verdict:stop",
      "state:stopping:null:idleOnly=false",
      "stop:if-idle:detached",
      "stop:force:detached",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ]);
    expect(rig.prompts).toEqual([]);
  });

  const unhappy: ReadonlyArray<readonly [string, StopHostOutcome]> = [
    ["lock-busy", { kind: "lock-busy", message: "cli lock held" }],
    ["failed", { kind: "failed", message: "boom" }],
  ];
  for (const [label, outcome] of unhappy) {
    it(`${label}: verdict stop, no retry, authorize anyway`, async () => {
      const rig = buildRig(scenario({ mode: "linked", stops: [outcome] }));
      await quit(rig);
      expect(rig.events).toEqual([
        ...USER_START,
        "verdict:stop",
        "state:stopping:null:idleOnly=false",
        "stop:if-idle:detached",
        ...QUITTING_TAIL,
        "state:quitting:null",
        "authorize",
      ]);
      expect(rig.counts.stayOpen).toBe(0);
    });
  }

  // That host is the terminal's - the service stop reached nothing, so
  // the standing verdict corrects to `keep` once the stop settles, exactly
  // like the idle-only round's own verdict correction once the real outcome is known, never `stop`.
  it("not-service-run: verdict keep after the stop settles, no force escalation (that host is the terminal's), authorize anyway", async () => {
    const rig = buildRig(
      scenario({ mode: "linked", stops: [NOT_SERVICE_RUN] }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      "verdict:stop",
      "state:stopping:null:idleOnly=false",
      "stop:if-idle:detached",
      "verdict:keep",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ]);
    // stopHost is called exactly ONCE - if-idle only, never force.
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
    expect(rig.prompts).toEqual([]);
  });
});

describe("user quit: ask", () => {
  const ASK_PROMPT = "prompt:ask:initial";

  it("keep without remember: verdict keep, no stop, no mode change, authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      "verdict:keep",
      ...QUITTING_TAIL,
      "state:quitting:req-1",
      "authorize",
    ]);
    expect(rig.stopRequests).toEqual([]);
    expect(rig.setModeRequests).toEqual([]);
  });

  it("keep with remember: verdict keep, THEN (at commit) mode background - no refresh (parking to background never refreshes)", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: true } },
        ],
      }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      "verdict:keep",
      "quiesce",
      "setMode:background:null",
      "holdRelease",
      "state:quitting:req-1",
      "authorize",
    ]);
    expect(rig.setModeRequests).toEqual([{ mode: "background", stop: null }]);
    expect(rig.events).not.toContain("refresh:detached");
  });

  it("stop{force, remember}: verdict stop, the force stop, THEN mode linked and its refresh", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: true, remember: true },
          },
        ],
      }),
    );
    await quit(rig);
    // "Remember" is applied at commit, after the stop settles - not
    // right after the verdict - and a mode change that parks the host
    // (ask -> linked) is followed by a detached service-definition refresh.
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      "verdict:stop",
      "state:stopping:req-1:idleOnly=false",
      "stop:force:detached",
      "quiesce",
      "setMode:linked:null",
      "refresh:detached",
      "holdRelease",
      "state:quitting:req-1",
      "authorize",
    ]);
  });

  it("stop{force:false} on an idle list stops with --if-idle", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [IDLE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
    expect(rig.counts.authorize).toBe(1);
    // A non-forced Stop over an idle list is idle-only: it cannot end work.
    expect(rig.states[0]).toEqual({
      requestId: "req-1",
      phase: "stopping",
      idleOnly: true,
    });
  });

  it("stop decision, not-service-run: no busy-retry re-prompt (only host-busy re-prompts), authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [NOT_SERVICE_RUN],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toEqual([{ mode: "ask", round: "initial" }]);
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
    expect(rig.counts.authorize).toBe(1);
  });

  it("stop{force:false} then host-busy: a busy-retry prompt whose Stop is force even with force:false", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [BUSY, FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toEqual([
      { mode: "ask", round: "initial" },
      { mode: "ask", round: "busy-retry" },
    ]);
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle", "force"]);
    expect(rig.stopRequests.every((r) => r.spawn === "detached")).toBe(true);
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      // The FIRST round is idle-only (force:false) - it writes `keep`,
      // never `stop`, since it may not end anything. Only the busy-retry
      // round's forced stop commits `stop`.
      "verdict:keep",
      "state:stopping:req-1:idleOnly=true",
      "stop:if-idle:detached",
      "state:prompting:req-1",
      "prompt:ask:busy-retry",
      "verdict:stop",
      "state:stopping:req-2:idleOnly=false",
      "stop:force:detached",
      ...QUITTING_TAIL,
      "state:quitting:req-2",
      "authorize",
    ]);
  });

  it("stop then busy then Keep on the retry: verdicts keep then keep, one if-idle stop only", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [BUSY],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    const verdicts = rig.events.filter((event) => event.startsWith("verdict:"));
    // The idle-only Stop round writes `keep`, not `stop` - it never
    // finished anything before the busy-retry round Cancel/Keep took over.
    expect(verdicts).toEqual(["verdict:keep", "verdict:keep"]);
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
    expect(rig.counts.authorize).toBe(1);
    expect(rig.counts.stayOpen).toBe(0);
  });

  it("cancel from the renderer: verdict released, hold released, cancelled published, stays open, no stop", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        prompts: [{ via: "renderer", decision: { kind: "cancel" } }],
      }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      "holdRelease",
      "releaseVerdict",
      "state:cancelled:req-1",
      "stayOpen",
    ]);
    expect(rig.stopRequests).toEqual([]);
    expect(rig.counts.authorize).toBe(0);
  });

  it("cancel from the native dialog: nothing was shown to a renderer, so no cancelled state", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        prompts: [{ via: "native", decision: { kind: "cancel" } }],
      }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      "native:ask:initial",
      "holdRelease",
      "releaseVerdict",
      "stayOpen",
    ]);
    expect(rig.states).toEqual([]);
  });

  it("a rejected renderer path asks natively and applies that decision", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [FORCE_STOP],
        prompts: [
          {
            via: "native",
            decision: { kind: "stop", force: true, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      "native:ask:initial",
      "verdict:stop",
      "state:stopping:null:idleOnly=false",
      "stop:force:detached",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ]);
  });
});

describe("user quit: stop-if-idle", () => {
  it("auto if-idle stopped: NO prompt, one if-idle stop, authorize", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", stops: [IDLE_STOP] }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      "state:stopping:null:idleOnly=true",
      "stop:if-idle:detached",
      // The silent stop's genuinely successful outcome now
      // writes `verdict:stop` before commit, so a Windows supervisor tree
      // that outlives the stop is never adopted under a stale `keep`.
      "verdict:stop",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ]);
    expect(rig.prompts).toEqual([]);
  });

  it("auto host-busy: prompts round 'busy' (Stop-if-idle's own first ask, nothing shown before it); its Stop is the force", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: [BUSY, FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "busy" }]);
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle", "force"]);
    expect(rig.counts.authorize).toBe(1);
    // Answered with force:false, but the busy round's Stop is the force
    // regardless: its own second stopping state is not idle-only.
    // states[1] is the "prompting" state ending the silent stopping phase.
    expect(rig.states[2]).toEqual({
      requestId: "req-1",
      phase: "stopping",
      idleOnly: false,
    });
  });

  const unknown: ReadonlyArray<readonly [string, StopHostOutcome]> = [
    ["lock-busy", { kind: "lock-busy", message: "cli lock held" }],
    ["update-active", { kind: "update-active", message: "updating" }],
    ["failed", { kind: "failed", message: "boom" }],
  ];
  for (const [label, outcome] of unknown) {
    it(`auto ${label}: prompts round initial (idleness unknown)`, async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          stops: [outcome],
          prompts: [
            { via: "renderer", decision: { kind: "keep", remember: false } },
          ],
        }),
      );
      await quit(rig);
      expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "initial" }]);
      expect(rig.counts.authorize).toBe(1);
    });
  }

  it("auto stop outliving the deadline: withdrawn, verdict keep, authorize, no prompt", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", stops: ["hang"], deadlineMs: 30 }),
    );
    rig.txs.onBeforeQuit();
    await flush();
    expect(rig.counts.authorize).toBe(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await flush();
    expect(rig.stopRequests[0].withdrawal?.aborted).toBe(true);
    expect(rig.events).toEqual([
      ...USER_START,
      "state:stopping:null:idleOnly=true",
      "stop:if-idle:detached",
      "verdict:keep",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ]);
    expect(rig.prompts).toEqual([]);
  });

  it("auto not-service-run: NO prompt (asking would only be refused again), verdict keep, authorize", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", stops: [NOT_SERVICE_RUN] }),
    );
    await quit(rig);
    expect(rig.events).toEqual([
      ...USER_START,
      "state:stopping:null:idleOnly=true",
      "stop:if-idle:detached",
      "verdict:keep",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ]);
    expect(rig.prompts).toEqual([]);
  });
});

describe("stop-if-idle busy round naming and force", () => {
  it("the silent stop's host-busy prompt carries no busyMessage key", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: [BUSY, FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toHaveLength(1);
    expect(Object.keys(rig.prompts[0])).toEqual(["mode", "round"]);
  });

  it("a Stop answer with force:false on the busy round still runs a FORCE stop", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: [BUSY, FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle", "force"]);
  });

  it("an ask-mode non-forced Stop refused host-busy re-prompts with round 'busy-retry' (not 'busy')", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [BUSY, FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts.map((p) => p.round)).toEqual(["initial", "busy-retry"]);
  });
});

describe("stopping event idleOnly", () => {
  it("stop-if-idle's silent attempt publishes idleOnly:true", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", stops: [IDLE_STOP] }),
    );
    await quit(rig);
    expect(rig.states[0]).toEqual({
      requestId: null,
      phase: "stopping",
      idleOnly: true,
    });
  });

  it("Linked publishes stopping with idleOnly:false", async () => {
    const rig = buildRig(scenario({ mode: "linked", stops: [IDLE_STOP] }));
    await quit(rig);
    expect(rig.states[0]).toEqual({
      requestId: null,
      phase: "stopping",
      idleOnly: false,
    });
  });

  it("an ask-mode non-forced Stop publishes idleOnly:true", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [IDLE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.states[0]).toEqual({
      requestId: "req-1",
      phase: "stopping",
      idleOnly: true,
    });
  });

  it("an ask-mode forced Stop publishes idleOnly:false", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: true, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.states[0]).toEqual({
      requestId: "req-1",
      phase: "stopping",
      idleOnly: false,
    });
  });
});

describe("user quit: unsynced-edits gate", () => {
  const modes: readonly HostLifecycleMode[] = ["linked", "ask"];
  for (const mode of modes) {
    it(`${mode}: stay-open means nothing host-related happens`, async () => {
      const rig = buildRig(scenario({ mode, gate: "stay-open" }));
      await quit(rig);
      expect(rig.events).toEqual(["gate", "releaseVerdict", "stayOpen"]);
      expect(rig.counts.readPolicy).toBe(0);
      expect(rig.stopRequests).toEqual([]);
      expect(rig.setModeRequests).toEqual([]);
      expect(rig.prompts).toEqual([]);
      expect(rig.counts.authorize).toBe(0);
    });
  }
});

describe("update-install quit", () => {
  const modes: readonly HostLifecycleMode[] = ["linked", "ask"];
  for (const mode of modes) {
    it(`${mode}: handoff FIRST, before the update sequence, and never a host stop`, async () => {
      const rig = buildRig(scenario({ mode, installing: true }));
      expect(await quit(rig)).toBe("prevent");
      expect(rig.events).toEqual(["verdict:handoff", "updateSeq"]);
      expect(rig.stopRequests).toEqual([]);
      expect(rig.counts.gate).toBe(0);
      expect(rig.counts.readPolicy).toBe(0);
      expect(rig.prompts).toEqual([]);

      rig.hooks().authorizeQuit();
      expect(rig.events.at(-1)).toBe("authorize");
      expect(rig.counts.authorize).toBe(1);
    });
  }

  it("hooks.stayOpen releases the verdict and stays open, without authorizing", async () => {
    const rig = buildRig(scenario({ mode: "linked", installing: true }));
    await quit(rig);
    rig.hooks().stayOpen();
    expect(rig.events).toEqual([
      "verdict:handoff",
      "updateSeq",
      "releaseVerdict",
      "stayOpen",
    ]);
    expect(rig.counts.authorize).toBe(0);
  });

  it("the handoff write is on disk before runUpdateInstallSequence is even called", async () => {
    const rig = buildRig(scenario({ mode: "linked", installing: true }));
    rig.holdVerdictWrites();
    rig.txs.onBeforeQuit();
    await flush();
    expect(rig.events).toEqual([]);
    rig.releaseVerdictWrites();
    await flush();
    expect(rig.events).toEqual(["verdict:handoff", "updateSeq"]);
  });
});

describe("tray preset: quitAndStopHost", () => {
  function trayQuit(rig: Rig, remember: boolean): void {
    rig.txs.quitAndStopHost(remember, () => {
      rig.events.push("requestQuit");
      rig.txs.onBeforeQuit();
    });
  }

  const modes: readonly HostLifecycleMode[] = ["background", "ask"];
  for (const mode of modes) {
    it(`${mode}: force stop with no prompt`, async () => {
      const rig = buildRig(scenario({ mode, stops: [FORCE_STOP] }));
      trayQuit(rig, false);
      await flush();
      expect(rig.events).toEqual([
        "requestQuit",
        ...USER_START,
        "verdict:stop",
        "state:stopping:null:idleOnly=false",
        "stop:force:detached",
        ...QUITTING_TAIL,
        "state:quitting:null",
        "authorize",
      ]);
      expect(rig.prompts).toEqual([]);
      expect(rig.setModeRequests).toEqual([]);
    });
  }

  it("remember sets the mode to linked after the verdict AND after the stop settles", async () => {
    const rig = buildRig(scenario({ mode: "background", stops: [FORCE_STOP] }));
    trayQuit(rig, true);
    await flush();
    const verdictAt = rig.events.indexOf("verdict:stop");
    const stopAt = rig.events.indexOf("stop:force:detached");
    const modeAt = rig.events.indexOf("setMode:linked:null");
    expect(verdictAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(verdictAt);
    // "Remember" is applied only once the decision is final, at commit -
    // after the stop has settled, not right after the verdict.
    expect(modeAt).toBeGreaterThan(stopAt);
    expect(rig.events.indexOf("authorize")).toBeGreaterThan(modeAt);
  });

  it("a busy force under the tray preset does not re-prompt: it quits", async () => {
    const rig = buildRig(scenario({ mode: "ask", stops: [BUSY] }));
    trayQuit(rig, false);
    await flush();
    expect(rig.prompts).toEqual([]);
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["force"]);
    expect(rig.counts.authorize).toBe(1);
  });

  it("mode none (lanes off) ignores the preset: nothing to stop", async () => {
    const rig = buildRig(scenario({ mode: "none" }));
    trayQuit(rig, false);
    await flush();
    expect(rig.stopRequests).toEqual([]);
    expect(rig.counts.authorize).toBe(1);
  });

  it("is ignored while a quit is already in progress (and positive: it takes effect when idle)", async () => {
    const rig = buildRig(
      scenario({ mode: "ask", prompts: [{ via: "pending" }] }),
    );
    rig.txs.onBeforeQuit();
    await flush();
    let requested = 0;
    rig.txs.quitAndStopHost(false, () => {
      requested += 1;
    });
    expect(requested).toBe(0);

    const idle = buildRig(
      scenario({ mode: "background", stops: [FORCE_STOP] }),
    );
    let idleRequested = 0;
    idle.txs.quitAndStopHost(false, () => {
      idleRequested += 1;
    });
    expect(idleRequested).toBe(1);
  });
});

describe("joining a running transaction", () => {
  it("a repeat onBeforeQuit prevents and does NOT start a second transaction", async () => {
    const rig = buildRig(
      scenario({ mode: "ask", prompts: [{ via: "pending" }] }),
    );
    expect(await quit(rig)).toBe("prevent");
    expect(rig.counts.gate).toBe(1);
    expect(rig.counts.readPolicy).toBe(1);

    expect(await quit(rig)).toBe("prevent");
    expect(await quit(rig)).toBe("prevent");
    expect(rig.counts.gate).toBe(1);
    expect(rig.counts.readPolicy).toBe(1);
    expect(rig.prompts).toHaveLength(1);
  });

  it("after Cancel, the next onBeforeQuit starts a fresh transaction", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        prompts: [
          { via: "renderer", decision: { kind: "cancel" } },
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    expect(rig.counts.stayOpen).toBe(1);
    expect(rig.counts.gate).toBe(1);

    await quit(rig);
    expect(rig.counts.gate).toBe(2);
    expect(rig.counts.readPolicy).toBe(2);
    expect(rig.prompts).toHaveLength(2);
    expect(rig.counts.authorize).toBe(1);
  });
});

describe("update second pass", () => {
  it("before the handoff write settles: prevent, then authorizeQuitNow once it settles", async () => {
    const rig = buildRig(scenario({ installing: true }));
    rig.holdVerdictWrites();
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    expect(rig.counts.authorizeNow).toBe(0);

    rig.releaseVerdictWrites();
    await flush();
    expect(rig.counts.authorizeNow).toBe(1);
    // The sequence was skipped: the second pass took the release path.
    expect(rig.events).toEqual(["verdict:handoff", "authorizeNow"]);
  });

  it("after the handoff settled: allow", async () => {
    const rig = buildRig(scenario({ installing: true }));
    await quit(rig);
    expect(rig.events).toEqual(["verdict:handoff", "updateSeq"]);
    expect(rig.txs.onBeforeQuit()).toBe("allow");
    // Allowing does not run the authorize hooks; Electron just proceeds.
    expect(rig.counts.authorizeNow).toBe(0);
    expect(rig.counts.authorize).toBe(0);
  });

  it("when the install flag has dropped, a repeat only prevents", async () => {
    const rig = buildRig(scenario({ installing: true }));
    await quit(rig);
    rig.state.installing = false;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
  });
});

describe("supersede by an update install", () => {
  it("withdraws a pending prompt, and the update transaction writes handoff; the old one never authorizes or stays open", async () => {
    const rig = buildRig(
      scenario({ mode: "ask", prompts: [{ via: "pending" }] }),
    );
    await quit(rig);
    expect(rig.prompts).toHaveLength(1);

    rig.state.installing = true;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();

    expect(rig.withdrawals).toHaveLength(1);
    expect(rig.events).toContain("verdict:handoff");
    expect(rig.events.indexOf("withdraw")).toBeLessThan(
      rig.events.indexOf("verdict:handoff"),
    );
    // Nothing was shown to a renderer as a stop phase: no cancelled state.
    expect(rig.states).toEqual([]);
    // The old transaction never decided anything on the update's behalf.
    expect(rig.counts.authorize).toBe(0);
    expect(rig.counts.stayOpen).toBe(0);
    expect(rig.stopRequests).toEqual([]);
    expect(rig.events.filter((event) => event === "verdict:keep")).toEqual([]);
  });

  it("publishes cancelled when a stop phase was shown (stop-if-idle's automatic attempt)", async () => {
    const rig = buildRig(scenario({ mode: "stop-if-idle", stops: ["hang"] }));
    await quit(rig);
    expect(rig.states).toEqual([
      { requestId: null, phase: "stopping", idleOnly: true },
    ]);

    rig.state.installing = true;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();

    expect(rig.stopRequests[0].withdrawal?.aborted).toBe(true);
    expect(rig.withdrawals).toHaveLength(1);
    expect(rig.states).toEqual([
      { requestId: null, phase: "stopping", idleOnly: true },
      { requestId: null, phase: "cancelled" },
    ]);
    expect(rig.events).toContain("verdict:handoff");
    expect(rig.events).toContain("updateSeq");
    expect(rig.counts.authorize).toBe(0);
    expect(rig.counts.stayOpen).toBe(0);
    // The superseded stop's `withdrawn` outcome must not read as the deadline.
    expect(rig.events.filter((event) => event === "verdict:keep")).toEqual([]);
  });

  it("does NOT supersede once a user stop has been committed (Linked, stopping)", async () => {
    const rig = buildRig(scenario({ mode: "linked", stops: ["hang"] }));
    await quit(rig);
    expect(rig.events).toContain("state:stopping:null:idleOnly=false");

    rig.state.installing = true;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();

    expect(rig.withdrawals).toEqual([]);
    expect(rig.stopRequests[0].withdrawal?.aborted).toBe(false);
    expect(rig.events).not.toContain("verdict:handoff");
    expect(rig.states.map((s) => s.phase)).toEqual(["stopping"]);
  });
});

describe("reasons", () => {
  it("names the reason from the updater flag at the start of a quit", async () => {
    const reasons: QuitReason[] = [];
    for (const installing of [false, true]) {
      const rig = buildRig(scenario({ installing }));
      await quit(rig);
      reasons.push(rig.events[0] === "verdict:handoff" ? "relaunch" : "user");
    }
    expect(reasons).toEqual(["user", "relaunch"]);
  });
});

// The stopping phase's tray indicator and the delayed reveal, by call
// count under fake timers.
describe("stopping phase: indicator and delayed reveal", () => {
  const REVEAL_MS = 1_000;

  /** Microtask-only flush: `flush()` above waits on a real timer. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  }

  it("a) Linked stop that settles under the delay: ZERO reveals, even long after", async () => {
    vi.useFakeTimers();
    const rig = buildRig(scenario({ mode: "linked", stops: [IDLE_STOP] }));
    rig.txs.onBeforeQuit();
    await settle();
    expect(rig.counts.authorize).toBe(1);
    vi.advanceTimersByTime(REVEAL_MS * 3);
    expect(rig.counts.reveal).toBe(0);
  });

  it("b) Linked stop settling after the delay: EXACTLY ONE reveal, and it stays one", async () => {
    vi.useFakeTimers();
    const rig = buildRig(scenario({ mode: "linked", stops: ["deferred"] }));
    rig.txs.onBeforeQuit();
    await settle();
    expect(rig.counts.reveal).toBe(0);
    vi.advanceTimersByTime(REVEAL_MS - 1);
    expect(rig.counts.reveal).toBe(0);
    vi.advanceTimersByTime(1_500 - (REVEAL_MS - 1));
    expect(rig.counts.reveal).toBe(1);
    rig.resolveStop(IDLE_STOP);
    await settle();
    expect(rig.counts.authorize).toBe(1);
    vi.advanceTimersByTime(REVEAL_MS * 10);
    expect(rig.counts.reveal).toBe(1);
  });

  it("c) Stop-if-idle: a busy answer opens the prompt before the delay, so a pending prompt is never revealed over", async () => {
    vi.useFakeTimers();
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: [BUSY],
        prompts: [{ via: "pending" }],
      }),
    );
    rig.txs.onBeforeQuit();
    await settle();
    expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "busy" }]);
    vi.advanceTimersByTime(REVEAL_MS * 3);
    expect(rig.counts.reveal).toBe(0);
    expect(rig.indicator).toEqual([true, false]);
  });

  it("c') control: the same stop still running at the delay DOES reveal", async () => {
    vi.useFakeTimers();
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", stops: ["deferred"] }),
    );
    rig.txs.onBeforeQuit();
    await settle();
    vi.advanceTimersByTime(REVEAL_MS);
    expect(rig.counts.reveal).toBe(1);
    expect(rig.indicator).toEqual([true]);
  });

  it("d) indicator on once then off once, both before authorize (the phase ends as the quit commits)", async () => {
    const rig = buildRig(
      scenario({ mode: "linked", stops: [BUSY, FORCE_STOP] }),
    );
    await quit(rig);
    // Two stops (if-idle, then force) are ONE stopping phase.
    expect(rig.indicatorAtAuthorize).toEqual([[true, false]]);
    expect(rig.indicator).toEqual([true, false]);
    expect(rig.counts.authorize).toBe(1);
  });

  it("the indicator is cleared when a stopping phase ends by supersede", async () => {
    const rig = buildRig(scenario({ mode: "stop-if-idle", stops: ["hang"] }));
    await quit(rig);
    expect(rig.indicator).toEqual([true]);
    rig.state.installing = true;
    rig.txs.onBeforeQuit();
    await flush();
    expect(rig.indicator).toEqual([true, false]);
  });

  it("a superseded stopping phase never fires its reveal", async () => {
    vi.useFakeTimers();
    const rig = buildRig(scenario({ mode: "stop-if-idle", stops: ["hang"] }));
    rig.txs.onBeforeQuit();
    await settle();
    rig.state.installing = true;
    rig.txs.onBeforeQuit();
    await settle();
    vi.advanceTimersByTime(REVEAL_MS * 3);
    expect(rig.counts.reveal).toBe(0);
  });
});

// An idle-only Stop (force:false) never leaves the on-disk
// presence verdict as `stop` unless the stop is actually forced/committed.
// On head, `applyDecision`'s "stop" branch writes `verdict:stop` eagerly,
// before `runStop` even settles, for EVERY decision.kind==="stop" - forced
// or not, and regardless of the eventual outcome.
describe("an idle-only Stop never leaves presence stop", () => {
  const IDLE_ONLY_OUTCOMES: ReadonlyArray<readonly [string, StopHostOutcome]> =
    [
      ["lock-busy", { kind: "lock-busy", message: "cli lock held" }],
      ["update-active", { kind: "update-active", message: "updating" }],
      ["failed", { kind: "failed", message: "boom" }],
      ["not-service-run", NOT_SERVICE_RUN],
      ["withdrawn", { kind: "withdrawn" }],
      // "stopped" is NOT idle-only-forever: Phase C requires `verdict:stop`
      // to land after a genuinely successful stop, so it moves out of this
      // negative loop into its own dedicated tests below.
    ];

  function lastVerdictBeforeAuthorize(
    events: readonly string[],
  ): string | undefined {
    const authorizeIndex = events.indexOf("authorize");
    const upTo =
      authorizeIndex === -1 ? events : events.slice(0, authorizeIndex);
    const verdicts = upTo.filter((event) => event.startsWith("verdict:"));
    return verdicts.at(-1);
  }

  describe("ask, initial round, stop{force:false,remember:false}", () => {
    for (const [label, outcome] of IDLE_ONLY_OUTCOMES) {
      it(`${label}: no verdict:stop, last verdict before authorize is verdict:keep`, async () => {
        const rig = buildRig(
          scenario({
            mode: "ask",
            stops: [outcome],
            prompts: [
              {
                via: "renderer",
                decision: { kind: "stop", force: false, remember: false },
              },
            ],
          }),
        );
        await quit(rig);
        expect(rig.events).not.toContain("verdict:stop");
        expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
      });
    }

    it("deadline: a hang stop with a small deadlineMs, no verdict:stop, last verdict before authorize is verdict:keep", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: ["hang"],
          deadlineMs: 30,
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: false },
            },
          ],
        }),
      );
      rig.txs.onBeforeQuit();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      await flush();
      expect(rig.events).not.toContain("verdict:stop");
      expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
    });
  });

  describe("named case: stop-if-idle silent stop update-active, then the renderer's automatic stop{force:false,remember:false}", () => {
    for (const [label, outcome] of IDLE_ONLY_OUTCOMES) {
      it(`second if-idle stop ${label}: no verdict:stop, last verdict before authorize is verdict:keep`, async () => {
        const rig = buildRig(
          scenario({
            mode: "stop-if-idle",
            stops: [{ kind: "update-active", message: "updating" }, outcome],
            prompts: [
              {
                via: "renderer",
                decision: { kind: "stop", force: false, remember: false },
              },
            ],
          }),
        );
        await quit(rig);
        expect(rig.prompts).toEqual([
          { mode: "stop-if-idle", round: "initial" },
        ]);
        expect(rig.events).not.toContain("verdict:stop");
        expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
      });
    }
  });

  // A non-forced stop still writes `keep` BEFORE it
  // runs (crash-window and non-stopped-outcome protection unchanged), but
  // once its outcome is genuinely `stopped`, `verdict:stop` must be written
  // AFTER it settles and before `authorize` - otherwise a Windows supervisor
  // tree that outlives the stop can be adopted by a later indeterminate
  // start under a stale `keep`.
  describe("a genuinely successful stop still writes verdict:stop, after it settles", () => {
    it("ask, stop{force:false}, idle stop stopped: verdict:keep then verdict:stop, straddling the stop; verdict:stop is last before authorize", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [IDLE_STOP],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: false },
            },
          ],
        }),
      );
      await quit(rig);
      const keepIndex = rig.events.indexOf("verdict:keep");
      const stopRequestIndex = rig.events.indexOf("stop:if-idle:detached");
      const stopVerdictIndex = rig.events.indexOf("verdict:stop");
      expect(keepIndex).toBeGreaterThan(-1);
      expect(stopRequestIndex).toBeGreaterThan(-1);
      expect(stopVerdictIndex).toBeGreaterThan(-1);
      expect(keepIndex).toBeLessThan(stopRequestIndex);
      expect(stopRequestIndex).toBeLessThan(stopVerdictIndex);
      expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:stop");
    });

    it("stop-if-idle SILENT automatic stop, stopped: verdict:stop after the stop request and before authorize (no prompt, no verdict:keep needed)", async () => {
      const rig = buildRig(
        scenario({ mode: "stop-if-idle", stops: [IDLE_STOP] }),
      );
      await quit(rig);
      expect(rig.prompts).toEqual([]);
      const stopRequestIndex = rig.events.indexOf("stop:if-idle:detached");
      const stopVerdictIndex = rig.events.indexOf("verdict:stop");
      expect(stopRequestIndex).toBeGreaterThan(-1);
      expect(stopVerdictIndex).toBeGreaterThan(-1);
      expect(stopRequestIndex).toBeLessThan(stopVerdictIndex);
      expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:stop");
    });

    it("named case: stop-if-idle initial round after update-active, answered stop{force:false}, second stop stopped: verdict:keep precedes the second stop, verdict:stop is last before authorize", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          stops: [{ kind: "update-active", message: "updating" }, IDLE_STOP],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: false },
            },
          ],
        }),
      );
      await quit(rig);
      expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "initial" }]);
      const keepIndex = rig.events.indexOf("verdict:keep");
      const stopVerdictIndex = rig.events.indexOf("verdict:stop");
      expect(keepIndex).toBeGreaterThan(-1);
      expect(stopVerdictIndex).toBeGreaterThan(-1);
      expect(keepIndex).toBeLessThan(stopVerdictIndex);
      expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:stop");
    });
  });

  describe("crash window: a pending busy-retry prompt must not be preceded by verdict:stop", () => {
    it("stop{force:false} then BUSY: the latest verdict:* before prompt:ask:busy-retry is verdict:keep, and no verdict:stop exists", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [BUSY],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: false },
            },
            { via: "pending" },
          ],
        }),
      );
      rig.txs.onBeforeQuit();
      await flush();
      expect(rig.events).toContain("prompt:ask:busy-retry");
      const retryIndex = rig.events.indexOf("prompt:ask:busy-retry");
      const before = rig.events.slice(0, retryIndex);
      expect(before).not.toContain("verdict:stop");
      const verdictsBefore = before.filter((event) =>
        event.startsWith("verdict:"),
      );
      expect(verdictsBefore.at(-1)).toBe("verdict:keep");
    });
  });

  describe("controls (green on head too)", () => {
    it("ask stop{force:true} with lock-busy: verdict:stop is the last verdict before authorize", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [{ kind: "lock-busy", message: "cli lock held" }],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: true, remember: false },
            },
          ],
        }),
      );
      await quit(rig);
      expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:stop");
    });

    it("linked with lock-busy: verdict:stop is the last verdict before authorize", async () => {
      const rig = buildRig(
        scenario({
          mode: "linked",
          stops: [{ kind: "lock-busy", message: "cli lock held" }],
        }),
      );
      await quit(rig);
      expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:stop");
    });
  });
});

// "The desktop leaves a host that a person started in a terminal
// untouched; the mode governs the service run only." A `not-service-run`
// stop outcome means the service stop reached nothing - the terminal's host
// is still running, exactly as told, so the standing verdict must be `keep`,
// never `stop`. On head, `runLinked()` writes `stop` unconditionally before
// running, and `applyDecision`'s "stop" case only corrects a FORCED write
// back to `keep` when the outcome is `stopped` - `not-service-run` is left
// standing as whatever was written before the stop ran.
describe("a not-service-run stop leaves keep, quits, never re-prompts", () => {
  function lastVerdictBeforeAuthorize(
    events: readonly string[],
  ): string | undefined {
    const authorizeIndex = events.indexOf("authorize");
    const upTo =
      authorizeIndex === -1 ? events : events.slice(0, authorizeIndex);
    const verdicts = upTo.filter((event) => event.startsWith("verdict:"));
    return verdicts.at(-1);
  }

  /** No `verdict:stop` from the point the not-service-run stop request fired. */
  function noStopVerdictAfter(
    events: readonly string[],
    stopRequestEvent: string,
  ): void {
    const stopIndex = events.indexOf(stopRequestEvent);
    expect(stopIndex).toBeGreaterThan(-1);
    expect(events.slice(stopIndex + 1)).not.toContain("verdict:stop");
  }

  it("Linked, if-idle -> not-service-run: keep, no re-prompt, authorize", async () => {
    const rig = buildRig(
      scenario({ mode: "linked", stops: [NOT_SERVICE_RUN] }),
    );
    await quit(rig);
    expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
    noStopVerdictAfter(rig.events, "stop:if-idle:detached");
    expect(rig.counts.authorize).toBe(1);
    expect(rig.prompts).toEqual([]);
  });

  it("Linked, if-idle host-busy then force -> not-service-run: keep, no re-prompt, authorize", async () => {
    const rig = buildRig(
      scenario({ mode: "linked", stops: [BUSY, NOT_SERVICE_RUN] }),
    );
    await quit(rig);
    expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
    noStopVerdictAfter(rig.events, "stop:force:detached");
    expect(rig.counts.authorize).toBe(1);
    expect(rig.prompts).toEqual([]);
  });

  it("Stop-if-idle: silent if-idle host-busy, busy round Stop (forced), force -> not-service-run: keep, no re-prompt after, authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: [BUSY, NOT_SERVICE_RUN],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "busy" }]);
    expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
    noStopVerdictAfter(rig.events, "stop:force:detached");
    expect(rig.counts.authorize).toBe(1);
  });

  it("Ask: initial round Stop(force:false), host-busy busy-retry round Stop (forced) -> not-service-run: keep, no third prompt, authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [BUSY, NOT_SERVICE_RUN],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toEqual([
      { mode: "ask", round: "initial" },
      { mode: "ask", round: "busy-retry" },
    ]);
    expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
    noStopVerdictAfter(rig.events, "stop:force:detached");
    expect(rig.counts.authorize).toBe(1);
  });

  it("tray preset quitAndStopHost(false, ...), mode ask -> not-service-run: keep, no prompt, authorize", async () => {
    const rig = buildRig(scenario({ mode: "ask", stops: [NOT_SERVICE_RUN] }));
    rig.txs.quitAndStopHost(false, () => {
      rig.events.push("requestQuit");
      rig.txs.onBeforeQuit();
    });
    await flush();
    expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:keep");
    noStopVerdictAfter(rig.events, "stop:force:detached");
    expect(rig.counts.authorize).toBe(1);
    expect(rig.prompts).toEqual([]);
  });

  it("Ask, initial round Stop(force:false) -> if-idle -> not-service-run: exactly one verdict, keep, then authorize (pin)", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [NOT_SERVICE_RUN],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    await quit(rig);
    expect(rig.events.filter((event) => event.startsWith("verdict:"))).toEqual([
      "verdict:keep",
    ]);
    expect(rig.counts.authorize).toBe(1);
  });

  // Stop-if-idle's own silent not-service-run case ("keep, no prompt,
  // authorize") is already fully pinned by
  // describe("user quit: stop-if-idle") > it("auto not-service-run: NO
  // prompt (asking would only be refused again), verdict keep, authorize") -
  // not duplicated here.
});

// (Part 2) a foreground run (the host was started in a terminal, not
// the service) is skipped ENTIRELY - no prompt, no stop, nothing remembered.
// On head, `QuitTransactionDeps` has no `isForegroundHostRun` at all, so
// every mode still runs its normal prompt/stop path against that host.
describe("a foreground run is left untouched", () => {
  it("a) Ask: no prompt, no stop, verdict keep, authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        foregroundRun: true,
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toEqual([]);
    expect(rig.stopRequests).toEqual([]);
    expect(rig.events.filter((event) => event.startsWith("verdict:"))).toEqual([
      "verdict:keep",
    ]);
    expect(rig.counts.authorize).toBe(1);
  });

  it("b) Linked: no stop spawned, no verdict:stop, verdict keep, authorize", async () => {
    const rig = buildRig(
      scenario({ mode: "linked", foregroundRun: true, stops: [IDLE_STOP] }),
    );
    await quit(rig);
    expect(rig.stopRequests).toEqual([]);
    expect(rig.events).not.toContain("verdict:stop");
    expect(rig.events.filter((event) => event.startsWith("verdict:"))).toEqual([
      "verdict:keep",
    ]);
    expect(rig.counts.authorize).toBe(1);
  });

  it("c) Stop-if-idle: the silent stop never runs, verdict keep, no prompt, authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        foregroundRun: true,
        stops: [IDLE_STOP],
      }),
    );
    await quit(rig);
    expect(rig.stopRequests).toEqual([]);
    expect(rig.prompts).toEqual([]);
    expect(rig.events.filter((event) => event.startsWith("verdict:"))).toEqual([
      "verdict:keep",
    ]);
    expect(rig.counts.authorize).toBe(1);
  });

  it("d) tray preset quitAndStopHost(true, ...), mode ask: no stop, verdict keep, authorize, nothing remembered", async () => {
    const rig = buildRig(
      scenario({ mode: "ask", foregroundRun: true, stops: [FORCE_STOP] }),
    );
    rig.txs.quitAndStopHost(true, () => {
      rig.events.push("requestQuit");
      rig.txs.onBeforeQuit();
    });
    await flush();
    expect(rig.stopRequests).toEqual([]);
    expect(rig.events.filter((event) => event.startsWith("verdict:"))).toEqual([
      "verdict:keep",
    ]);
    expect(rig.counts.authorize).toBe(1);
    // No decision was made about THIS host - "Remember my choice" must not
    // apply to it. Today, the tray preset forces a stop regardless and, on
    // its "stopped" outcome, remembers Linked - `setModeRequests` will hold
    // {mode:"linked", stop:null} once the RED confirms this.
    expect(rig.setModeRequests).toEqual([]);
  });

  it("e) Background, no preset: no stop, no verdict:stop, authorize (control)", async () => {
    const rig = buildRig(scenario({ mode: "background", foregroundRun: true }));
    await quit(rig);
    expect(rig.stopRequests).toEqual([]);
    expect(rig.events).not.toContain("verdict:stop");
    expect(rig.counts.authorize).toBe(1);
  });

  it("f) mode none: unchanged, quits, no verdict (control)", async () => {
    const rig = buildRig(scenario({ mode: "none", foregroundRun: true }));
    await quit(rig);
    expect(rig.events.filter((event) => event.startsWith("verdict:"))).toEqual(
      [],
    );
    expect(rig.counts.authorize).toBe(1);
  });

  it("g) foregroundRun:false, Ask: the modal is still asked (guard)", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        foregroundRun: false,
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    expect(rig.prompts).toEqual([{ mode: "ask", round: "initial" }]);
    expect(rig.counts.authorize).toBe(1);
  });
});

// "Remember" (a mode change to Linked) must be applied only once the
// stop decision is FINAL - after the stop itself has settled - never before
// it, and never for a round a later answer superseded. On head,
// `applyDecision`'s "stop" case calls `this.remember(...)` BEFORE
// `runStop(...)`, unconditionally, for every remembered Stop answer.
describe("Remember is applied only once the decision is final", () => {
  function indexOf(events: readonly string[], event: string): number {
    const index = events.indexOf(event);
    expect(index).toBeGreaterThan(-1);
    return index;
  }

  describe("(a) order: setMode:linked comes after the stop settles, before authorize", () => {
    it("ask stop{force:false,remember:true} with an idle stop", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [IDLE_STOP],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: true },
            },
          ],
        }),
      );
      await quit(rig);
      const stopIndex = indexOf(rig.events, "stop:if-idle:detached");
      const setModeIndex = indexOf(rig.events, "setMode:linked:null");
      const authorizeIndex = indexOf(rig.events, "authorize");
      expect(setModeIndex).toBeGreaterThan(stopIndex);
      expect(setModeIndex).toBeLessThan(authorizeIndex);
    });

    it("ask stop{force:true,remember:true} with a force stop", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [FORCE_STOP],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: true, remember: true },
            },
          ],
        }),
      );
      await quit(rig);
      const stopIndex = indexOf(rig.events, "stop:force:detached");
      const setModeIndex = indexOf(rig.events, "setMode:linked:null");
      const authorizeIndex = indexOf(rig.events, "authorize");
      expect(setModeIndex).toBeGreaterThan(stopIndex);
      expect(setModeIndex).toBeLessThan(authorizeIndex);
    });

    it("the tray preset quitAndStopHost(true, ...) from background", async () => {
      const rig = buildRig(
        scenario({ mode: "background", stops: [FORCE_STOP] }),
      );
      rig.txs.quitAndStopHost(true, () => {
        rig.events.push("requestQuit");
        rig.txs.onBeforeQuit();
      });
      await flush();
      const stopIndex = indexOf(rig.events, "stop:force:detached");
      const setModeIndex = indexOf(rig.events, "setMode:linked:null");
      const authorizeIndex = indexOf(rig.events, "authorize");
      expect(setModeIndex).toBeGreaterThan(stopIndex);
      expect(setModeIndex).toBeLessThan(authorizeIndex);
    });
  });

  it("(a-lane) budget mechanism: remembering before the stop starves it behind the refresh job on the shared lane", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        lane: true,
        deadlineMs: 100,
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: true },
          },
        ],
      }),
    );
    rig.txs.onBeforeQuit();
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    await flush();
    expect(rig.laneSpawned()).toBe(1);
  });

  describe("(b) cancel: a remembered choice on a superseded round is never applied", () => {
    it("stop{force:false,remember:true} then BUSY then Cancel: setModeRequests is empty, verdict released", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [BUSY],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: true },
            },
            { via: "renderer", decision: { kind: "cancel" } },
          ],
        }),
      );
      await quit(rig);
      expect(rig.setModeRequests).toEqual([]);
      expect(rig.events).toContain("releaseVerdict");
    });
  });

  describe("(b') the final decision's remember wins", () => {
    it("stop{f:false,r:true} then stop{f:false,r:false} (BUSY, then FORCE_STOP): setModeRequests is empty", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [BUSY, FORCE_STOP],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: true },
            },
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: false },
            },
          ],
        }),
      );
      await quit(rig);
      expect(rig.setModeRequests).toEqual([]);
    });

    it("stop{f:false,r:false} then stop{f:false,r:true} (BUSY, then FORCE_STOP): exactly one setMode:linked AFTER stop:force:detached", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: [BUSY, FORCE_STOP],
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: false },
            },
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: true },
            },
          ],
        }),
      );
      await quit(rig);
      expect(rig.setModeRequests).toEqual([{ mode: "linked", stop: null }]);
      const forceStopIndex = indexOf(rig.events, "stop:force:detached");
      const setModeIndex = indexOf(rig.events, "setMode:linked:null");
      expect(setModeIndex).toBeGreaterThan(forceStopIndex);
    });
  });

  describe("(c) detached refresh: remembering spawns a detached refresh, not the parked-mode lane job", () => {
    it("tray preset remember=true from background, an admitted stop that never settles, a small deadline: refresh:detached appears exactly once, before authorize", async () => {
      const rig = buildRig(
        scenario({ mode: "background", stops: ["deferred"], deadlineMs: 30 }),
      );
      rig.txs.quitAndStopHost(true, () => {
        rig.events.push("requestQuit");
        rig.txs.onBeforeQuit();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await flush();
      expect(
        rig.events.filter((event) => event === "refresh:detached"),
      ).toHaveLength(1);
      const refreshIndex = indexOf(rig.events, "refresh:detached");
      const authorizeIndex = indexOf(rig.events, "authorize");
      expect(refreshIndex).toBeLessThan(authorizeIndex);
    });

    it("control: Keep + remember (to background) never spawns a detached refresh", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          prompts: [
            { via: "renderer", decision: { kind: "keep", remember: true } },
          ],
        }),
      );
      await quit(rig);
      expect(rig.events).not.toContain("refresh:detached");
    });

    it("ask, Stop+Remember, a deferred stop that outlives the deadline: setMode:linked comes after the deadline, refresh:detached comes after setMode and before authorize", async () => {
      const rig = buildRig(
        scenario({
          mode: "ask",
          stops: ["deferred"],
          deadlineMs: 30,
          prompts: [
            {
              via: "renderer",
              decision: { kind: "stop", force: false, remember: true },
            },
          ],
        }),
      );
      rig.txs.onBeforeQuit();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      await flush();
      // The deadline cuts off an idle-only attempt - never `stop`.
      expect(rig.events).toContain("verdict:keep");
      const stopRequestedIndex = indexOf(rig.events, "stop:if-idle:detached");
      const setModeIndex = indexOf(rig.events, "setMode:linked:null");
      const refreshIndex = indexOf(rig.events, "refresh:detached");
      const authorizeIndex = indexOf(rig.events, "authorize");
      expect(setModeIndex).toBeGreaterThan(stopRequestedIndex);
      expect(refreshIndex).toBeGreaterThan(setModeIndex);
      expect(authorizeIndex).toBeGreaterThan(refreshIndex);
    });
  });
});

// (Main side) a dead local host is never prompted or stopped against.
// On head, `QuitTransactionDeps` has no `isLocalHostRunning` gate at all, so
// Ask still prompts and Stop-if-idle still re-prompts on an unrelated
// outcome even when there is no local host to reach.
describe("a dead local host is never prompted (main)", () => {
  function noPromptOrStopEvents(events: readonly string[]): void {
    expect(events.some((event) => event.startsWith("prompt:"))).toBe(false);
    expect(events.some((event) => event.startsWith("native:"))).toBe(false);
    expect(events.some((event) => event.startsWith("stop:"))).toBe(false);
  }

  it("ask, host down: no prompt, no native, no stop, verdict:keep, then authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        isLocalHostRunning: false,
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    noPromptOrStopEvents(rig.events);
    expect(rig.events).toContain("verdict:keep");
    expect(rig.events.at(-1)).toBe("authorize");
  });

  it("stop-if-idle, host down: the silent stop returns update-active, but no re-prompt happens; verdict:keep, then authorize", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        isLocalHostRunning: false,
        stops: [{ kind: "update-active", message: "updating" }],
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    expect(rig.events.some((event) => event.startsWith("prompt:"))).toBe(false);
    expect(rig.events).toContain("verdict:keep");
    expect(rig.events.at(-1)).toBe("authorize");
  });

  it("control: host up means the prompt happens", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        isLocalHostRunning: true,
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    expect(rig.events).toContain("prompt:ask:initial");
  });
});

// An update-install takeover must never overlap a stop still in
// flight. On head, `join()`'s supersede check only looks at `stopCommitted`,
// which `runStopIfIdle`'s SILENT if-idle attempt never sets - so `supersede()`
// (and the new transaction's `verdict:handoff` / `runUpdateInstallSequence`)
// proceeds immediately, while the old admitted stop is still running.
describe("update-install takeover never overlaps a stop in flight", () => {
  it("admitted: a deferred silent stop is not overlapped - no handoff/updateSeq until it settles, then the update relaunches", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", lane: true, stops: ["lane-hang"] }),
    );
    rig.txs.onBeforeQuit();
    await flush();
    // Admitted: really running on the lane, not merely queued.
    expect(rig.admissionBlock()).toEqual({
      kind: "mutation",
      lane: expect.objectContaining({ kind: "stopHost" }),
    });

    rig.state.installing = true;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();
    expect(rig.events).not.toContain("verdict:handoff");
    expect(rig.events).not.toContain("updateSeq");

    rig.resolveStop(IDLE_STOP);
    await flush();

    const settledIndex = rig.events.indexOf("stop:settled");
    const handoffIndex = rig.events.indexOf("verdict:handoff");
    const updateSeqIndex = rig.events.indexOf("updateSeq");
    expect(settledIndex).toBeGreaterThan(-1);
    expect(handoffIndex).toBeGreaterThan(settledIndex);
    expect(updateSeqIndex).toBeGreaterThan(handoffIndex);

    rig.hooks().authorizeQuit();
    expect(rig.events.at(-1)).toBe("authorize");
  });

  it("admitted variant: the settled outcome is BUSY - no prompt, then handoff and updateSeq", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", lane: true, stops: ["lane-hang"] }),
    );
    rig.txs.onBeforeQuit();
    await flush();
    expect(rig.admissionBlock()).toEqual({
      kind: "mutation",
      lane: expect.objectContaining({ kind: "stopHost" }),
    });

    rig.state.installing = true;
    rig.txs.onBeforeQuit();
    await flush();
    // The admitted stop is still running: the relaunch must not go too far
    // and write handoff before it settles.
    expect(rig.events).not.toContain("verdict:handoff");

    rig.resolveStop(BUSY);
    await flush();

    expect(rig.prompts).toEqual([]);
    expect(rig.events).toContain("verdict:handoff");
    expect(rig.events).toContain("updateSeq");
  });

  it("queued: a hang stop is aborted, resolves withdrawn, and handoff follows", async () => {
    const rig = buildRig(scenario({ mode: "stop-if-idle", stops: ["hang"] }));
    rig.txs.onBeforeQuit();
    await flush();

    rig.state.installing = true;
    rig.txs.onBeforeQuit();
    await flush();

    expect(rig.stopRequests[0].withdrawal?.aborted).toBe(true);
    expect(rig.events).toContain("verdict:handoff");
  });
});

// `join()`'s defer must track ADMISSION, not mere presence of
// an in-flight stop. On the current tree, ANY `inFlightStop` (queued or
// admitted) makes the relaunch wait for it to settle before writing
// `handoff` - so a stop still queued behind an unrelated lane job (an
// "install", or another commit's `stopHost`) blocks the relaunch exactly as
// long as an admitted one would, even though nothing of the quit's is
// actually running yet. The fix reads `controller.lifecycleAdmissionBlock`:
// only a RUNNING `stopHost` job defers; a merely QUEUED one is aborted and
// superseded at once.
describe("only an admitted stop defers the relaunch", () => {
  it("queued behind a long job: the relaunch supersedes at once, without waiting for the job ahead", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", lane: true, laneHeld: "install" }),
    );
    rig.txs.onBeforeQuit();
    await flush();
    // The quit's silent stop is queued behind the held install job - never
    // admitted yet.
    expect(rig.laneSpawned()).toBe(0);

    rig.state.installing = true;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();

    // RED on the current tree: `join()` waits for `inFlightStop` to settle
    // regardless of admission, so neither of these exists yet.
    expect(rig.events).toContain("verdict:handoff");
    expect(rig.events).toContain("updateSeq");
    expect(rig.stopRequests[0]?.withdrawal?.aborted).toBe(true);
    // Still queued: the install has not released the lane.
    expect(rig.laneSpawned()).toBe(0);

    rig.releaseLane();
    await flush();

    // The quit's own stop, now admitted, sees its withdrawal already
    // aborted and settles `withdrawn` - it never spawns.
    expect(rig.laneSpawned()).toBe(0);
  });

  it("admitted still defers: while the quit's OWN stop is running on the lane, the relaunch waits for it", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", lane: true, stops: ["lane-hang"] }),
    );
    rig.txs.onBeforeQuit();
    await flush();
    // Nothing ahead of it: admitted and running immediately.
    expect(rig.laneSpawned()).toBe(1);

    rig.state.installing = true;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();
    expect(rig.events).not.toContain("verdict:handoff");
    expect(rig.events).not.toContain("updateSeq");

    rig.resolveStop(IDLE_STOP);
    await flush();

    const settledIndex = rig.events.indexOf("stop:settled");
    const handoffIndex = rig.events.indexOf("verdict:handoff");
    const updateSeqIndex = rig.events.indexOf("updateSeq");
    expect(settledIndex).toBeGreaterThan(-1);
    expect(handoffIndex).toBeGreaterThan(settledIndex);
    expect(updateSeqIndex).toBeGreaterThan(handoffIndex);
  });

  it("stop-behind-stop corner: a held stopHost job (not the quit's) still defers - the wait is bounded by its release", async () => {
    const rig = buildRig(
      scenario({ mode: "stop-if-idle", lane: true, laneHeld: "stopHost" }),
    );
    rig.txs.onBeforeQuit();
    await flush();
    // Queued behind the held (unrelated) stopHost job.
    expect(rig.laneSpawned()).toBe(0);

    rig.state.installing = true;
    expect(rig.txs.onBeforeQuit()).toBe("prevent");
    await flush();
    // The lane's running kind IS "stopHost" (the held job's), so the
    // admission check alone cannot tell it apart from the quit's own -
    // it still defers.
    expect(rig.events).not.toContain("verdict:handoff");
    expect(rig.events).not.toContain("updateSeq");

    rig.releaseLane();
    await flush();

    // The quit's own stop, now admitted, sees its withdrawal already
    // aborted (queued stops are aborted at `join()` regardless of what's
    // ahead) and settles `withdrawn` without spawning; the wait was bounded
    // by the held job's release, not by the quit's own stop settling.
    expect(rig.laneSpawned()).toBe(0);
    expect(rig.events).toContain("verdict:handoff");
    expect(rig.events).toContain("updateSeq");
  });
});

// (Main side) a stopping phase that ends because main is about to
// prompt must publish an end-of-stopping "prompting" state - not just stop
// silently, which leaves a renderer showing "Stopping host…" over a modal
// that is about to appear. On head, `ask()` calls `endStopping()` (the
// LOCAL indicator/reveal-timer bookkeeping only) before asking, but never
// calls `deps.publishState(...)` for it, so no "state:prompting:*" event is
// ever produced - the rig's formatter already prints one correctly
// (`state:${event.phase}:${event.requestId}`, same as "quitting"/"cancelled"),
// it is simply never called with `phase: "prompting"`.
describe("prompting ends a stopping phase (main side)", () => {
  function indexOf(events: readonly string[], event: string): number {
    return events.indexOf(event);
  }

  it("stop-if-idle: silent stop BUSY, busy prompt answered Keep - state:prompting:null between stopping and the prompt", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: [BUSY],
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    const stoppingIndex = indexOf(
      rig.events,
      "state:stopping:null:idleOnly=true",
    );
    const promptingIndex = indexOf(rig.events, "state:prompting:null");
    const promptIndex = indexOf(rig.events, "prompt:stop-if-idle:busy");
    expect(stoppingIndex).toBeGreaterThan(-1);
    expect(promptingIndex).toBeGreaterThan(stoppingIndex);
    expect(promptingIndex).toBeLessThan(promptIndex);
  });

  it("ask, stop{force:false} then BUSY: state:prompting:<req-id> between that request's stopping and the busy-retry prompt", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        stops: [BUSY, FORCE_STOP],
        prompts: [
          {
            via: "renderer",
            decision: { kind: "stop", force: false, remember: false },
          },
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    const stoppingIndex = indexOf(
      rig.events,
      "state:stopping:req-1:idleOnly=true",
    );
    const promptingIndex = indexOf(rig.events, "state:prompting:req-1");
    const retryPromptIndex = indexOf(rig.events, "prompt:ask:busy-retry");
    expect(stoppingIndex).toBeGreaterThan(-1);
    expect(promptingIndex).toBeGreaterThan(stoppingIndex);
    expect(promptingIndex).toBeLessThan(retryPromptIndex);
  });

  it("native path: prompting is published before the native dialog is asked", async () => {
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: [BUSY],
        prompts: [
          { via: "native", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    const promptingIndex = indexOf(rig.events, "state:prompting:null");
    const nativeIndex = indexOf(rig.events, "native:stop-if-idle:busy");
    expect(promptingIndex).toBeGreaterThan(-1);
    expect(promptingIndex).toBeLessThan(nativeIndex);
  });

  it("control: an Ask initial with nothing stopping before it publishes no prompting state", async () => {
    const rig = buildRig(
      scenario({
        mode: "ask",
        prompts: [
          { via: "renderer", decision: { kind: "keep", remember: false } },
        ],
      }),
    );
    await quit(rig);
    expect(
      rig.events.some((event) => event.startsWith("state:prompting")),
    ).toBe(false);
  });
});

// (Test-gap, green on head) the force stop's OWN deadline budget is
// whatever remains of the overall `deadlineMs` after the silent if-idle
// attempt spent its share - not the full deadline again. `runStop` tracks
// this via `this.remainingMs -= Date.now() - startedAt`.
describe("the force stop's withdrawal deadline is the remaining budget, not a fresh one", () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  }

  it("silent if-idle spends 0.6D; the busy prompt stays up for 10D; the force stop's withdrawal aborts at 0.4D after IT started, not before", async () => {
    vi.useFakeTimers();
    const D = 1_000;
    const rig = buildRig(
      scenario({
        mode: "stop-if-idle",
        stops: ["deferred", "hang"],
        deadlineMs: D,
        prompts: [
          {
            via: "renderer-after",
            delayMs: 10 * D,
            decision: { kind: "stop", force: false, remember: false },
          },
        ],
      }),
    );
    rig.txs.onBeforeQuit();
    await settle();

    await vi.advanceTimersByTimeAsync(0.6 * D);
    rig.resolveStop(BUSY);
    await settle();

    // The busy prompt is up (nothing requested yet - the deadline budget is
    // paused while it waits, no matter how long the person takes to answer).
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);

    await vi.advanceTimersByTimeAsync(10 * D);
    await settle();

    // The force stop IS requested once the 10D prompt is finally answered -
    // not skipped, and not measured against the paused deadline budget.
    expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle", "force"]);
    // The busy round's Stop is the force, whatever `force` the decision said.
    const withdrawal = rig.stopRequests[1].withdrawal;
    expect(withdrawal).not.toBeNull();

    await vi.advanceTimersByTimeAsync(0.4 * D - 1);
    expect(withdrawal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(withdrawal?.aborted).toBe(true);
    expect(rig.counts.authorize).toBe(1);
  });
});

// Stop-if-idle reads the host's activity probe before it stops anything: a
// terminal in use (a person entered a line, the shell is alive) can be running
// a command with no output, which the host's busy rule reads as idle. A count
// above zero asks first; a count of zero, a host that reports none, and a host
// that cannot be reached take the silent if-idle stop as before.
describe("stop-if-idle with terminals in use", () => {
  const IN_USE_IDLE: HostActivityProbe = {
    kind: "answered",
    busy: false,
    terminalsInUse: 2,
  };
  const IN_USE_BUSY: HostActivityProbe = {
    kind: "answered",
    busy: true,
    terminalsInUse: 2,
  };
  const TERMINALS_PROMPT: HostQuitPrompt = {
    mode: "stop-if-idle",
    round: "terminals-in-use",
    terminalsInUse: 2,
  };
  const TERMINALS_PROMPT_EVENT = "prompt:stop-if-idle:terminals-in-use";
  const STOP_IDLE_ONLY: PromptScript = {
    via: "renderer",
    decision: { kind: "stop", force: false, remember: false },
  };

  function lastVerdictBeforeAuthorize(
    events: readonly string[],
  ): string | undefined {
    const authorizeIndex = events.indexOf("authorize");
    const upTo =
      authorizeIndex === -1 ? events : events.slice(0, authorizeIndex);
    return upTo.filter((event) => event.startsWith("verdict:")).at(-1);
  }

  describe("terminals in use, host not busy", () => {
    it("asks the terminals-in-use round with the count, before any stop or stopping phase", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          prompts: [{ via: "pending" }],
        }),
      );
      await quit(rig);

      expect(rig.prompts).toEqual([TERMINALS_PROMPT]);
      expect(rig.stopRequests).toEqual([]);
      // Nothing was announced as stopping before the question, and the tray
      // indicator was never lit for it.
      expect(rig.states).toEqual([]);
      expect(rig.indicator).not.toContain(true);
      expect(rig.counts.reveal).toBe(0);
      expect(rig.events).toEqual([...USER_START, TERMINALS_PROMPT_EVENT]);
    });

    it("Stop (force:false): an if-idle stop, never a force; keep before it, stop once it stopped", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          stops: [IDLE_STOP],
          prompts: [STOP_IDLE_ONLY],
        }),
      );
      await quit(rig);

      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
      expect(rig.events).toEqual([
        ...USER_START,
        TERMINALS_PROMPT_EVENT,
        "verdict:keep",
        "state:stopping:req-1:idleOnly=true",
        "stop:if-idle:detached",
        "verdict:stop",
        ...QUITTING_TAIL,
        "state:quitting:req-1",
        "authorize",
      ]);
      expect(lastVerdictBeforeAuthorize(rig.events)).toBe("verdict:stop");
      expect(rig.counts.authorize).toBe(1);
      expect(rig.counts.stayOpen).toBe(0);
    });

    it("Stop, but the if-idle stop is refused host-busy: asks busy-retry, and the verdict stays keep until then", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          stops: [BUSY],
          prompts: [STOP_IDLE_ONLY, { via: "pending" }],
        }),
      );
      await quit(rig);

      expect(rig.prompts).toEqual([
        TERMINALS_PROMPT,
        { mode: "stop-if-idle", round: "busy-retry" },
      ]);
      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
      const retryIndex = rig.events.indexOf("prompt:stop-if-idle:busy-retry");
      expect(retryIndex).toBeGreaterThan(-1);
      expect(rig.events.slice(0, retryIndex)).not.toContain("verdict:stop");
      expect(
        rig.events
          .slice(0, retryIndex)
          .filter((event) => event.startsWith("verdict:"))
          .at(-1),
      ).toBe("verdict:keep");
      expect(rig.counts.authorize).toBe(0);
    });

    it("Stop, refused host-busy, then Stop on busy-retry: that round's Stop is the force", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          stops: [BUSY, FORCE_STOP],
          prompts: [STOP_IDLE_ONLY, STOP_IDLE_ONLY],
        }),
      );
      await quit(rig);

      expect(rig.prompts.map((p) => p.round)).toEqual([
        "terminals-in-use",
        "busy-retry",
      ]);
      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle", "force"]);
      expect(rig.counts.authorize).toBe(1);
    });

    it("Keep: verdict keep, no stop, the quit commits", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          prompts: [
            { via: "renderer", decision: { kind: "keep", remember: false } },
          ],
        }),
      );
      await quit(rig);

      expect(rig.events).toEqual([
        ...USER_START,
        TERMINALS_PROMPT_EVENT,
        "verdict:keep",
        ...QUITTING_TAIL,
        "state:quitting:req-1",
        "authorize",
      ]);
      expect(rig.stopRequests).toEqual([]);
    });

    it("Cancel: stays open, nothing stopped, the verdict released", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          prompts: [{ via: "renderer", decision: { kind: "cancel" } }],
        }),
      );
      await quit(rig);

      expect(rig.events).toEqual([
        ...USER_START,
        TERMINALS_PROMPT_EVENT,
        "holdRelease",
        "releaseVerdict",
        "state:cancelled:req-1",
        "stayOpen",
      ]);
      expect(rig.stopRequests).toEqual([]);
      expect(rig.counts.stayOpen).toBe(1);
      expect(rig.counts.authorize).toBe(0);
    });

    it("the native dialog's Stop (force:false) is idle-only too", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          stops: [IDLE_STOP],
          prompts: [
            {
              via: "native",
              decision: { kind: "stop", force: false, remember: false },
            },
          ],
        }),
      );
      await quit(rig);

      expect(rig.events).toContain("native:stop-if-idle:terminals-in-use");
      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
      expect(rig.counts.authorize).toBe(1);
    });
  });

  describe("terminals in use, host busy", () => {
    it("asks the busy round directly, with no stop tried and no count in the prompt", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_BUSY,
          prompts: [{ via: "pending" }],
        }),
      );
      await quit(rig);

      expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "busy" }]);
      expect(Object.keys(rig.prompts[0])).toEqual(["mode", "round"]);
      expect(rig.stopRequests).toEqual([]);
      expect(rig.states).toEqual([]);
      expect(rig.events).toEqual([...USER_START, "prompt:stop-if-idle:busy"]);
    });

    it("a Stop answered on that round (even with force:false) runs a FORCE stop", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_BUSY,
          stops: [FORCE_STOP],
          prompts: [STOP_IDLE_ONLY],
        }),
      );
      await quit(rig);

      expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "busy" }]);
      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["force"]);
      expect(rig.counts.authorize).toBe(1);
    });
  });

  describe("the silent if-idle path, unchanged", () => {
    const SILENT_PATH_STOPPED = [
      ...USER_START,
      "state:stopping:null:idleOnly=true",
      "stop:if-idle:detached",
      "verdict:stop",
      ...QUITTING_TAIL,
      "state:quitting:null",
      "authorize",
    ];

    it("a count of zero: if-idle stop with no prompt, the quit commits on stopped", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: { kind: "answered", busy: false, terminalsInUse: 0 },
          stops: [IDLE_STOP],
        }),
      );
      await quit(rig);

      expect(rig.events).toEqual(SILENT_PATH_STOPPED);
      expect(rig.prompts).toEqual([]);
    });

    it("a count the host did not report (null), host not busy: if-idle stop first, no prompt before it", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: { kind: "answered", busy: false, terminalsInUse: null },
          stops: [IDLE_STOP],
        }),
      );
      await quit(rig);

      expect(rig.events).toEqual(SILENT_PATH_STOPPED);
      expect(rig.prompts).toEqual([]);
    });

    it("a count the host did not report (null), host busy: if-idle stop attempted first; its refusal asks busy", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: { kind: "answered", busy: true, terminalsInUse: null },
          stops: [BUSY],
          prompts: [{ via: "pending" }],
        }),
      );
      await quit(rig);

      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
      expect(rig.events).toEqual([
        ...USER_START,
        "state:stopping:null:idleOnly=true",
        "stop:if-idle:detached",
        "state:prompting:null",
        "prompt:stop-if-idle:busy",
      ]);
      expect(rig.prompts).toEqual([{ mode: "stop-if-idle", round: "busy" }]);
    });

    it("a host that cannot be reached: the if-idle stop, no prompt", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: { kind: "unreachable" },
          stops: [IDLE_STOP],
        }),
      );
      await quit(rig);

      expect(rig.events).toEqual(SILENT_PATH_STOPPED);
      expect(rig.prompts).toEqual([]);
    });

    it("a probe dep that rejects: the if-idle stop, no prompt", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: "reject",
          stops: [IDLE_STOP],
        }),
      );
      await quit(rig);

      expect(rig.probeCalls()).toBe(1);
      expect(rig.events).toEqual(SILENT_PATH_STOPPED);
      expect(rig.prompts).toEqual([]);
    });
  });

  describe("the probe is read before the stopping phase", () => {
    it("while the probe is pending nothing is published, lit or stopped; its answer then decides", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: "deferred",
          prompts: [{ via: "pending" }],
        }),
      );
      await quit(rig);

      expect(rig.probeCalls()).toBe(1);
      expect(rig.events).toEqual(USER_START);
      expect(rig.states).toEqual([]);
      expect(rig.indicator).toEqual([]);
      expect(rig.stopRequests).toEqual([]);
      expect(rig.prompts).toEqual([]);

      rig.resolveProbe(IN_USE_IDLE);
      await flush();

      expect(rig.prompts).toEqual([TERMINALS_PROMPT]);
      expect(rig.stopRequests).toEqual([]);
      expect(rig.events).toEqual([...USER_START, TERMINALS_PROMPT_EVENT]);
    });

    it("a pending probe answered with no count then starts the stopping phase and the stop", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: "deferred",
          stops: [IDLE_STOP],
        }),
      );
      await quit(rig);
      expect(rig.stopRequests).toEqual([]);

      rig.resolveProbe({ kind: "answered", busy: false, terminalsInUse: null });
      await flush();

      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["if-idle"]);
      expect(rig.counts.authorize).toBe(1);
    });

    // The answer that would ask, and the answers that would stop: the
    // superseded quit must do neither.
    const ANSWERS: ReadonlyArray<readonly [string, HostActivityProbe]> = [
      ["terminals in use, idle", IN_USE_IDLE],
      ["terminals in use, busy", IN_USE_BUSY],
      [
        "no count reported",
        { kind: "answered", busy: false, terminalsInUse: null },
      ],
      ["unreachable", { kind: "unreachable" }],
    ];
    for (const [label, answer] of ANSWERS) {
      it(`superseded by a relaunch while the probe is pending (${label}): the old quit asks nothing and stops nothing`, async () => {
        const rig = buildRig(
          scenario({ mode: "stop-if-idle", probe: "deferred" }),
        );
        await quit(rig);
        expect(rig.probeCalls()).toBe(1);

        rig.state.installing = true;
        expect(rig.txs.onBeforeQuit()).toBe("prevent");
        await flush();
        rig.resolveProbe(answer);
        await flush();

        expect(rig.prompts).toEqual([]);
        expect(rig.events).not.toContain(TERMINALS_PROMPT_EVENT);
        expect(rig.stopRequests).toEqual([]);
        expect(rig.states).toEqual([]);
        // The relaunch transaction proceeded as in the existing supersede rows.
        expect(rig.events).toContain("verdict:handoff");
        expect(rig.events).toContain("updateSeq");
        expect(rig.counts.authorize).toBe(0);
        expect(rig.counts.stayOpen).toBe(0);
        expect(rig.events.filter((event) => event === "verdict:keep")).toEqual(
          [],
        );
      });
    }
  });

  describe("only stop-if-idle reads the probe", () => {
    const modes: readonly HostLifecycleMode[] = [
      "ask",
      "linked",
      "background",
      "none",
    ];
    for (const mode of modes) {
      it(`${mode}: a quit never reads the activity probe`, async () => {
        const rig = buildRig(
          scenario({
            mode,
            probe: IN_USE_IDLE,
            stops: [IDLE_STOP],
            prompts: [
              { via: "renderer", decision: { kind: "keep", remember: false } },
            ],
          }),
        );
        await quit(rig);

        expect(rig.probeCalls()).toBe(0);
        expect(rig.prompts.map((p) => p.round)).not.toContain(
          "terminals-in-use",
        );
      });
    }

    it("the tray preset (Quit and Stop Host) under stop-if-idle does not read it either", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          probe: IN_USE_IDLE,
          stops: [FORCE_STOP],
        }),
      );
      rig.txs.quitAndStopHost(false, () => {
        rig.events.push("requestQuit");
        rig.txs.onBeforeQuit();
      });
      await flush();

      expect(rig.probeCalls()).toBe(0);
      expect(rig.prompts).toEqual([]);
      expect(rig.stopRequests.map((r) => r.mode)).toEqual(["force"]);
      expect(rig.counts.authorize).toBe(1);
    });

    it("an update-install quit does not read it", async () => {
      const rig = buildRig(
        scenario({
          mode: "stop-if-idle",
          installing: true,
          probe: IN_USE_IDLE,
        }),
      );
      await quit(rig);

      expect(rig.probeCalls()).toBe(0);
    });
  });
});
