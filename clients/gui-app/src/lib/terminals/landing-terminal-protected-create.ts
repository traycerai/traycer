import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  readDraftAuthorityIssueGrant,
  settleDraftAuthorityEffect,
  type DraftAuthorityIssueReceipt,
  type DraftAuthorityOutbox,
} from "@/lib/drafts/draft-authority-pending";
import { draftAuthorityActorIsCurrent } from "@/lib/drafts/draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityMutationResult,
} from "@/lib/drafts/draft-authority-types";
import type { HostRpcRegistry } from "@/lib/host";
import { withHostMutationErrorBoundary } from "@/lib/query/host-query-error-boundary";
import {
  fetchIsolatedLegacyTerminalList,
  runSilentLegacyEpicTerminalCreate,
} from "@/lib/terminals/epic-terminal-silent-create";
import type { CreatedTerminalSession } from "@/lib/terminals/refresh-host-terminal-list";

interface ProtectedLandingTerminalTarget {
  readonly hostId: string;
  readonly landingPageId: string;
  readonly terminalId: string;
  readonly cwd: string;
}

interface ProtectedLandingTerminalCreate {
  readonly actor: DraftAuthorityActor;
  readonly claim: DraftAuthorityMutationResult<
    DraftAuthorityIssueReceipt,
    DraftAuthorityOutbox
  >;
  readonly target: ProtectedLandingTerminalTarget;
  readonly client: HostClient<HostRpcRegistry>;
  readonly capability: "capable" | "legacy";
  readonly grid: { readonly cols: number; readonly rows: number };
  readonly isCurrent: () => boolean;
}

export type ProtectedLandingTerminalResult =
  | { readonly kind: "capable"; readonly terminal: PlainTerminalProjection }
  | { readonly kind: "legacy"; readonly session: CreatedTerminalSession }
  | { readonly kind: "held" };

const INDEPENDENT_SCOPE: TerminalScope = { kind: "independent" };
const issuedGrants = new Set<string>();

function matchesProtectedTerminalClaim(
  claim: DraftAuthorityIssueReceipt,
  actor: DraftAuthorityActor,
  target: ProtectedLandingTerminalTarget,
): boolean {
  const { effect, source } = claim;
  return (
    claim.accountId === actor.accountId &&
    claim.sessionGeneration === actor.sessionGeneration &&
    source.kind === "restored-draft" &&
    source.draft.slot.kind === "landing" &&
    source.draft.slot.id === target.landingPageId &&
    effect.kind === "terminal" &&
    effect.payload.hostId === target.hostId &&
    effect.payload.landingPageId === target.landingPageId &&
    effect.payload.terminalId === target.terminalId &&
    effect.payload.cwd === target.cwd &&
    target.cwd.length > 0
  );
}

function matchesPlainTerminal(
  terminal: PlainTerminalProjection,
  target: ProtectedLandingTerminalTarget,
): boolean {
  const { record } = terminal;
  return (
    record.hostId === target.hostId &&
    record.terminalId === target.terminalId &&
    record.scope.kind === "independent" &&
    record.launch.cwd === target.cwd
  );
}

function matchesLegacyTerminal(
  session: CreatedTerminalSession,
  target: ProtectedLandingTerminalTarget,
): boolean {
  return (
    session.sessionId === target.terminalId &&
    session.scope.kind === "independent" &&
    session.sessionKind === "terminal" &&
    session.cwd === target.cwd
  );
}

async function observeProtectedTerminal(
  input: ProtectedLandingTerminalCreate,
): Promise<ProtectedLandingTerminalResult> {
  const { client, target, capability } = input;
  if (capability === "capable") {
    const snapshot = await withHostMutationErrorBoundary(
      "terminal.plain.list",
      () => client.request("terminal.plain.list", { scope: INDEPENDENT_SCOPE }),
    );
    const terminal = snapshot.terminals.find((row) =>
      matchesPlainTerminal(row, target),
    );
    return terminal === undefined ? { kind: "held" } : { kind: "capable", terminal };
  }
  const snapshot = await fetchIsolatedLegacyTerminalList({
    client,
    scope: INDEPENDENT_SCOPE,
  });
  const session = snapshot.sessions.find((row) => matchesLegacyTerminal(row, target));
  return session === undefined ? { kind: "held" } : { kind: "legacy", session };
}

/** Only a fresh executor creates. A replay can reconcile the exact host row. */
export async function createProtectedLandingTerminal(
  input: ProtectedLandingTerminalCreate,
): Promise<ProtectedLandingTerminalResult> {
  const { actor, claim, target, client, capability, grid } = input;
  const current = (): boolean =>
    draftAuthorityActorIsCurrent(actor) &&
    client.getActiveHostId() === target.hostId &&
    input.isCurrent();
  if (
    (claim.kind !== "committed" && claim.kind !== "replayed") ||
    !matchesProtectedTerminalClaim(claim.receipt, actor, target) ||
    !current()
  )
    return { kind: "held" };

  const receipt = claim.receipt;
  const grantKey = JSON.stringify([
    receipt.accountId,
    receipt.operationId,
    receipt.issueGeneration,
    receipt.executorId,
  ]);
  let result: ProtectedLandingTerminalResult = { kind: "held" };
  if (claim.kind === "committed") {
    const granted = await readDraftAuthorityIssueGrant({ actor, claim: receipt })
      .catch(() => false);
    if (!granted || !current() || issuedGrants.has(grantKey))
      return { kind: "held" };
    issuedGrants.add(grantKey);
    try {
      if (capability === "capable") {
        const response = await withHostMutationErrorBoundary(
          "terminal.plain.create",
          () => client.request("terminal.plain.create", {
            scope: INDEPENDENT_SCOPE,
            terminalId: target.terminalId,
            cwd: target.cwd,
            cols: grid.cols,
            rows: grid.rows,
          }),
        );
        if (matchesPlainTerminal(response.terminal, target))
          result = { kind: "capable", terminal: response.terminal };
      } else {
        const session = await runSilentLegacyEpicTerminalCreate({
          client,
          request: {
            scope: INDEPENDENT_SCOPE,
            desiredSessionId: target.terminalId,
            sessionKind: "terminal",
            tuiHarnessId: null,
            cwd: target.cwd,
            shellCommand: null,
            shellArgs: null,
            worktreeBusyPaths: [],
            cols: grid.cols,
            rows: grid.rows,
            themeHint: null,
          },
        });
        if (matchesLegacyTerminal(session, target))
          result = { kind: "legacy", session };
      }
    } catch {
      // A transport failure can follow host acceptance. Reconcile by exact ID.
    }
  }

  if (!current()) return { kind: "held" };
  if (result.kind === "held")
    result = await observeProtectedTerminal(input).catch(
      (): ProtectedLandingTerminalResult => ({ kind: "held" }),
    );
  if (!current()) return { kind: "held" };
  if (claim.kind === "replayed" && result.kind === "held") return result;

  const settled = await settleDraftAuthorityEffect({
    actor,
    claim: receipt,
    outcome: result.kind === "held" ? "uncertain" : "terminal",
  }).catch(() => null);
  if (settled?.kind !== "committed" && settled?.kind !== "replayed")
    return { kind: "held" };
  issuedGrants.delete(grantKey);
  return current() ? result : { kind: "held" };
}
