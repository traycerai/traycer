/** Durable intent and its current blocker are separate: repair never changes identity. */
export type PendingSendPhase =
  | "staged"
  | "unconfirmed"
  | "waiting"
  | "sending"
  | "uncertain"
  | "accepted"
  | "delivered"
  | "ended"
  | "cancelled"
  | "returned";
export type PendingSendBlocker =
  | "none"
  | "host"
  | "credits"
  | "settings"
  | "client"
  | "model"
  | "provider"
  | "not-sent"
  | "stop"
  | "wake";
export interface PendingSendState {
  readonly kind: "chat" | "fork" | "terminal";
  readonly phase: PendingSendPhase;
  readonly blocker: PendingSendBlocker;
}
export type PendingSendEvent =
  | "observe"
  | "confirm"
  | "prepare"
  | "prepared"
  | "claim-saved"
  | "claim-write-failed"
  | "host-accept"
  | "receipt-saved"
  | "receipt-write-failed"
  | "known-refusal"
  | "transport-fail"
  | "cancel"
  | "choose"
  | "stop"
  | "stop-result"
  | "stop-failed"
  | "return"
  | "retry"
  | "rest"
  | "terminal-row"
  | "awake"
  | "frozen"
  | "settings"
  | "unfrozen"
  | "settings-repaired"
  | "agent-ready"
  | "agent-not-ready"
  | "provider-signed-in"
  | "prepare-failed"
  | "wake-failed"
  | "epic-create-failed"
  | "task-deleted"
  | "access-lost"
  | "account-away"
  | "account-back"
  | "reload"
  | "storage-changed"
  | "locks-unavailable"
  | "null-client"
  | "stage-change"
  | "handoff"
  | "late-accept"
  | "remove"
  | "stage-lost"
  | "task-interrupted"
  | "terminal-opened"
  | "client-restored"
  | "recovery-complete"
  | "disposition-persisted"
  | "dialog-close"
  | "attach-ok"
  | "attach-failed"
  | "attach-unsupported";
export interface PendingSendFacts {
  readonly current: boolean;
  readonly accountActive: boolean;
  readonly owns: boolean;
  readonly exclusive: boolean;
  readonly origin: boolean;
  readonly durableClaim: boolean;
  readonly terminalDisposition: boolean;
  readonly host: "unknown" | "awake" | "resting" | "waking" | "ended";
  readonly frozen: boolean;
  readonly settingsReady: boolean;
  readonly clientReady: boolean;
  readonly agentReady: boolean;
  readonly modelReady: boolean;
  readonly modelUnavailable: boolean;
  readonly stageCurrent: boolean;
  readonly inFlight: boolean;
  readonly attachPending: boolean;
  readonly wakeInFlight: boolean;
  readonly epicConfirmed: boolean;
  readonly stageStatus: "missing" | "staged" | "creating" | "handoff";
}
/** Missing observations grant no authority and authorize no network operation. */
export const UNKNOWN_PENDING_SEND_FACTS: PendingSendFacts = {
  current: false,
  accountActive: false,
  owns: false,
  exclusive: false,
  origin: false,
  durableClaim: false,
  terminalDisposition: false,
  host: "unknown",
  frozen: false,
  settingsReady: false,
  clientReady: false,
  agentReady: false,
  modelReady: false,
  modelUnavailable: false,
  stageCurrent: false,
  inFlight: false,
  attachPending: false,
  wakeInFlight: false,
  epicConfirmed: false,
  stageStatus: "missing",
};
export type PendingSendEffect =
  | "confirm-epic"
  | "prepare"
  | "persist-claim"
  | "dispatch"
  | "record-receipt"
  | "finish-ui"
  | "retry"
  | "known-refusal"
  | "uncertain"
  | "wake"
  | "poll"
  | "end-host"
  | "return-message"
  | "remove"
  | "stop-host"
  | "hold-stop"
  | "fetch-model"
  | "report-provider"
  | "report-not-sent"
  | "handoff"
  | "run-stage"
  | "open-terminal"
  | "rehydrate";
