import { z } from "zod";
import {
  decideExternalAction,
  fingerprintsEqual,
  type ExternalAction,
  type ExternalActionDecision,
  type ObjectFingerprint,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  applyFileImage,
  FILE_IMAGE_ADAPTER,
  invertFileImage,
  observeFileImage,
} from "./file-image-action";
import {
  applyGitWorktree,
  GIT_WORKTREE_LINK_ADAPTER,
  invertGitWorktree,
  observeGitWorktree,
} from "./git-worktree-actions";
import {
  isExternalActionConflictError,
  type ExternalActionStage,
} from "./ledger";
import {
  applyWindowsTask,
  invertWindowsTask,
  observeWindowsTask,
  WINDOWS_TASK_DEFINITION_ADAPTER,
} from "./windows-task-actions";
import {
  applyWindowsUserPath,
  invertWindowsUserPath,
  observeWindowsUserPath,
  WINDOWS_USER_PATH_ADAPTER,
} from "./windows-user-path-action";

/**
 * The one entry point the migration coordinator (ticket 718-6) drives every
 * ledger entry through. The coordinator owns the journal: it persists each
 * returned action (with its new state) as the next journal revision before it
 * moves on, so a crash between an effect and its receipt is reconciled from
 * the object on the next run (`decideExternalAction`).
 */

type ExternalActionAdapter = {
  readonly kinds: ReadonlySet<ExternalAction["kind"]>;
  readonly observe: (action: ExternalAction) => Promise<ObjectFingerprint>;
  readonly apply: (action: ExternalAction) => Promise<void>;
  readonly invert: (action: ExternalAction) => Promise<void>;
};

const ADAPTERS: Readonly<Record<string, ExternalActionAdapter>> = {
  [WINDOWS_TASK_DEFINITION_ADAPTER]: {
    kinds: new Set(["service-registration"]),
    observe: observeWindowsTask,
    apply: applyWindowsTask,
    invert: invertWindowsTask,
  },
  [FILE_IMAGE_ADAPTER]: {
    kinds: new Set(["service-registration"]),
    observe: observeFileImage,
    apply: applyFileImage,
    invert: invertFileImage,
  },
  [WINDOWS_USER_PATH_ADAPTER]: {
    kinds: new Set(["path-entry"]),
    observe: () => observeWindowsUserPath(),
    apply: applyWindowsUserPath,
    invert: invertWindowsUserPath,
  },
  [GIT_WORKTREE_LINK_ADAPTER]: {
    kinds: new Set(["git-metadata"]),
    observe: observeGitWorktree,
    apply: applyGitWorktree,
    invert: invertGitWorktree,
  },
};

const envelopeSchema = z.looseObject({
  adapter: z.string(),
  version: z.number(),
  stage: z.enum(["quiesce", "prepare", "activate"]),
});

function adapterFor(action: ExternalAction): ExternalActionAdapter {
  const envelope = envelopeSchema.parse(action.forward);
  const adapter = ADAPTERS[envelope.adapter];
  if (adapter === undefined || !adapter.kinds.has(action.kind)) {
    throw new Error(
      `ledger action ${action.id} names no known adapter for kind ${action.kind}`,
    );
  }
  return adapter;
}

/** The coordinator step an action belongs to (see `ExternalActionStage`). */
export function externalActionStage(
  action: ExternalAction,
): ExternalActionStage {
  return envelopeSchema.parse(action.forward).stage;
}

export type ExternalActionOutcome =
  | {
      readonly kind: "settled";
      /** The action with the state the object now proves. */
      readonly action: ExternalAction;
      readonly decision: ExternalActionDecision;
    }
  | {
      readonly kind: "conflict";
      readonly action: ExternalAction;
      /** The exact object, for the user-facing diagnostic. */
      readonly object: string;
      readonly reason: string;
    };

function conflict(
  action: ExternalAction,
  object: string,
  reason: string,
): ExternalActionOutcome {
  return { kind: "conflict", action, object, reason };
}

/**
 * Several actions may act on ONE object, in ledger order: a task is disabled
 * (A -> B), retargeted (B -> C) and re-enabled (C -> D). Such a chain is
 * valid only when each action's before image is its predecessor's after
 * image, and its actions settle in order - forward front to back, inverse
 * back to front. The object then shows the after image of the LAST applied
 * action (or, with none applied, the first action's before image); earlier
 * after images are history, not the current state.
 */
