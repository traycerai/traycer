import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { AccountOrders } from "@/lib/auth/verified-account-orders";

export const TERMINAL_SANDBOX_STATES: ReadonlySet<SandboxSummary["state"]> =
  new Set(["failed", "destroying", "destroyed"]);

export interface ClaimedSandboxRow {
  readonly row: SandboxSummary | null;
  readonly order: number;
  readonly sentAt: number;
  readonly source: "exact" | "list";
}

interface ExactRequest {
  readonly order: number;
  readonly probe: boolean;
}

type Rest = "active" | "legacy-passive" | "access-lost";

export interface ClaimedSandboxEvidence {
  readonly sandboxId: string;
  readonly hostId: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly boundary: number;
  readonly liveRoute: boolean;
  readonly routeWasUnavailable: boolean;
  readonly bootstrap: "unneeded" | "ready" | "pending" | "done";
  readonly rest: Rest;
  readonly lossFence: number;
  readonly verifyAfter: number;
  readonly exact: ExactRequest | null;
  readonly exactAnswer: ClaimedSandboxRow | null;
  readonly probeAnswer: ClaimedSandboxRow | null;
  readonly list: "waiting" | "pending" | "settled";
  readonly listRevision: number;
  readonly readAtListRevision: number;
  readonly listAnswer: ClaimedSandboxRow | null;
  readonly terminal: ClaimedSandboxRow | null;
  readonly account: AccountOrders;
  readonly retired: boolean;
}

export function initialClaimedSandboxEvidence(input: {
  readonly sandboxId: string;
  readonly hostId: string;
  readonly userId: string;
  readonly teamId: string | null;
  readonly liveRoute: boolean;
  readonly boundary: number;
}): ClaimedSandboxEvidence {
  return {
    ...input,
    routeWasUnavailable: !input.liveRoute,
    bootstrap: input.liveRoute ? "unneeded" : "ready",
    rest: "active",
    lossFence: 0,
    verifyAfter: 0,
    exact: null,
    exactAnswer: null,
    probeAnswer: null,
    list: "waiting",
    listRevision: 0,
    readAtListRevision: -1,
    listAnswer: null,
    terminal: null,
    account: { pending: [], verdict: null },
    retired: false,
  };
}

export type ClaimedSandboxEvent =
  | { readonly kind: "retire" }
  | { readonly kind: "route"; readonly live: boolean }
  | { readonly kind: "boundary"; readonly at: number }
  | { readonly kind: "account"; readonly account: AccountOrders }
  | { readonly kind: "bootstrap-start" }
  | {
      readonly kind: "bootstrap-result";
      readonly row: ClaimedSandboxRow | null;
    }
  | { readonly kind: "list-start" }
  | { readonly kind: "list-result"; readonly row: ClaimedSandboxRow | null }
  | { readonly kind: "exact-start"; readonly request: ExactRequest }
  | {
      readonly kind: "exact-result";
      readonly order: number;
      readonly finished: number;
      readonly outcome: ClaimedSandboxExactOutcome;
    };

export type ClaimedSandboxExactOutcome =
  | { readonly kind: "row"; readonly row: ClaimedSandboxRow }
  | { readonly kind: "lost"; readonly witness: "exact" | "account" }
  | { readonly kind: "legacy-passive" }
  | { readonly kind: "inconclusive" };

export interface ClaimedSandboxDecision {
  readonly state: ClaimedSandboxEvidence;
  readonly row: ClaimedSandboxRow | null;
  readonly passive: boolean;
  readonly observeList: boolean;
  readonly awaitingEvidence: boolean;
  readonly read: "bootstrap" | "exact" | "probe" | null;
}

function eligibleRow(
  state: ClaimedSandboxEvidence,
  evidence: ClaimedSandboxRow | null,
): evidence is ClaimedSandboxRow {
  if (
    evidence === null ||
    evidence.order <= state.lossFence ||
    evidence.sentAt < state.boundary ||
    (evidence.source === "list" && evidence.sentAt === state.boundary)
  )
    return false;
  return evidence.row === null
    ? evidence.source === "exact"
    : evidence.row.id === state.sandboxId &&
        evidence.row.hostId === state.hostId;
}

function endEvidence(evidence: ClaimedSandboxRow): boolean {
  return (
    evidence.row === null || TERMINAL_SANDBOX_STATES.has(evidence.row.state)
  );
}

