import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { StagedSandbox } from "@/stores/composer/staged-sandbox-store";
import type { SandboxRowScope } from "@/lib/sandboxes/sandbox-row-read";
import type { AccountOrders } from "@/lib/auth/verified-account-orders";

/** A retained stage can witness a legacy claim only on its original Send surface. */
export function claimedSandboxScope(
  stored: SandboxRowScope | undefined,
  stage: StagedSandbox | null,
  sandboxId: string,
  hostId: string,
): SandboxRowScope | null {
  if (stored !== undefined) return stored;
  if (
    stage?.phase !== "handoff" ||
    stage.createdSandboxId !== sandboxId ||
    stage.createdHostId !== hostId
  )
    return null;
  const configuration = stage.target.configuration;
  return configuration.kind === "team"
    ? { kind: "team", teamId: configuration.teamId }
    : { kind: "personal" };
}

export const TERMINAL_SANDBOX_STATES: ReadonlySet<SandboxSummary["state"]> =
  new Set(["failed", "destroying", "destroyed"]);

export interface ClaimedSandboxRow {
  readonly row: SandboxSummary | null;
  readonly order: number;
  readonly sentAt: number;
  readonly source: "exact" | "list";
}

interface ListAnswer {
  readonly order: number;
  readonly sentAt: number;
  readonly row: SandboxSummary | null;
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
  readonly personalScope: boolean;
  readonly boundary: number;
  readonly liveRoute: boolean;
  readonly routeWasUnavailable: boolean;
  readonly bootstrap: "unneeded" | "ready" | "pending" | "done";
  readonly rest: Rest;
  readonly lossFence: number;
  readonly verifyAfter: number;
  readonly exact: ExactRequest | null;
  readonly exactAnswer: ClaimedSandboxRow | null;
  readonly access: "idle" | "ready" | "pending";
  readonly refreshOwed: boolean;
  readonly displayRow: ClaimedSandboxRow | null;
  readonly probeAnswer: ClaimedSandboxRow | null;
  readonly list: "waiting" | "pending" | "settled";
  readonly listRevision: number;
  readonly readAtListRevision: number;
  readonly listAnswerOrder: number;
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
  readonly personalScope: boolean;
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
    access: "idle",
    refreshOwed: false,
    displayRow: null,
    probeAnswer: null,
    list: "waiting",
    listRevision: 0,
    readAtListRevision: -1,
    listAnswerOrder: 0,
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
      readonly answer: ListAnswer;
    }
  | { readonly kind: "list-start" }
  | { readonly kind: "list-result"; readonly answer: ListAnswer }
  | { readonly kind: "list-idle" }
  | { readonly kind: "access-start" }
  | {
      readonly kind: "access-result";
      readonly holdsTeam: boolean | undefined;
      readonly finished: number;
    }
  | { readonly kind: "exact-start"; readonly request: ExactRequest }
  | {
      readonly kind: "exact-result";
      readonly order: number;
      readonly finished: number;
      readonly outcome: ClaimedSandboxExactOutcome;
    };

export type ClaimedSandboxExactOutcome =
  | { readonly kind: "row"; readonly row: ClaimedSandboxRow }
  | {
      readonly kind: "not-found";
      readonly holdsTeam: boolean | undefined;
      readonly sentAt: number;
    }
  | { readonly kind: "inconclusive" };

export interface ClaimedSandboxDecision {
  readonly state: ClaimedSandboxEvidence;
  readonly row: ClaimedSandboxRow | null;
  readonly displayRow: ClaimedSandboxRow | null;
  readonly passive: boolean;
  readonly observeList: boolean;
  readonly awaitingEvidence: boolean;
  readonly read: "bootstrap" | "exact" | "probe" | "access" | null;
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
  answer: ListAnswer,
): ClaimedSandboxEvidence {
  const evidence: ClaimedSandboxRow = { ...answer, source: "list" };
  const row = eligibleRow(state, evidence) ? evidence : null;
  // Terminal evidence survives an omission. The newest list reply still owns
  // the current list answer, even when it returns no row.
  const terminal =
    row !== null && endEvidence(row) && row.order > (state.terminal?.order ?? 0)
      ? row
      : state.terminal;
  if (answer.order <= state.listAnswerOrder) return { ...state, terminal };
  return {
    ...state,
    listAnswerOrder: answer.order,
    listRevision: state.listRevision + 1,
    listAnswer: row,
    terminal,
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
    access: "idle",
    refreshOwed: false,
    displayRow: null,
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
    case "not-found":
      return settleMissingRow(next, exact, event.finished, outcome);
    case "inconclusive":
      return inconclusiveExact(next, exact, event.finished);
    case "row":
      if (!eligibleRow(state, outcome.row))
        return inconclusiveExact(next, exact, event.finished);
      if (endEvidence(outcome.row)) return { ...next, terminal: outcome.row };
      return exact.probe
        ? { ...next, verifyAfter: event.finished, probeAnswer: outcome.row }
        : {
            ...next,
            rest: "active",
            exactAnswer: outcome.row,
            refreshOwed: false,
          };
  }
}

