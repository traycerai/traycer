/**
 * The review list, a hold's apply and discard, the notices and Undo, as the
 * app's own calls to authn on the person's sign-in (`environment-cloud.ts`).
 *
 * - `GET …/review?include=operation`: every hold with its operation, put or
 *   delete, and the live item it would replace.
 * - `POST …/review/held/:heldId/apply` with the hold's revision and the live
 *   revision the person saw: authn checks both, and consumes the hold, in one
 *   transaction.
 * - `POST …/review/held/:heldId/discard` with the hold's revision.
 * - `GET …/notices` and `POST …/changes/:revision/undo`.
 *
 * Each answer authn gives that a person acts on is an outcome here, not an
 * error: a hold that moved, a live item that moved, a hold already gone.
 */
import {
  REVIEW_INCLUDE_OPERATION,
  authnHeldApplyConflictSchema,
  authnHeldDiscardResponseSchema,
  authnItemWriteResponseSchema,
  authnNoticesResponseSchema,
  authnOperationReviewResponseSchema,
  authnUndoConflictSchema,
  authnUndoResponseSchema,
  type AuthnItemRow,
  type AuthnNoticeRow,
  type AuthnOperationReview,
} from "./authn-environment-schemas";
import {
  environmentPath,
  errorBodyCode,
  parseSettings,
  sendSettings,
  settingsRefusal,
  type EnvironmentCloud,
} from "./environment-cloud";

/** The review, or null when nothing is migrated and nothing is held. */
export async function readOperationReview(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<AuthnOperationReview | null> {
  const query = new URLSearchParams({ include: REVIEW_INCLUDE_OPERATION });
  return parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/review?${query.toString()}`,
      null,
    ),
    authnOperationReviewResponseSchema,
  ).review;
}

export interface HeldApplyRequest {
  readonly heldId: string;
  /** The hold's version, as the review showed it. */
  readonly revision: number;
  /** The live item's revision the person saw; null when there was none. */
  readonly expectedLiveRevision: number | null;
}

export type HeldApplyOutcome =
  /** Written: `item` null after a delete; `replayed` when it was already applied. */
  | {
      readonly outcome: "applied";
      readonly item: AuthnItemRow | null;
      readonly replayed: boolean;
      readonly revision: number;
    }
  /** The hold changed since it was shown. */
  | { readonly outcome: "superseded" }
  /** The live item moved since it was shown; `current` is it now, null when gone. */
  | { readonly outcome: "conflict"; readonly current: AuthnItemRow | null }
  /** No such hold any more. */
  | { readonly outcome: "gone" };

export async function applyHeldChange(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: HeldApplyRequest,
): Promise<HeldApplyOutcome> {
  const answer = await sendSettings(
    cloud,
    "POST",
    `${environmentPath(environmentId)}/review/held/${encodeURIComponent(request.heldId)}/apply`,
    {
      revision: request.revision,
      expectedLiveRevision: request.expectedLiveRevision,
    },
  );
  if (answer.status === 409) {
    const conflict = authnHeldApplyConflictSchema.safeParse(answer.body);
    if (conflict.success) {
      return conflict.data.code === "superseded"
        ? { outcome: "superseded" }
        : { outcome: "conflict", current: conflict.data.current };
    }
  }
  if (answer.status === 404) return { outcome: "gone" };
  const written = parseSettings(answer, authnItemWriteResponseSchema);
  return {
    outcome: "applied",
    item: written.item,
    replayed: written.replayed,
    revision: written.revision,
  };
}

export type HeldDiscardOutcome =
  | { readonly outcome: "discarded" }
  | { readonly outcome: "superseded" }
  | { readonly outcome: "gone" };

export async function discardHeldChange(
  cloud: EnvironmentCloud,
  environmentId: string,
  heldId: string,
  revision: number,
): Promise<HeldDiscardOutcome> {
  const answer = await sendSettings(
    cloud,
    "POST",
    `${environmentPath(environmentId)}/review/held/${encodeURIComponent(heldId)}/discard`,
    { revision },
  );
  if (answer.status === 409 && errorBodyCode(answer.body) === "superseded") {
    return { outcome: "superseded" };
  }
  if (answer.status === 404) return { outcome: "gone" };
  parseSettings(answer, authnHeldDiscardResponseSchema);
  return { outcome: "discarded" };
}

/** Every change of the last 30 days that displaced a value Undo can restore. */
export async function readChangeNotices(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<readonly AuthnNoticeRow[]> {
  return parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/notices`,
      null,
    ),
    authnNoticesResponseSchema,
  ).notices;
}

export interface UndoRequest {
  /** The change that displaced the value. */
  readonly revision: number;
  readonly kind: string;
  readonly key: string;
  readonly os: AuthnNoticeRow["os"];
}

export type UndoOutcome =
  | { readonly outcome: "undone"; readonly item: AuthnItemRow }
  | {
      readonly outcome: "superseded" | "nothing_displaced" | "change_not_found";
      /** The row as it stands for `superseded`, else null. */
      readonly current: AuthnItemRow | null;
    };

export async function undoChange(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: UndoRequest,
): Promise<UndoOutcome> {
  const answer = await sendSettings(
    cloud,
    "POST",
    `${environmentPath(environmentId)}/changes/${encodeURIComponent(String(request.revision))}/undo`,
    { kind: request.kind, key: request.key, os: request.os },
  );
  if (answer.status === 409) {
    const refused = authnUndoConflictSchema.safeParse(answer.body);
    if (refused.success) {
      return { outcome: refused.data.code, current: refused.data.current };
    }
    throw settingsRefusal(answer);
  }
  return {
    outcome: "undone",
    item: parseSettings(answer, authnUndoResponseSchema).item,
  };
}
