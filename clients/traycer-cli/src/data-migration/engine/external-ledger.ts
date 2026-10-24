import {
  actionsInInverseOrder,
  type ExternalAction,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  GIT_WORKTREE_LINK_ADAPTER,
  verifyGitWorktreeCopy,
} from "../external-actions/git-worktree-actions";
import type {
  ExternalActionBlocker,
  ExternalActionStage,
} from "../external-actions/ledger";
import {
  checkExternalActionChains,
  externalActionStage,
  reconcileExternalAction,
  verifySettledExternalActions,
  type ExternalActionOutcome,
} from "../external-actions/reconcile";
import { EngineStop, engineBlocker, type EngineBlocker } from "./engine-types";
import type { JournalSession } from "./journal-session";

/**
 * The engine's driver of the journal's external-action ledger (adapters:
 * ticket 718-5). The ledger is append-only and replayed, never rebuilt from
 * what is observed now:
 *
 * - planned actions are appended in the same journal revision as the phase
 *   change that will perform them, after a chain-continuity check, so every
 *   effect is durably `planned` before it can happen;
 * - a stage runs its actions in ledger order, each reconciled against the
 *   WHOLE ledger (`reconcileExternalAction`), and every state the reconciler
 *   returns is persisted as its own journal revision before the next action
 *   is touched;
 * - rollback reconciles every action in reverse ledger order in the inverse
 *   direction, persisting each `abandoned`/`inverted` state the same way, so
 *   a crashed rollback replays its own evidence;
 * - a conflict (a third party changed the object) stops the engine with the
 *   object named; nothing is overwritten and the barrier stays up.
 */

export function planBlockers(
  blockers: readonly ExternalActionBlocker[],
): EngineBlocker[] {
  return blockers.map((blocker) =>
    engineBlocker(blocker.code, blocker.object, blocker.message),
  );
}

/**
 * The ledger with `planned` appended, refusing any break in a same-object
 * chain. Ids already in the ledger are a planning error (each stage is
 * planned exactly once, in the revision that enters its phase).
 */
export function ledgerWithPlanned(
  ledger: readonly ExternalAction[],
  planned: readonly ExternalAction[],
): ExternalAction[] {
  const ids = new Set(ledger.map((action) => action.id));
  for (const action of planned) {
    if (ids.has(action.id)) {
      throw new EngineStop(
        "conflict",
        [
          engineBlocker(
            "ledger-duplicate",
            action.object,
            "an external action was planned twice",
          ),
        ],
        null,
      );
    }
    ids.add(action.id);
  }
  const next = [...ledger, ...planned];
  const mismatches = checkExternalActionChains(next);
  if (mismatches.length > 0) {
    throw new EngineStop(
      "conflict",
      mismatches.map((mismatch) =>
        engineBlocker("ledger-chain-broken", mismatch.object, mismatch.reason),
      ),
      null,
    );
  }
  return next;
}

function replaceAction(
  ledger: readonly ExternalAction[],
  action: ExternalAction,
): ExternalAction[] {
  return ledger.map((entry) => (entry.id === action.id ? action : entry));
}

async function reconcileOne(
  session: JournalSession,
  actionId: string,
  direction: "forward" | "inverse",
  checkpoint: (
    point: `before-action:${string}` | `after-action:${string}`,
  ) => Promise<void>,
): Promise<void> {
  const ledger = session.journal.actions;
  const action = ledger.find((entry) => entry.id === actionId);
  if (action === undefined)
    throw new Error(`ledger action ${actionId} vanished from the journal`);
  await checkpoint(`before-action:${actionId}`);
  let outcome: ExternalActionOutcome;
  try {
    outcome = await reconcileExternalAction(action, direction, ledger);
  } catch (error) {
    if (error instanceof EngineStop) throw error;
    throw new EngineStop(
      "failed",
      [
        engineBlocker(
          "external-action-failed",
          action.object,
          "an external change could not be read or applied; nothing was decided for it",
        ),
      ],
      null,
    );
  }
  await checkpoint(`after-action:${actionId}`);
  if (outcome.kind === "conflict") {
    throw new EngineStop(
      "conflict",
      [engineBlocker("external-conflict", outcome.object, outcome.reason)],
      null,
    );
  }
  if (outcome.action.state !== action.state) {
    await session.advance({
      actions: replaceAction(session.journal.actions, outcome.action),
    });
  }
}

/** Run every action of `stage` forward, in ledger order. */
export async function runStageForward(
  session: JournalSession,
  stage: ExternalActionStage,
  checkpoint: (
    point: `before-action:${string}` | `after-action:${string}`,
  ) => Promise<void>,
): Promise<void> {
  const ids = session.journal.actions
    .filter((action) => externalActionStage(action) === stage)
    .map((action) => action.id);
  for (const id of ids) await reconcileOne(session, id, "forward", checkpoint);
}

/** Undo the whole ledger, in reverse order. */
export async function runLedgerInverse(
  session: JournalSession,
  checkpoint: (
    point: `before-action:${string}` | `after-action:${string}`,
  ) => Promise<void>,
): Promise<void> {
  const ids = actionsInInverseOrder(session.journal.actions).map(
    (action) => action.id,
  );
  for (const id of ids) await reconcileOne(session, id, "inverse", checkpoint);
}

/**
 * Terminal-state verification of the ledger: every object shows the image its
 * chain claims, and every applied Git action's destination worktree verifies
 * against the source snapshot (HEAD, status, dirty/untracked bytes, worktree
 * list). Returns blockers; empty means verified.
 */
export async function verifyLedger(
  actions: readonly ExternalAction[],
): Promise<EngineBlocker[]> {
  const blockers: EngineBlocker[] = [];
  for (const mismatch of await verifySettledExternalActions(actions)) {
    blockers.push(
      engineBlocker(
        "external-state-mismatch",
        mismatch.object,
        mismatch.reason,
      ),
    );
  }
  for (const action of actions) {
    if (action.state !== "applied" || !isGitAction(action)) continue;
    const verification = await verifyGitWorktreeCopy(action);
    if (!verification.ok) {
      blockers.push(
        engineBlocker(
          "git-verification-failed",
          action.object,
          `the moved worktree does not verify (${verification.mismatches.join("; ")})`,
        ),
      );
    }
  }
  return blockers;
}

function isGitAction(action: ExternalAction): boolean {
  const forward = action.forward;
  return (
    typeof forward === "object" &&
    forward !== null &&
    !Array.isArray(forward) &&
    Reflect.get(forward, "adapter") === GIT_WORKTREE_LINK_ADAPTER
  );
}

/** Whether every action of `stage` is applied. */
export function stageApplied(
  actions: readonly ExternalAction[],
  stage: ExternalActionStage,
): boolean {
  return actions.every(
    (action) =>
      externalActionStage(action) !== stage || action.state === "applied",
  );
}