function acceptList(
  state: ClaimedSandboxEvidence,
  evidence: ClaimedSandboxRow | null,
): ClaimedSandboxEvidence {
  const row = eligibleRow(state, evidence) ? evidence : null;
  return {
    ...state,
    list: "settled",
    listRevision: state.listRevision + 1,
    listAnswer: newestListRow(state, row),
    terminal: row !== null && endEvidence(row) ? row : state.terminal,
  };
}

function newestListRow(
  state: ClaimedSandboxEvidence,
  row: ClaimedSandboxRow | null,
): ClaimedSandboxRow | null {
  const previous = state.listAnswer;
  return row !== null &&
    eligibleRow(state, previous) &&
    previous.order > row.order
    ? previous
    : row;
}

function settleBootstrap(
  state: ClaimedSandboxEvidence,
  evidence: ClaimedSandboxRow | null,
): ClaimedSandboxEvidence {
  const next: ClaimedSandboxEvidence = {
    ...state,
    bootstrap: "done",
    list: state.list === "waiting" ? "settled" : state.list,
  };
  if (!eligibleRow(state, evidence)) return next;
  return {
    ...next,
    listAnswer: newestListRow(state, evidence),
    terminal: endEvidence(evidence) ? evidence : state.terminal,
  };
}

function accessLost(
  state: ClaimedSandboxEvidence,
  fence: number,
  verifyAfter: number,
): ClaimedSandboxEvidence {
  return {
    ...state,
    rest: "access-lost",
    lossFence: fence,
    verifyAfter,
    exactAnswer: null,
    probeAnswer: null,
    listAnswer:
      state.listAnswer && state.listAnswer.order > fence
        ? state.listAnswer
        : null,
    terminal:
      state.terminal && state.terminal.order > fence ? state.terminal : null,
  };
}

function settleExact(
  state: ClaimedSandboxEvidence,
  event: Extract<ClaimedSandboxEvent, { kind: "exact-result" }>,
): ClaimedSandboxEvidence {
  if (state.exact?.order !== event.order) return state;
  const { exact } = state;
  const next = { ...state, exact: null };
  const { outcome } = event;
  switch (outcome.kind) {
    case "lost":
      return accessLost(
        next,
        event.finished,
        exact.probe || outcome.witness === "account"
          ? event.finished
          : event.order,
      );
    case "legacy-passive":
      return { ...next, rest: "legacy-passive", exactAnswer: null };
    case "inconclusive":
      return exact.probe
        ? { ...next, verifyAfter: event.finished }
        : { ...next, exactAnswer: null };
    case "row":
      if (!eligibleRow(state, outcome.row)) return next;
      if (endEvidence(outcome.row)) return { ...next, terminal: outcome.row };
      return exact.probe
        ? { ...next, verifyAfter: event.finished, probeAnswer: outcome.row }
        : { ...next, rest: "active", exactAnswer: outcome.row };
  }
}

function observeClaimRoute(
  state: ClaimedSandboxEvidence,
  live: boolean,
): ClaimedSandboxEvidence {
  if (live === state.liveRoute) return state;
  return {
    ...state,
    liveRoute: live,
    routeWasUnavailable: state.routeWasUnavailable || !live,
    rest:
      live && state.routeWasUnavailable && state.rest === "legacy-passive"
        ? "active"
        : state.rest,
    readAtListRevision: live ? -1 : state.readAtListRevision,
  };
}

function recordEvent(
  state: ClaimedSandboxEvidence,
  event: ClaimedSandboxEvent,
): ClaimedSandboxEvidence {
  switch (event.kind) {
    case "retire":
      return { ...state, retired: true };
    case "route":
      return observeClaimRoute(state, event.live);
    case "boundary":
      if (event.at === state.boundary) return state;
      return { ...state, boundary: event.at, readAtListRevision: -1 };
    case "account":
      return state.account === event.account
        ? state
        : { ...state, account: event.account };
    case "bootstrap-start":
      return { ...state, bootstrap: "pending" };
    case "bootstrap-result":
      return settleBootstrap(state, event.row);
    case "list-start":
      return state.list === "pending" ? state : { ...state, list: "pending" };
    case "list-result":
      return acceptList(state, event.row);
    case "exact-start":
      return {
        ...state,
        exact: event.request,
        readAtListRevision: state.listRevision,
      };
    case "exact-result":
      return settleExact(state, event);
  }
}

