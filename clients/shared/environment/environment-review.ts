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
  type EnvironmentReviewHeldApplyResponse,
  type EnvironmentWriteOutcome,
} from "@traycer/protocol/host/environment-schemas";
import { heldFactsOf } from "@traycer/protocol/host/environment/held-facts";
import {
  ITEM_OS_VALUES,
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
  EnvironmentCloudError,
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

/** The holds of an environment's review, each as the sheet lists it. */
export async function readReviewHolds(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<readonly ReviewHeldEntry[]> {
  const review = await readOperationReview(cloud, environmentId);
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
 * The review sheet's choice on one hold, as the host answered it: written,
 * gone, or not the person's to make. A hold or live item that moved since the
 * list read it is `gone` too: the row stays in the review, and the reread
 * draws it as it is now.
 */
export async function applyReviewChoice(
  cloud: EnvironmentCloud,
  environmentId: string,
  entry: ReviewHeldEntry,
  choice: "approve" | "discard",
): Promise<EnvironmentReviewHeldApplyResponse> {
  try {
    const answer =
      choice === "approve"
        ? await applyHeldChange(cloud, environmentId, {
            heldId: entry.entryId,
            revision: entry.heldRevision,
            expectedLiveRevision: entry.liveRevision,
          })
        : await discardHeldChange(
            cloud,
            environmentId,
            entry.entryId,
            entry.heldRevision,
          );
    return answer.outcome === "applied" || answer.outcome === "discarded"
      ? { outcome: "applied" }
      : { outcome: "gone" };
  } catch (error) {
    if (error instanceof EnvironmentCloudError && error.kind === "forbidden") {
      return { outcome: "forbidden" };
    }
    throw error;
  }
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

/** The environment's notices as the page lists them, each with Undo. */
export async function readNotices(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentNotice[]> {
  const notices: EnvironmentNotice[] = [];
  for (const row of await readChangeNotices(cloud, environmentId)) {
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

/** The words a notice that no longer names an undoable change is refused with. */
const NOTICE_GONE_MESSAGE = "This notice is no longer available.";

/** Undo of one notice, answered as the host's `environment.undo` was. */
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
    throw new EnvironmentCloudError("invalid", NOTICE_GONE_MESSAGE);
  }
  const [revision, kind, key, os] = address;
  const undone = await undoChange(cloud, environmentId, {
    revision,
    kind,
    key,
    os,
  });
  if (undone.outcome === "undone") {
    return { outcome: "saved", revision: undone.item.revision };
  }
  if (undone.outcome === "superseded") {
    return {
      outcome: "stale",
      currentRevision: undone.current?.revision ?? null,
      changedBy: changedByOf(
        undone.current?.writtenBy.hostId ?? null,
        undone.current?.writtenBy.hostName ?? null,
      ),
    };
  }
  throw new EnvironmentCloudError("invalid", NOTICE_GONE_MESSAGE);
}
