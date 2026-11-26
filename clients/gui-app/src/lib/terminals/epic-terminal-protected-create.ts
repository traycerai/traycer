import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { CanonicalTerminalSessionInfoWithLifecycleOwner } from "@traycer/protocol/host/terminal/unary-schemas";
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
  DraftAuthorityVersion,
} from "@/lib/drafts/draft-authority-types";
import type { HostRpcRegistry } from "@/lib/host";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { withHostMutationErrorBoundary } from "@/lib/query/host-query-error-boundary";
import {
  fetchIsolatedLegacyTerminalList,
  runSilentLegacyEpicTerminalCreate,
} from "@/lib/terminals/epic-terminal-silent-create";
import type { CreatedTerminalSession } from "@/lib/terminals/refresh-host-terminal-list";

interface ProtectedEpicTerminalTarget {
  readonly epicId: string;
  readonly sandboxId: string;
  readonly surfaceKey: string;
  readonly hostId: string;
  readonly terminalId: string;
  readonly cwd: string;
}

interface ProtectedEpicTerminalCreate {
  readonly actor: DraftAuthorityActor;
  readonly draft: DraftAuthorityVersion;
  readonly claim: DraftAuthorityMutationResult<
    DraftAuthorityIssueReceipt,
    DraftAuthorityOutbox
  >;
  readonly target: ProtectedEpicTerminalTarget;
  readonly client: HostClient<HostRpcRegistry>;
  readonly capability: "capable" | "legacy";
  readonly grid: { readonly cols: number; readonly rows: number };
  readonly isCurrent: () => boolean;
}

type ManagerOwnedTerminalSession = CanonicalTerminalSessionInfoWithLifecycleOwner & {
  readonly lifecycleOwner: "manager";
};

export type ProtectedEpicTerminalResult =
  | { readonly kind: "capable"; readonly terminal: PlainTerminalProjection }
  | { readonly kind: "legacy"; readonly session: ManagerOwnedTerminalSession }
  | { readonly kind: "held" };

const HELD = { kind: "held" } as const;
const claimedExecutors = new Set<string>();

function matchesClaim(
  claim: DraftAuthorityIssueReceipt,
  actor: DraftAuthorityActor,
  draft: DraftAuthorityVersion,
  target: ProtectedEpicTerminalTarget,
): boolean {
  const { source, effect } = claim;
  return (
    claim.accountId === actor.accountId &&
    claim.sessionGeneration === actor.sessionGeneration &&
    source.kind === "restored-draft" &&
    source.returnAccountId === actor.accountId &&
    draft.slot.kind === "task" &&
    draft.slot.id === target.epicId &&
    source.draft.slot.kind === "task" &&
    source.draft.slot.id === draft.slot.id &&
    source.draft.occurrence === draft.occurrence &&
    source.draft.version === draft.version &&
    effect.kind === "terminal" &&
    effect.phase === "setup" &&
    effect.identity === target.terminalId &&
    effect.payload.epicId === target.epicId &&
    effect.payload.hostId === target.hostId &&
    effect.payload.sandboxId === target.sandboxId &&
    effect.payload.surfaceKey === target.surfaceKey &&
    effect.payload.terminalId === target.terminalId &&
    effect.payload.cwd === target.cwd &&
    target.cwd.length > 0
  );
}

function matchesPlainTerminal(
  terminal: PlainTerminalProjection,
  target: ProtectedEpicTerminalTarget,
): boolean {
  const { record } = terminal;
  return (
    record.hostId === target.hostId &&
    record.terminalId === target.terminalId &&
    record.scope.kind === "epic" &&
    record.scope.epicId === target.epicId &&
    record.launch.cwd === target.cwd
  );
}

function matchesLegacyTerminal(
  session: CreatedTerminalSession,
  target: ProtectedEpicTerminalTarget,
): boolean {
  return (
    session.sessionId === target.terminalId &&
    session.scope.kind === "epic" &&
    session.scope.epicId === target.epicId &&
    session.sessionKind === "terminal" &&
    session.cwd === target.cwd
  );
}

export function protectedEpicTerminalCanAttestLegacy(hostId: string): boolean {
  const version = readNegotiatedMethodVersion(hostId, "terminal.list");
  // The legacy upgrade fills registry. Only the wire owner can prove manager.
  return (
    version !== null &&
    version !== false &&
    version.major === 2 &&
    version.minor >= 3
  );
}