export interface PendingSendView {
  readonly line:
    | "hidden"
    | "waiting"
    | "creating"
    | "uncertain"
    | "credits"
    | "settings"
    | "not-sent"
    | "model"
    | "provider"
    | "delivered";
  readonly canWithdraw: boolean;
  readonly canRetry: boolean;
  readonly canRetarget: boolean;
  readonly fetchModels: boolean;
}
export interface PendingSendTransition {
  readonly state: PendingSendState;
  readonly effects: readonly PendingSendEffect[];
  readonly view: PendingSendView;
  readonly outcome:
    | "applied"
    | "ignored"
    | "denied-claim"
    | "denied-ownership"
    | "unreachable";
}

interface PendingSendRecord {
  readonly request: { readonly kind: PendingSendState["kind"] };
  readonly epicConfirmed: boolean;
  readonly delivery: object | null;
  readonly dispatch?: {
    readonly status: "sending" | "uncertain";
    readonly blocker?: PendingSendBlocker;
  } | null;
  readonly ended?: boolean;
}

/** Legacy records derive their phase from the same receipt/claim fields. */
export function pendingSendState(
  record: PendingSendRecord,
  blocker: PendingSendBlocker,
): PendingSendState {
  let phase: PendingSendPhase = record.epicConfirmed
    ? "waiting"
    : "unconfirmed";
  if (record.delivery !== null) phase = "delivered";
  else if (record.ended === true) phase = "ended";
  else if (record.dispatch !== undefined && record.dispatch !== null)
    phase = record.dispatch.status;
  return {
    kind: record.request.kind,
    phase,
    blocker: record.dispatch?.blocker ?? blocker,
  };
}

const CLOSED_PHASES = new Set<PendingSendPhase>([
  "delivered",
  "cancelled",
  "returned",
]);
const WITHDRAW_EVENTS = new Set<PendingSendEvent>([
  "cancel",
  "choose",
  "stop",
  "return",
  "remove",
]);
const HANDOFF_EVENTS = new Set<PendingSendEvent>([
  "handoff",
  "attach-ok",
  "attach-unsupported",
]);
const REFRESH_EVENTS = new Set<PendingSendEvent>([
  "reload",
  "account-back",
  "storage-changed",
]);
const STOP_OBSERVATIONS = new Set<PendingSendEvent>([
  "reload",
  "account-back",
  "storage-changed",
  "observe",
  "stop-result",
  "awake",
  "rest",
  "unfrozen",
  "settings-repaired",
  "agent-ready",
  "agent-not-ready",
  "frozen",
  "settings",
  "null-client",
  "client-restored",
]);
const REQUEST_EVENTS = new Set<PendingSendEvent>([
  "host-accept",
  "receipt-saved",
  "receipt-write-failed",
  "known-refusal",
  "transport-fail",
]);
const LATCHED_BLOCKERS = new Set<PendingSendBlocker>([
  "credits",
  "settings",
  "not-sent",
  "wake",
]);

function claimed(state: PendingSendState): boolean {
  return (
    state.phase === "sending" ||
    state.phase === "uncertain" ||
    state.phase === "accepted"
  );
}

function withdrawalAllowed(
  state: PendingSendState,
  facts: PendingSendFacts,
): boolean {
  if (
    !facts.current ||
    !facts.accountActive ||
    !facts.owns ||
    facts.durableClaim ||
    claimed(state)
  )
    return false;
  if (state.phase === "ended") return true;
  if (state.phase === "unconfirmed") return facts.origin || facts.exclusive;
  return state.phase === "waiting" && facts.exclusive;
}

