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
import { z } from "zod";
import {
  environmentItemKindSchema,
  type EnvironmentChangedBy,
  type EnvironmentNotice,
  type EnvironmentReviewEntryV12,
  type EnvironmentWriteOutcome,
} from "@traycer/protocol/host/environment-schemas";
import { heldFactsOf } from "@traycer/protocol/host/environment/held-facts";
import {
  ITEM_OS_VALUES,
  REVIEW_INCLUDE_OPERATION,
  authnHeldApplyConflictSchema,
  authnNoticesResponseSchema,
  authnOperationReviewResponseSchema,
  authnUndoConflictSchema,
  authnUndoResponseSchema,
  type AuthnItemRow,
  type AuthnNoticeRow,
} from "./authn-environment-schemas";
import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  environmentPath,
  isRedirect,
  isSuccess,
  sendSettings,
  type EnvironmentAnswer,
  type EnvironmentCloud,
  type EnvironmentHttpMethod,
} from "./environment-cloud";

/**
 * The words of each failure, as the host's review client said them: a call
 * nothing answered, and one authn did not take.
 */
const OFFLINE_MESSAGE = "This needs a connection to your environment.";
const REVIEW_OFFLINE_MESSAGE = "Connect to review these settings.";
const REFUSED_MESSAGE = "Your environment did not accept this change.";
/** The words a notice that no longer names an undoable change is refused with. */
const NOTICE_GONE_MESSAGE = "This notice is no longer available.";

/** One review, notice or Undo call; nothing answering is `offline`'s words. */
async function sendReview(
  cloud: EnvironmentCloud,
  method: EnvironmentHttpMethod,
  path: string,
  body: unknown,
  offline: string,
): Promise<EnvironmentAnswer> {
  try {
    return await sendSettings(cloud, method, path, body);
  } catch (error) {
    if (error instanceof EnvironmentCloudError && error.kind === "no_response")
      throw new EnvironmentCloudError("no_response", offline);
    throw error;
  }
}

/**
 * A non-success the call has no outcome for: a plain refusal whatever its
 * status, as the host gave it. A redirect never reached authn.
 */
function reviewRefusal(answer: EnvironmentAnswer): EnvironmentCloudError {
  return isRedirect(answer)
    ? new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE)
    : new EnvironmentCloudError("refused", REFUSED_MESSAGE);
}

/** A read's answer parsed with `schema`; an answer that does not parse is refused too. */
function parseReview<T>(answer: EnvironmentAnswer, schema: z.ZodType<T>): T {
  if (!isSuccess(answer)) throw reviewRefusal(answer);
  const parsed = schema.safeParse(answer.body);
  if (!parsed.success)
    throw new EnvironmentCloudError("refused", REFUSED_MESSAGE);
  return parsed.data;
}

function heldPath(environmentId: string, heldId: string, verb: string): string {
  return `${environmentPath(environmentId)}/review/held/${encodeURIComponent(heldId)}/${verb}`;
}

// ── the review sheet, the notices and Undo, as the screens read them ───────

/**
 * One held change as the review sheet lists it: the protocol's row, with its
 * line masked by the protocol's own rule, and what Apply names. A held value
 * is read for that line alone; it is never kept, logged or shown unmasked.
 */
export type ReviewHeldEntry = EnvironmentReviewEntryV12 & {
  readonly op: "put" | "delete";
  /** The hold's version: Apply and Discard name exactly this one. */
  readonly heldRevision: number;
  /** The live item's revision the list read; null when there is none. */
  readonly liveRevision: number | null;
};

const NO_HELD_FACTS = {
  command: null,
  event: null,
  description: null,
  harness: null,
  value: null,
} as const;

/**
 * The holds of an environment's review (`GET …/review?include=operation`:
 * every hold with its operation and the live item it would replace), each as
 * the sheet lists it.
 */