function chainOf(
  ledger: readonly ExternalAction[],
  action: ExternalAction,
): { readonly chain: readonly ExternalAction[]; readonly index: number } {
  const chain = ledger.filter((entry) => entry.object === action.object);
  const index = chain.findIndex((entry) => entry.id === action.id);
  if (index < 0) {
    throw new Error(
      `ledger action ${action.id} is not in the ledger it was reconciled against`,
    );
  }
  return { chain, index };
}

const UNDONE: ReadonlySet<ExternalAction["state"]> = new Set([
  "abandoned",
  "inverted",
]);

/**
 * Observe the action's object, decide (`decideExternalAction`), and perform
 * the forward or inverse write when that is the decision - a compare-and-set
 * against the recorded image - then observe again and return the state the
 * object proves. A conflict is returned, never overwritten; the coordinator
 * keeps the startup barrier up and names the object. Any other failure (a
 * read that could not run, an out-of-order call) is thrown: nothing was
 * decided.
 *
 * `ledger` is the journal's whole action list (it contains `action`), so a
 * chain on the same object is honoured:
 * - forward, an earlier action on the object must be `applied` first; an
 *   `applied` action that a later one has superseded is checked against the
 *   chain's current image (the last applied after image, or - inside the
 *   crash window of the next planned action - that action's after image)
 *   and otherwise left as it is;
 * - inverse, every later action on the object must be undone first; a
 *   planned action behind an unapplied one is recorded abandoned unread; an
 *   already undone one (a replayed rollback) is checked against the chain's
 *   current image.
 */
export async function reconcileExternalAction(
  action: ExternalAction,
  direction: "forward" | "inverse",
  ledger: readonly ExternalAction[],
): Promise<ExternalActionOutcome> {
  const adapter = adapterFor(action);
  const { chain, index } = chainOf(ledger, action);
  const earlier = chain.slice(0, index);
  const later = chain.slice(index + 1);
  if (direction === "forward") {
    if (earlier.some((entry) => entry.state !== "applied")) {
      throw new Error(
        `ledger action ${action.id} cannot go forward before the earlier actions on its object`,
      );
    }
    if (
      action.state === "planned" &&
      later.some((entry) => entry.state !== "planned")
    ) {
      return conflict(
        action,
        action.object,
        "a later action on this object settled before this one",
      );
    }
    if (action.state === "applied" && later.length > 0) {
      let lastApplied = index;
      while (chain[lastApplied + 1]?.state === "applied") lastApplied += 1;
      const current = chain[lastApplied] ?? action;
      const next = chain[lastApplied + 1];
      const observed = await adapter.observe(action);
      const matches =
        fingerprintsEqual(observed, current.after) ||
        (next !== undefined &&
          next.state === "planned" &&
          fingerprintsEqual(observed, next.after));
      return matches
        ? { kind: "settled", action, decision: "none" }
        : conflict(
            action,
            action.object,
            "the object matches neither the chain's current nor its next image",
          );
    }
  } else {
    if (later.some((entry) => !UNDONE.has(entry.state))) {
      throw new Error(
        `ledger action ${action.id} cannot be inverted before the later actions on its object`,
      );
    }
    // Forward never starts an action before its predecessor is applied, so a
    // planned action behind an unapplied one cannot have taken effect: it is
    // abandoned without reading the object (which shows an EARLIER image).
    // The planned action right after the last applied one is decided from
    // the object as usual - that is the effect-before-receipt window.
    // Replaying a rollback: an action already undone is checked against the
    // chain's CURRENT image, not its own before image. The applied prefix
    // ends at the frontier; the object shows the frontier's after image, its
    // before image (its inverse took effect before its receipt), or - when
    // the action right after the frontier is still planned - that action's
    // after image (its forward effect took effect before its receipt). With
    // nothing applied, the chain's first before image stands in for the
    // frontier's.
    if (UNDONE.has(action.state)) {
      let frontierIndex = index - 1;
      while (frontierIndex >= 0 && chain[frontierIndex]?.state !== "applied")
        frontierIndex -= 1;
      const frontier = chain[frontierIndex];
      const next = chain[frontierIndex + 1];
      const images =
        frontier === undefined
          ? [(chain[0] ?? action).before]
          : [frontier.after, frontier.before];
      if (next !== undefined && next !== action && next.state === "planned")
        images.push(next.after);
      const observed = await adapter.observe(action);
      return images.some((image) => fingerprintsEqual(observed, image))
        ? { kind: "settled", action, decision: "none" }
        : conflict(
            action,
            action.object,
            "the object matches no image the chain's state allows",
          );
    }
    const previous = chain[index - 1];
    if (
      action.state === "planned" &&
      previous !== undefined &&
      previous.state !== "applied"
    ) {
      return {
        kind: "settled",
        action: { ...action, state: "abandoned" },
        decision: "record-abandoned",
      };
    }
  }
  const observed = await adapter.observe(action);
  const decision = decideExternalAction(action, observed, direction);
  const settled = (state: ExternalAction["state"]): ExternalActionOutcome => ({
    kind: "settled",
    action: { ...action, state },
    decision,
  });
  switch (decision) {
    case "none":
      return settled(action.state);
    case "record-applied":
      return settled("applied");
    case "record-abandoned":
      return settled("abandoned");
    case "record-inverted":
      return settled("inverted");
    case "conflict":
      return conflict(
        action,
        action.object,
        "the object matches neither the recorded before nor after image",
      );
    case "apply":
    case "invert": {
      try {
        if (decision === "apply") await adapter.apply(action);
        else await adapter.invert(action);
      } catch (cause) {
        if (isExternalActionConflictError(cause)) {
          return conflict(action, cause.object, cause.message);
        }
        throw cause;
      }
      const after = await adapter.observe(action);
      const expected = decision === "apply" ? action.after : action.before;
      if (!fingerprintsEqual(after, expected)) {
        return conflict(
          action,
          action.object,
          `the ${decision === "apply" ? "forward" : "inverse"} write did not produce the recorded image`,
        );
      }
      return settled(decision === "apply" ? "applied" : "inverted");
    }
  }
}

