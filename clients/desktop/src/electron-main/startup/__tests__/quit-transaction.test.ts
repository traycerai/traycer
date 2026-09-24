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
  StopHostOutcome,
  StopHostRequest,
} from "../../host/host-controller-types";
import type { QuitVerdictWriteOutcome } from "../../host/host-lifecycle-transitions";
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

// The quit transaction (host-lifecycle-modes T06), driven through fakes for
// every dependency. Every claim is asserted over the ORDERED event log the
// fakes write (verdicts, stops, mode changes, published states, the ending),
// so a row cannot pass by reaching the right end state through the wrong
// steps.

const VIEW: HostLifecycleView = {
  desired: { mode: "ask", rev: 1, updatedBy: "desktop", updatedAt: null },
  applied: { localHostCapability: "managed", supervisor: "not-running" },
  pending: "none",
};

const IDLE_STOP: StopHostOutcome = { kind: "stopped", forced: false };
const FORCE_STOP: StopHostOutcome = { kind: "stopped", forced: true };
const BUSY: StopHostOutcome = {
  kind: "host-busy",
  message: "2 agents running",
};

/** A scripted answer to one host quit prompt. */
type PromptScript =
  | { readonly via: "renderer"; readonly decision: HostQuitDecision }
  /** The renderer path rejects (no listening window); main asks natively. */
  | { readonly via: "native"; readonly decision: HostQuitDecision }
  /** The renderer is asked and never answers until the question is withdrawn. */
  | { readonly via: "pending" };

/** A scripted stop: an outcome, or a stop that runs until withdrawn. */
type StopScript = StopHostOutcome | "hang" | "deferred";

interface Scenario {
  readonly mode: HostLifecycleMode;
  readonly installing: boolean;
  readonly gate: "proceed" | "stay-open";
  readonly stops: readonly StopScript[];
  readonly prompts: readonly PromptScript[];
  readonly deadlineMs: number;
  readonly revealDelayMs: number;
}

const DEFAULT_SCENARIO: Scenario = {
  mode: "background",
  installing: false,
  gate: "proceed",
  stops: [],
  prompts: [],
  deadlineMs: 5_000,
  revealDelayMs: 1_000,
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
  /** Settle the oldest `deferred` stop. */
  resolveStop(outcome: StopHostOutcome): void;
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
    hooks: () => {
      if (hooks === null) throw new Error("update sequence not started");
      return hooks;
    },
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
      isInstallingUpdate: () => state.installing,
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
          return Promise.resolve({ kind: "applied", view: VIEW });
        },
      },
      controller: {
        stopHost: (request) => {
          stopRequests.push(request);
          events.push(`stop:${request.mode}:${request.spawn}`);
          const script = stopScripts.shift();
          if (script === undefined) {
            throw new Error("test fixture: no scripted stop outcome");
          }
          if (script === "deferred") {
            return new Promise<StopHostOutcome>((resolve) => {
              deferredStops.push(resolve);
            });
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

  it("keep with remember: verdict keep, THEN mode background", async () => {
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
      "setMode:background:null",
      ...QUITTING_TAIL,
      "state:quitting:req-1",
      "authorize",
    ]);
    expect(rig.setModeRequests).toEqual([{ mode: "background", stop: null }]);
  });

  it("stop{force, remember}: verdict stop, THEN mode linked, then the force stop", async () => {
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
    expect(rig.events).toEqual([
      ...USER_START,
      ASK_PROMPT,
      "verdict:stop",
      "setMode:linked:null",
      "state:stopping:req-1:idleOnly=false",
      "stop:force:detached",
      ...QUITTING_TAIL,
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
      "verdict:stop",
      "state:stopping:req-1:idleOnly=true",
      "stop:if-idle:detached",
      "prompt:ask:busy-retry",
      "verdict:stop",
      "state:stopping:req-2:idleOnly=false",
      "stop:force:detached",
      ...QUITTING_TAIL,
      "state:quitting:req-2",
      "authorize",
    ]);
  });

  it("stop then busy then Keep on the retry: verdicts stop then keep, one if-idle stop only", async () => {
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
    expect(verdicts).toEqual(["verdict:stop", "verdict:keep"]);
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
    expect(rig.states[1]).toEqual({
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
});

describe("stop-if-idle busy round naming and force (Q-SII-COPY)", () => {
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

describe("stopping event idleOnly (Q-SII-COPY)", () => {
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

  it("remember sets the mode to linked after the verdict", async () => {
    const rig = buildRig(scenario({ mode: "background", stops: [FORCE_STOP] }));
    trayQuit(rig, true);
    await flush();
    const verdictAt = rig.events.indexOf("verdict:stop");
    const modeAt = rig.events.indexOf("setMode:linked:null");
    expect(verdictAt).toBeGreaterThan(-1);
    expect(modeAt).toBeGreaterThan(verdictAt);
    expect(rig.events.indexOf("stop:force:detached")).toBeGreaterThan(modeAt);
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
      reasons.push(
        rig.events[0] === "verdict:handoff" ? "update-install" : "user",
      );
    }
    expect(reasons).toEqual(["user", "update-install"]);
  });
});

// Q4: the stopping phase's tray indicator and the delayed reveal, by call
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