function visibleLine(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendView["line"] {
  if (
    !facts.accountActive ||
    state.phase === "cancelled" ||
    state.phase === "returned"
  )
    return "hidden";
  if (state.phase === "delivered") return "delivered";
  if (
    state.blocker === "credits" ||
    state.blocker === "settings" ||
    state.blocker === "model" ||
    state.blocker === "provider"
  )
    return state.blocker;
  if (state.blocker === "not-sent" || state.blocker === "wake")
    return "not-sent";
  if (state.phase === "uncertain" || state.blocker === "client")
    return "uncertain";
  return state.phase === "sending" && facts.host === "awake"
    ? "creating"
    : "waiting";
}

function result(
  state: PendingSendState,
  effects: readonly PendingSendEffect[],
  facts: PendingSendFacts,
): PendingSendTransition {
  return {
    state,
    effects,
    outcome: effects.length > 0 ? "applied" : "ignored",
    view: {
      line: visibleLine(state, facts),
      canWithdraw: withdrawalAllowed(state, facts),
      canRetry:
        facts.accountActive &&
        facts.current &&
        !facts.inFlight &&
        (state.phase === "uncertain" || LATCHED_BLOCKERS.has(state.blocker)),
      canRetarget: !facts.attachPending && !facts.inFlight && !claimed(state),
      fetchModels:
        state.kind !== "terminal" &&
        state.phase === "waiting" &&
        facts.accountActive &&
        facts.clientReady &&
        !facts.modelReady,
    },
  };
}

function unreachable(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  return { ...result(state, [], facts), outcome: "unreachable" };
}

function withdraw(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (!withdrawalAllowed(state, facts))
    return {
      ...result(state, [], facts),
      outcome:
        claimed(state) || facts.durableClaim
          ? "denied-claim"
          : "denied-ownership",
    };
  const next: PendingSendState = {
    ...state,
    phase: state.kind === "chat" ? "returned" : "cancelled",
    blocker: "none",
  };
  const effects: PendingSendEffect[] = [];
  if (state.kind === "chat") effects.push("return-message");
  effects.push("remove");
  return result(next, effects, facts);
}

/** Only a matching durable request can finish after its owner leaves the account. */
function requestOutcome(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition | null {
  if (state.phase === "accepted") {
    if (event === "receipt-saved")
      return result(
        { ...state, phase: "delivered", blocker: "none" },
        facts.accountActive && facts.owns ? ["finish-ui"] : [],
        facts,
      );
    if (event === "receipt-write-failed")
      return result(
        { ...state, phase: "uncertain", blocker: "none" },
        ["uncertain"],
        facts,
      );
    return null;
  }
  if (!claimed(state) || !facts.durableClaim) return null;
  if (event === "host-accept" || event === "late-accept")
    return result(
      { ...state, phase: "accepted", blocker: "none" },
      ["record-receipt"],
      facts,
    );
  if (event === "known-refusal")
    return result(
      { ...state, phase: "waiting", blocker: "not-sent" },
      facts.accountActive && facts.owns
        ? ["known-refusal", "report-not-sent"]
        : ["known-refusal"],
      facts,
    );
  if (event === "transport-fail")
    return state.phase === "sending"
      ? result({ ...state, phase: "uncertain" }, ["uncertain"], facts)
      : result(state, [], facts);
  return null;
}

/** Birth is fenced by both the captured account and the captured stage. */
function stagedTransition(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (HANDOFF_EVENTS.has(event)) {
    if (!facts.stageCurrent || facts.attachPending)
      return result(state, [], facts);
    return result(
      {
        ...state,
        phase: facts.epicConfirmed ? "waiting" : "unconfirmed",
        blocker: facts.epicConfirmed ? "host" : "none",
      },
      ["handoff"],
      facts,
    );
  }
  if (
    event === "stage-change" ||
    event === "attach-failed" ||
    event === "dialog-close" ||
    event === "late-accept" ||
    event === "observe"
  )
    return result(state, [], facts);
  return unreachable(state, facts);
}

/** A persisted terminal disposition is recoverable without a native lock. */
function endedTransition(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (event === "recovery-complete")
    return result(
      { ...state, phase: state.kind === "chat" ? "returned" : "cancelled" },
      ["remove"],
      facts,
    );
  if (
    WITHDRAW_EVENTS.has(event) ||
    REFRESH_EVENTS.has(event) ||
    event === "retry" ||
    event === "terminal-row" ||
    event === "disposition-persisted" ||
    event === "observe"
  )
    return withdraw(state, facts);
  return result(state, [], facts);
}

function terminalObservation(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (facts.host !== "ended") return result(state, [], facts);
  return result(
    { ...state, phase: "ended", blocker: "none" },
    ["end-host"],
    facts,
  );
}

function missingClient(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (state.phase === "waiting")
    return LATCHED_BLOCKERS.has(state.blocker)
      ? result(state, [], facts)
      : result({ ...state, blocker: "host" }, ["poll"], facts);
  const blocker = LATCHED_BLOCKERS.has(state.blocker)
    ? state.blocker
    : "client";
  const effects: PendingSendEffect[] =
    state.phase === "uncertain" && state.blocker === blocker
      ? ["poll"]
      : ["uncertain", "poll"];
  return result({ ...state, phase: "uncertain", blocker }, effects, facts);
}

function readyHost(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (claimed(state)) {
    const effects: PendingSendEffect[] = ["poll"];
    if (state.phase === "sending" && facts.durableClaim && !facts.inFlight)
      effects.push("dispatch");
    return result({ ...state, blocker: "none" }, effects, facts);
  }
  if (state.kind === "terminal")
    return result({ ...state, blocker: "none" }, ["open-terminal"], facts);
  if (!facts.agentReady)
    return result(
      { ...state, blocker: "provider" },
      ["report-provider", "poll"],
      facts,
    );
  if (!facts.modelReady)
    return facts.modelUnavailable
      ? result(
          { ...state, blocker: "not-sent" },
          ["report-not-sent", "poll"],
          facts,
        )
      : result({ ...state, blocker: "model" }, ["fetch-model", "poll"], facts);
  return result({ ...state, blocker: "none" }, ["prepare"], facts);
}

/** Evaluate row facts only for the original account, never a stale list's event label. */
function observe(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (facts.host === "ended") return terminalObservation(state, facts);
  if (state.phase === "unconfirmed") return result(state, [], facts);
  if (state.blocker === "stop")
    return facts.host === "resting"
      ? withdraw(state, facts)
      : result(state, ["poll"], facts);
  if (facts.frozen)
    return result({ ...state, blocker: "credits" }, ["poll"], facts);
  if (state.blocker === "credits" || state.blocker === "settings")
    return result(state, ["poll"], facts);
  if (facts.host === "awake" && !facts.settingsReady)
    return result({ ...state, blocker: "settings" }, ["poll"], facts);
  if (state.blocker === "wake" || state.blocker === "not-sent")
    return result(state, ["poll"], facts);
  if (
    state.phase === "waiting" &&
    (facts.stageStatus === "staged" || facts.stageStatus === "creating")
  )
    return result(
      state,
      facts.wakeInFlight ? ["poll"] : ["run-stage", "poll"],
      facts,
    );
  return reachableHost(state, facts);
}

/** Reaching a live host can wake, poll or replay; it cannot erase a latched blocker. */
function reachableHost(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (facts.host === "resting") {
    const effects: PendingSendEffect[] = ["poll"];
    if (
      !facts.wakeInFlight &&
      !facts.inFlight &&
      (state.phase === "waiting" || state.phase === "sending")
    )
      effects.push("wake");
    const blocker = state.blocker === "client" ? "client" : "host";
    return result({ ...state, blocker }, effects, facts);
  }
  if (!facts.clientReady && claimed(state)) return missingClient(state, facts);
  if (facts.host !== "awake" || !facts.clientReady)
    return result({ ...state, blocker: "host" }, ["poll"], facts);
  if (state.phase === "uncertain" && state.blocker === "client")
    return result(state, ["poll"], facts);
  return readyHost(state, facts);
}

function refresh(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (state.phase === "unconfirmed") return result(state, [], facts);
  if (
    state.phase === "waiting" &&
    !LATCHED_BLOCKERS.has(state.blocker) &&
    (facts.stageStatus === "staged" || facts.stageStatus === "creating")
  )
    return result(
      state,
      facts.wakeInFlight ? ["poll"] : ["run-stage", "poll"],
      facts,
    );
  const blocker =
    state.phase === "waiting" &&
    (state.blocker === "not-sent" || state.blocker === "wake")
      ? state.blocker
      : "host";
  return result({ ...state, blocker }, ["poll"], facts);
}

function retry(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (
    state.phase === "unconfirmed" ||
    state.blocker === "stop" ||
    facts.inFlight ||
    (state.phase === "waiting" && !LATCHED_BLOCKERS.has(state.blocker))
  )
    return result(state, [], facts);
  const next: PendingSendState = {
    ...state,
    phase: claimed(state) ? "sending" : state.phase,
    blocker:
      state.blocker === "credits" || state.blocker === "settings"
        ? state.blocker
        : "none",
  };
  // Retry requests a new model read; the previous negative cache entry cannot
  // refuse that read before it starts. All earlier readiness gates still apply.
  const plan = observe(next, { ...facts, modelUnavailable: false });
  return result(plan.state, ["retry", ...plan.effects], facts);
}

function readinessEvent(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (event === "frozen")
    return result({ ...state, blocker: "credits" }, ["poll"], facts);
  if (event === "settings")
    return result(
      {
        ...state,
        blocker: state.blocker === "credits" ? "credits" : "settings",
      },
      ["poll"],
      facts,
    );
  if (event === "unfrozen" && state.blocker === "credits")
    return observe({ ...state, blocker: "none" }, facts);
  if (event === "settings-repaired" && state.blocker === "settings")
    return observe({ ...state, blocker: "none" }, facts);
  if (event === "null-client") return missingClient(state, facts);
  if (event === "client-restored" && state.blocker === "client")
    return result({ ...state, blocker: "none" }, ["poll"], facts);
  if (event === "rest" || event === "awake") return observe(state, facts);
  if (state.phase !== "waiting") return result(state, [], facts);
  return waitingReadiness(state, event, facts);
}

function waitingReadiness(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (event === "agent-ready" || event === "agent-not-ready")
    return observe(state, facts);

  return result(state, [], facts);
}

function preparationEvent(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (
    state.phase !== "waiting" ||
    state.blocker !== "none" ||
    state.kind === "terminal"
  )
    return result(state, [], facts);
  if (event === "prepared")
    return result(
      state,
      facts.modelReady && facts.stageCurrent ? ["persist-claim"] : [],
      facts,
    );
  if (event === "prepare-failed" || event === "claim-write-failed")
    return result(
      { ...state, blocker: "not-sent" },
      ["report-not-sent"],
      facts,
    );
  if (event === "claim-saved" && facts.durableClaim)
    return observe({ ...state, phase: "sending" }, facts);
  return result(state, [], facts);
}

function unconfirmedTransition(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (event === "confirm")
    return result(
      { ...state, phase: "waiting", blocker: "host" },
      ["confirm-epic"],
      facts,
    );
  if (REFRESH_EVENTS.has(event) && !facts.origin) return withdraw(state, facts);
  if (
    event === "stage-lost" ||
    event === "task-interrupted" ||
    event === "epic-create-failed" ||
    event === "task-deleted"
  )
    return withdraw(state, facts);
  if (
    REQUEST_EVENTS.has(event) ||
    event === "prepared" ||
    event === "prepare-failed" ||
    event === "claim-saved" ||
    event === "claim-write-failed"
  )
    return unreachable(state, facts);
  return result(state, [], facts);
}

function activeTransition(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (event === "stop") return requestStop(state, facts);
  if (WITHDRAW_EVENTS.has(event)) return withdraw(state, facts);
  if (state.phase === "ended") return endedTransition(state, event, facts);
  if (state.phase === "waiting" && state.blocker === "stop")
    return stoppingTransition(state, event, facts);
  if (event === "terminal-row" || event === "access-lost")
    return terminalObservation(state, facts);
  if (state.phase === "unconfirmed")
    return unconfirmedTransition(state, event, facts);
  if (REFRESH_EVENTS.has(event)) return refresh(state, facts);
  if (
    event === "observe" ||
    event === "prepare" ||
    event === "provider-signed-in"
  )
    return observe(state, facts);
  if (event === "retry") return retry(state, facts);
  return taskEvent(state, event, facts);
}

/** The request holds its copy until the stop result or fresh row proves rest. */
function requestStop(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  const permission = withdraw(state, facts);
  if (permission.outcome !== "applied" || state.phase !== "waiting")
    return permission;
  if (facts.inFlight) return result(state, ["poll"], facts);
  return result(
    { ...state, blocker: "stop" },
    ["hold-stop", "stop-host"],
    facts,
  );
}

/** Repair notifications cannot erase a stop intent persisted with the stage. */
function stoppingTransition(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (event === "task-deleted") return taskEvent(state, event, facts);
  if (event === "stage-lost") return withdraw(state, facts);
  if (event === "retry") return result(state, [], facts);
  if (event === "stop-failed") return result(state, ["poll"], facts);
  if (
    event === "stop-result" &&
    (facts.host === "resting" || facts.host === "ended")
  )
    return withdraw(state, facts);
  if (event === "terminal-row" || event === "access-lost")
    return terminalObservation(state, facts);
  if (STOP_OBSERVATIONS.has(event)) return observe(state, facts);
  if (REQUEST_EVENTS.has(event)) return unreachable(state, facts);
  return result(state, [], facts);
}

/** Task disappearance and terminal completion are independent of host readiness. */
function taskEvent(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (event === "task-deleted")
    return result(
      { ...state, phase: "ended", blocker: "none" },
      ["end-host"],
      facts,
    );
  if (event === "stage-lost" && state.phase === "waiting")
    return withdraw(state, facts);
  if (
    event === "terminal-opened" &&
    state.kind === "terminal" &&
    state.phase === "waiting"
  )
    return result({ ...state, phase: "delivered" }, ["remove"], facts);
  return activeSignal(state, event, facts);
}

function activeSignal(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (REQUEST_EVENTS.has(event)) return unreachable(state, facts);
  if (event === "late-accept") return result(state, [], facts);
  if (event === "wake-failed") {
    const waiting =
      state.phase === "waiting" &&
      (state.blocker === "host" ||
        state.blocker === "model" ||
        state.blocker === "provider" ||
        state.blocker === "none" ||
        state.blocker === "wake");
    const sending =
      state.phase === "sending" &&
      (state.blocker === "none" || state.blocker === "host");
    return waiting || sending
      ? result({ ...state, blocker: "wake" }, ["report-not-sent"], facts)
      : result(state, [], facts);
  }
  const preparation = preparationEvent(state, event, facts);
  if (preparation.effects.length > 0) return preparation;
  return readinessEvent(state, event, facts);
}

/** A stale window must load the terminal record before recovering its exact message. */
function staleRecord(
  state: PendingSendState,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (facts.terminalDisposition && facts.accountActive && facts.owns)
    return result(state, ["rehydrate"], facts);
  return result(state, [], facts);
}

/** Account privacy precedes refusal detail; a live claim blocks every withdrawal mode. */
function ownershipOutcome(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition | null {
  if (!facts.accountActive)
    return { ...result(state, [], facts), outcome: "denied-ownership" };
  if (facts.owns) return null;
  const blockedByClaim =
    WITHDRAW_EVENTS.has(event) && (claimed(state) || facts.durableClaim);
  return {
    ...result(state, [], facts),
    outcome: blockedByClaim ? "denied-claim" : "denied-ownership",
  };
}

/** The single lifecycle policy. Adapters supply facts and execute these named effects. */
export function transitionPendingSend(
  state: PendingSendState,
  event: PendingSendEvent,
  facts: PendingSendFacts,
): PendingSendTransition {
  if (!facts.current) return staleRecord(state, facts);
  if (state.phase === "delivered" && event === "account-away")
    return result(state, ["remove"], facts);
  if (CLOSED_PHASES.has(state.phase)) return result(state, [], facts);
  const bookkeeping = requestOutcome(state, event, facts);
  if (bookkeeping !== null) return bookkeeping;
  if (event === "account-away") return result(state, [], facts);
  const ownership = ownershipOutcome(state, event, facts);
  if (ownership !== null) return ownership;
  if (state.phase === "staged") return stagedTransition(state, event, facts);
  if (state.phase === "accepted")
    return WITHDRAW_EVENTS.has(event)
      ? withdraw(state, facts)
      : result(state, [], facts);
  if (
    facts.durableClaim &&
    !claimed(state) &&
    event !== "claim-saved" &&
    state.phase !== "ended"
  )
    return { ...result(state, ["rehydrate"], facts), outcome: "denied-claim" };
  return activeTransition(state, event, facts);
}