export type ExternalActionMismatch = {
  readonly id: string;
  readonly object: string;
  readonly reason: string;
};

function objectChains(
  actions: readonly ExternalAction[],
): Map<string, ExternalAction[]> {
  const chains = new Map<string, ExternalAction[]>();
  for (const action of actions) {
    const chain = chains.get(action.object);
    if (chain === undefined) chains.set(action.object, [action]);
    else chain.push(action);
  }
  return chains;
}

/**
 * Pure: every same-object chain is continuous (each before image is the
 * previous action's after image) and settled in order (no `applied` action
 * after one that is not). The coordinator checks this whenever it appends
 * planned actions to the journal.
 */
export function checkExternalActionChains(
  actions: readonly ExternalAction[],
): ExternalActionMismatch[] {
  const mismatches: ExternalActionMismatch[] = [];
  for (const chain of objectChains(actions).values()) {
    for (let index = 1; index < chain.length; index += 1) {
      const previous = chain[index - 1];
      const action = chain[index];
      if (previous === undefined || action === undefined) continue;
      if (!fingerprintsEqual(previous.after, action.before)) {
        mismatches.push({
          id: action.id,
          object: action.object,
          reason:
            "its before image is not the previous action's after image on this object",
        });
      }
      if (action.state === "applied" && previous.state !== "applied") {
        mismatches.push({
          id: action.id,
          object: action.object,
          reason: "it is applied while an earlier action on this object is not",
        });
      }
    }
  }
  return mismatches;
}

/**
 * Read-only: each object shows the image its chain's states claim - the
 * after image of its last `applied` action, or, with none applied, the
 * before image of its first action - and every chain passes
 * `checkExternalActionChains`. `planned` actions after the last applied one
 * are pending, not mismatches (`externalActionStage` says when they run).
 * For the coordinator's `ready` and `switched` revalidation and after a
 * rollback.
 */
export async function verifySettledExternalActions(
  actions: readonly ExternalAction[],
): Promise<ExternalActionMismatch[]> {
  const mismatches = checkExternalActionChains(actions);
  for (const chain of objectChains(actions).values()) {
    const first = chain[0];
    if (first === undefined) continue;
    const applied = chain.filter((action) => action.state === "applied");
    const terminal = applied[applied.length - 1];
    const expected = terminal === undefined ? first.before : terminal.after;
    const witness = terminal ?? first;
    const observed = await adapterFor(witness).observe(witness);
    if (!fingerprintsEqual(observed, expected)) {
      mismatches.push({
        id: witness.id,
        object: witness.object,
        reason:
          terminal === undefined
            ? "the object no longer shows its image from before the migration"
            : "the object no longer shows the image of its last applied action",
      });
    }
  }
  return mismatches;
}