function verdictAfter(
  state: ClaimedSandboxEvidence,
  order: number,
): boolean | undefined {
  const { verdict } = state.account;
  return state.teamId !== null &&
    verdict?.userId === state.userId &&
    verdict.dispatched > order
    ? verdict.teamIds.includes(state.teamId)
    : undefined;
}

function laterVerificationPending(
  state: ClaimedSandboxEvidence,
  after: number,
): boolean {
  return state.account.pending.some((order) => order > after);
}

function settleLiveProbe(
  state: ClaimedSandboxEvidence,
): ClaimedSandboxEvidence {
  const answer = state.probeAnswer;
  if (answer === null || laterVerificationPending(state, answer.order))
    return state;
  if (
    verdictAfter(state, answer.order) === false &&
    state.account.verdict !== null
  ) {
    const fence = state.account.verdict.verified;
    return accessLost(state, fence, fence);
  }
  return { ...state, exactAnswer: answer, probeAnswer: null, rest: "active" };
}

function selectLiveRow(
  state: ClaimedSandboxEvidence,
): ClaimedSandboxRow | null {
  if (
    state.exact !== null ||
    state.probeAnswer !== null ||
    state.bootstrap === "pending" ||
    state.list === "pending"
  )
    return null;
  const listed = eligibleRow(state, state.listAnswer) ? state.listAnswer : null;
  const exact = eligibleRow(state, state.exactAnswer)
    ? state.exactAnswer
    : null;
  return (listed?.order ?? 0) > (exact?.order ?? 0) ? listed : exact;
}

/** Resolves all sandbox evidence for the current dispatch before the driver acts. */
export function reduceClaimedSandboxEvidence(
  previous: ClaimedSandboxEvidence,
  event: ClaimedSandboxEvent,
): ClaimedSandboxDecision {
  let state = previous.retired ? previous : recordEvent(previous, event);
  if (state.retired)
    return {
      state,
      row: null,
      passive: true,
      observeList: false,
      awaitingEvidence: false,
      read: null,
    };
  state = settleLiveProbe(state);
  if (
    state.exact === null &&
    state.probeAnswer === null &&
    eligibleRow(state, state.terminal)
  )
    return {
      state: state.terminal.source === "list" ? admitExternalRow(state) : state,
      row: state.terminal,
      passive: false,
      observeList: false,
      awaitingEvidence: false,
      read: null,
    };
  const row = selectLiveRow(state);
  if (row?.source === "list") state = admitExternalRow(state);
  const passive = state.rest !== "active";
  const observeList = !passive && (state.liveRoute || row !== null);
  const read = nextClaimRead(state, row);
  return {
    state,
    row,
    passive,
    observeList,
    read,
    awaitingEvidence:
      state.exact !== null ||
      state.probeAnswer !== null ||
      state.list === "pending" ||
      state.bootstrap === "pending" ||
      read !== null,
  };
}

function admitExternalRow(
  state: ClaimedSandboxEvidence,
): ClaimedSandboxEvidence {
  if (state.rest === "active" && state.bootstrap !== "ready") return state;
  return {
    ...state,
    rest: "active",
    bootstrap: state.bootstrap === "ready" ? "done" : state.bootstrap,
    verifyAfter: 0,
    readAtListRevision: -1,
  };
}

function nextClaimRead(
  state: ClaimedSandboxEvidence,
  row: ClaimedSandboxRow | null,
): ClaimedSandboxDecision["read"] {
  if (
    state.exact !== null ||
    state.probeAnswer !== null ||
    state.bootstrap === "pending"
  )
    return null;
  if (state.bootstrap === "ready" && row === null) return "bootstrap";
  if (state.rest === "access-lost")
    return authorizedProbe(state) ? "probe" : null;
  return needsOrdinaryExact(state, row) ? "exact" : null;
}

function needsOrdinaryExact(
  state: ClaimedSandboxEvidence,
  row: ClaimedSandboxRow | null,
): boolean {
  if (
    state.rest === "legacy-passive" ||
    row?.source === "list" ||
    (state.list !== "settled" &&
      (state.liveRoute || state.bootstrap !== "done"))
  )
    return false;
  return (
    state.readAtListRevision !== state.listRevision &&
    (state.liveRoute || row !== null || state.readAtListRevision === -1)
  );
}

function authorizedProbe(state: ClaimedSandboxEvidence): boolean {
  const { verdict } = state.account;
  return (
    verdictAfter(state, state.verifyAfter) === true &&
    verdict !== null &&
    !laterVerificationPending(state, verdict.dispatched)
  );
}