async function observeTerminal(
  input: ProtectedEpicTerminalCreate,
  current: () => boolean,
): Promise<ProtectedEpicTerminalResult> {
  const { capability, client, target } = input;
  const scope = { kind: "epic" as const, epicId: target.epicId };
  if (!current()) return HELD;
  if (capability === "capable") {
    const snapshot = await withHostMutationErrorBoundary(
      "terminal.plain.list",
      () => client.request("terminal.plain.list", { scope }),
    ).catch(() => null);
    const terminal = snapshot?.terminals.find((row) =>
      matchesPlainTerminal(row, target),
    );
    return terminal === undefined ? HELD : { kind: "capable", terminal };
  }
  const snapshot = await fetchIsolatedLegacyTerminalList({ client, scope })
    .catch(() => null);
  const session = snapshot?.sessions.find(
    (row): row is ManagerOwnedTerminalSession =>
      row.lifecycleOwner === "manager" && matchesLegacyTerminal(row, target),
  );
  return session === undefined ? HELD : { kind: "legacy", session };
}

async function issueTerminal(
  input: ProtectedEpicTerminalCreate,
  current: () => boolean,
): Promise<ProtectedEpicTerminalResult> {
  const { capability, client, grid, target } = input;
  const scope = { kind: "epic" as const, epicId: target.epicId };
  if (!current()) return HELD;

  try {
    if (capability === "capable") {
      const { terminal } = await withHostMutationErrorBoundary(
        "terminal.plain.create",
        () => client.request("terminal.plain.create", {
          scope,
          terminalId: target.terminalId,
          cwd: target.cwd,
          cols: grid.cols,
          rows: grid.rows,
        }),
      );
      return matchesPlainTerminal(terminal, target)
        ? { kind: "capable", terminal }
        : HELD;
    }
    const session = await runSilentLegacyEpicTerminalCreate({
      client,
      request: {
        scope,
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
    if (!matchesLegacyTerminal(session, target)) return HELD;
  } catch {
    // The host may have accepted the create. Read the exact scoped result.
  }

  // The legacy create response itself carries no lifetime owner.
  return observeTerminal(input, current);
}

/** A protected Task Open uses only its captured target and accepted grant. */
export async function createProtectedEpicTerminal(
  input: ProtectedEpicTerminalCreate,
): Promise<ProtectedEpicTerminalResult> {
  const { actor, claim, client, capability, draft } = input;
  const target = { ...input.target };
  const request = { ...input, target, grid: { ...input.grid } };
  const current = (): boolean =>
    draftAuthorityActorIsCurrent(actor) &&
    client.getActiveHostId() === target.hostId &&
    (capability === "capable" || protectedEpicTerminalCanAttestLegacy(target.hostId)) &&
    input.isCurrent();
  if (
    (claim.kind !== "committed" && claim.kind !== "replayed") ||
    !matchesClaim(claim.receipt, actor, draft, target) ||
    !current()
  )
    return HELD;

  const receipt = claim.receipt;
  const key = JSON.stringify([
    receipt.accountId,
    receipt.operationId,
    receipt.issueGeneration,
    receipt.executorId,
  ]);
  let result: ProtectedEpicTerminalResult;
  if (claim.kind === "committed") {
    // Reserve before the grant read so two deferred callbacks cannot both
    // read the same executor and then take turns issuing it.
    if (claimedExecutors.has(key)) return HELD;
    claimedExecutors.add(key);
    const granted = await readDraftAuthorityIssueGrant({ actor, claim: receipt })
      .catch(() => false);
    if (!granted || !current()) {
      claimedExecutors.delete(key);
      return HELD;
    }
    result = await issueTerminal(request, current);
  } else {
    result = await observeTerminal(request, current);
    if (result.kind === "held") return HELD;
  }
  if (!current()) return HELD;
  const settled = await settleDraftAuthorityEffect({
    actor,
    claim: receipt,
    outcome: result.kind === "held" ? "uncertain" : "terminal",
  }).catch(() => null);
  if (settled?.kind !== "committed" && settled?.kind !== "replayed")
    return HELD;
  claimedExecutors.delete(key);
  return current() ? result : HELD;
}