export async function readReviewHolds(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<readonly ReviewHeldEntry[]> {
  const query = new URLSearchParams({ include: REVIEW_INCLUDE_OPERATION });
  const { review } = parseReview(
    await sendReview(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/review?${query.toString()}`,
      null,
      REVIEW_OFFLINE_MESSAGE,
    ),
    authnOperationReviewResponseSchema,
  );
  const holds: ReviewHeldEntry[] = [];
  for (const entry of review?.needsYou ?? []) {
    // A sign-in that did not move is the dashboard's to show.
    if (entry.type !== "held") continue;
    const kind = environmentItemKindSchema.safeParse(entry.kind);
    if (!kind.success) continue;
    holds.push({
      entryId: entry.heldId,
      reason: "executable_entry",
      kind: kind.data,
      key: entry.key,
      os: entry.os ?? "any",
      hostId: entry.hostId,
      heldAt: entry.heldAt,
      ...(entry.op === "put"
        ? heldFactsOf({ kind: entry.kind, key: entry.key, value: entry.value })
        : NO_HELD_FACTS),
      op: entry.op,
      heldRevision: entry.revision,
      liveRevision: entry.live?.revision ?? null,
    });
  }
  return holds;
}

/**
 * The review sheet's choice on one hold:
 * - `applied`: written (approve) or dropped (discard);
 * - `conflict`: approve only: the live item moved since the list read it;
 *   `current` is it now, null when it is gone. Its value is shown only
 *   through the masker;
 * - `gone`: the hold moved or is no longer there; the reread draws the row
 *   as it is now;
 * - `forbidden`: not the person's to make.
 */
export type ReviewChoiceOutcome =
  | { readonly outcome: "applied" | "gone" | "forbidden" }
  | { readonly outcome: "conflict"; readonly current: AuthnItemRow | null };

/**
 * Apply sends the hold's revision and the live revision the person saw, and
 * authn checks both and consumes the hold in one transaction; Discard sends
 * the hold's revision.
 */
export async function applyReviewChoice(
  cloud: EnvironmentCloud,
  environmentId: string,
  entry: ReviewHeldEntry,
  choice: "approve" | "discard",
): Promise<ReviewChoiceOutcome> {
  const answer =
    choice === "approve"
      ? await sendReview(
          cloud,
          "POST",
          heldPath(environmentId, entry.entryId, "apply"),
          {
            revision: entry.heldRevision,
            expectedLiveRevision: entry.liveRevision,
          },
          REVIEW_OFFLINE_MESSAGE,
        )
      : await sendReview(
          cloud,
          "POST",
          heldPath(environmentId, entry.entryId, "discard"),
          { revision: entry.heldRevision },
          REVIEW_OFFLINE_MESSAGE,
        );
  if (answer.status === 403) return { outcome: "forbidden" };
  if (answer.status === 409 && choice === "approve") {
    const conflict = authnHeldApplyConflictSchema.safeParse(answer.body);
    if (conflict.success && conflict.data.code === "revision_conflict") {
      return { outcome: "conflict", current: conflict.data.current };
    }
  }
  if (answer.status === 404 || answer.status === 409)
    return { outcome: "gone" };
  if (!isSuccess(answer)) throw reviewRefusal(answer);
  return { outcome: "applied" };
}

const noticeAddressSchema = z.tuple([
  z.number().int().nonnegative(),
  z.string().min(1),
  z.string().min(1),
  z.enum(ITEM_OS_VALUES).nullable(),
]);

/** A notice's id: the change it names, opaque to the screen; made and read here only. */
function noticeIdOf(row: AuthnNoticeRow): string {
  return JSON.stringify([row.revision, row.kind, row.key, row.os]);
}

function changedByOf(
  hostId: string | null,
  hostName: string | null,
): EnvironmentChangedBy {
  return hostId === null
    ? { kind: "dashboard" }
    : { kind: "host", hostId, hostLabel: hostName };
}

/**
 * The environment's notices as the page lists them, each with Undo: every
 * change of the last 30 days that displaced a value Undo can restore.
 */
export async function readNotices(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentNotice[]> {
  const { notices: rows } = parseReview(
    await sendReview(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/notices`,
      null,
      OFFLINE_MESSAGE,
    ),
    authnNoticesResponseSchema,
  );
  const notices: EnvironmentNotice[] = [];
  for (const row of rows) {
    const kind = environmentItemKindSchema.safeParse(row.kind);
    if (!kind.success) continue;
    notices.push({
      noticeId: noticeIdOf(row),
      kind: kind.data,
      key: row.key,
      os: row.os ?? "any",
      source: row.source,
      from: changedByOf(row.hostId, row.hostName),
      writtenAt: row.writtenAt,
      // Listed only while no later change on its key superseded it.
      undoAvailable: true,
    });
  }
  return notices;
}

/**
 * Undo of one notice (`POST …/changes/:revision/undo`), answered as the
 * host's `environment.undo` was: a 403 is `needs_grant`, a later change on
 * the key is `stale`, and a change Undo cannot restore is refused.
 */
export async function undoNotice(
  cloud: EnvironmentCloud,
  environmentId: string,
  noticeId: string,
): Promise<EnvironmentWriteOutcome> {
  let address: z.infer<typeof noticeAddressSchema> | null = null;
  try {
    const parsed = noticeAddressSchema.safeParse(JSON.parse(noticeId));
    if (parsed.success) address = parsed.data;
  } catch {
    address = null;
  }
  if (address === null) {
    throw new EnvironmentCloudError("refused", NOTICE_GONE_MESSAGE);
  }
  const [revision, kind, key, os] = address;
  const answer = await sendReview(
    cloud,
    "POST",
    `${environmentPath(environmentId)}/changes/${encodeURIComponent(String(revision))}/undo`,
    { kind, key, os },
    OFFLINE_MESSAGE,
  );
  if (answer.status === 403) return { outcome: "needs_grant" };
  if (answer.status === 409) {
    const refused = authnUndoConflictSchema.safeParse(answer.body);
    if (refused.success && refused.data.code === "superseded") {
      const current = refused.data.current;
      return {
        outcome: "stale",
        currentRevision: current?.revision ?? null,
        changedBy: changedByOf(
          current?.writtenBy.hostId ?? null,
          current?.writtenBy.hostName ?? null,
        ),
      };
    }
    if (refused.success) {
      throw new EnvironmentCloudError("refused", NOTICE_GONE_MESSAGE);
    }
  }
  const undone = parseReview(answer, authnUndoResponseSchema);
  return { outcome: "saved", revision: undone.item.revision };
}