function settleMissingRow(
  state: ClaimedSandboxEvidence,
  exact: ExactRequest,
  finished: number,
  outcome: Extract<ClaimedSandboxExactOutcome, { kind: "not-found" }>,
): ClaimedSandboxEvidence {
  const { holdsTeam, sentAt } = outcome;
  const evidence: ClaimedSandboxRow = {
    order: exact.order,
    sentAt,
    row: null,
    source: "exact",
  };
  if (!eligibleRow(state, evidence))
    return inconclusiveExact(state, exact, finished);
  if (state.personalScope || (state.teamId !== null && holdsTeam === true))
    return { ...state, terminal: evidence };
  if (state.teamId === null) return inconclusiveExact(state, exact, finished);
  if (holdsTeam === false)
    return accessLost(state, finished, exact.probe ? finished : exact.order);
  return exact.probe
    ? inconclusiveExact(state, exact, finished)
    : { ...state, access: "ready" };
}

function inconclusiveExact(
  state: ClaimedSandboxEvidence,
  request: ExactRequest,
  finished: number,
): ClaimedSandboxEvidence {
  return request.probe
    ? { ...state, verifyAfter: finished }
    : { ...state, refreshOwed: state.exactAnswer !== null };
}

function settleAccess(
  state: ClaimedSandboxEvidence,
  event: Extract<ClaimedSandboxEvent, { kind: "access-result" }>,
): ClaimedSandboxEvidence {
  if (state.access !== "pending") return state;
  if (event.holdsTeam === false)
    return accessLost(state, event.finished, event.finished);
  return {
    ...state,
    access: "idle",
    rest: "legacy-passive",
    refreshOwed: state.exactAnswer !== null,
  };
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
      return { ...state, account: event.account };
    case "bootstrap-start":
    case "bootstrap-result":
    case "list-start":
    case "list-result":
    case "list-idle":
      return observeClaimList(state, event);
    case "access-start":
      return state.access === "ready" ? { ...state, access: "pending" } : state;
    case "access-result":
      return settleAccess(state, event);
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

function observeClaimList(
  state: ClaimedSandboxEvidence,
  event: Extract<
    ClaimedSandboxEvent,
    {
      kind:
        | "bootstrap-start"
        | "bootstrap-result"
        | "list-start"
        | "list-result"
        | "list-idle";
    }
  >,
): ClaimedSandboxEvidence {
  switch (event.kind) {
    case "bootstrap-start":
      return { ...state, bootstrap: "pending" };
    case "bootstrap-result":
      return acceptList(
        {
          ...state,
          bootstrap: "done",
          list: state.list === "waiting" ? "settled" : state.list,
        },
        event.answer,
      );
    case "list-start":
      return state.list === "pending" ? state : { ...state, list: "pending" };
    case "list-result":
      return acceptList({ ...state, list: "settled" }, event.answer);
    case "list-idle":
      return state.list === "settled" ? state : { ...state, list: "settled" };
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
  return {
    ...state,
    exactAnswer: answer,
    probeAnswer: null,
    rest: "active",
    refreshOwed: false,
  };
}

function selectLiveRow(
  state: ClaimedSandboxEvidence,
): ClaimedSandboxRow | null {
  if (
    state.exact !== null ||
    state.access !== "idle" ||
    state.probeAnswer !== null ||
    state.bootstrap === "pending" ||
    state.list === "pending"
  )
    return null;
  const listed = eligibleRow(state, state.listAnswer) ? state.listAnswer : null;
  const exact = eligibleRow(state, state.exactAnswer)
    ? state.exactAnswer
    : null;
  if ((listed?.order ?? 0) > (exact?.order ?? 0)) return listed;
  return state.refreshOwed ? null : exact;
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
      displayRow: null,
      passive: true,
      observeList: false,
      awaitingEvidence: false,
      read: null,
    };
  state = settleLiveProbe(state);
  if (
    state.exact === null &&
    state.access === "idle" &&
    state.probeAnswer === null &&
    eligibleRow(state, state.terminal)
  )
    return {
      state: state.terminal.source === "list" ? admitExternalRow(state) : state,
      row: state.terminal,
      displayRow: state.terminal,
      passive: false,
      observeList: false,
      awaitingEvidence: false,
      read: null,
    };
  return decideActiveClaim(state);
}

function decideActiveClaim(
  state: ClaimedSandboxEvidence,
): ClaimedSandboxDecision {
  const row = selectLiveRow(state);
  if (row?.source === "list") state = admitExternalRow(state);
  if (row !== null && row !== state.displayRow)
    state = { ...state, displayRow: row };
  const passive = state.rest !== "active";
  const displayRow =
    row ?? (eligibleRow(state, state.displayRow) ? state.displayRow : null);
  const observeList = !passive && (state.liveRoute || displayRow !== null);
  const read = nextClaimRead(state, row);
  return {
    state,
    row,
    displayRow,
    passive,
    observeList,
    read,
    awaitingEvidence:
      state.exact !== null ||
      state.access !== "idle" ||
      state.refreshOwed ||
      state.probeAnswer !== null ||
      state.list === "pending" ||
      state.bootstrap === "pending" ||
      read !== null,
  };
}

function admitExternalRow(
  state: ClaimedSandboxEvidence,
): ClaimedSandboxEvidence {
  if (
    state.rest === "active" &&
    state.bootstrap !== "ready" &&
    !state.refreshOwed
  )
    return state;
  return {
    ...state,
    rest: "active",
    bootstrap: state.bootstrap === "ready" ? "done" : state.bootstrap,
    verifyAfter: 0,
    refreshOwed: false,
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
  if (state.access !== "idle")
    return state.access === "ready" ? "access" : null;
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
    (state.liveRoute ||
      row !== null ||
      state.refreshOwed ||
      state.readAtListRevision === -1)
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
