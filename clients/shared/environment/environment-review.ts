// authn checks a hold's revision and the live one and consumes the hold in one
// transaction. The app's own saves match holds by digest, never value. Answers a
// person acts on (a moved hold or live item, a hold gone) are outcomes, not errors.
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
  settingValueSchema,
  type SettingValue,
} from "@traycer/protocol/host/environment/settings-proposals";
import { canonicalSettingValue } from "@traycer/protocol/host/environment/settings-save-mapping";
import { utf8Bytes, webCryptoSha256Hex } from "../cloud-chat/bytes";
import {
  ITEM_OS_VALUES,
  REVIEW_INCLUDE_OPERATION,
  authnHeldApplyConflictSchema,
  authnNoticesResponseSchema,
  authnOperationReviewResponseSchema,
  authnUndoConflictSchema,
  authnUndoResponseSchema,
  type AuthnNoticeRow,
} from "./authn-environment-schemas";
import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  NEEDS_PERMISSION_MESSAGE,
  environmentPath,
  errorBodyCode,
  isRedirect,
  isSuccess,
  sendSettings,
  type EnvironmentAnswer,
  type EnvironmentCloud,
  type EnvironmentHttpMethod,
} from "./environment-cloud";

const OFFLINE_MESSAGE = "This needs a connection to your environment.";
const REVIEW_OFFLINE_MESSAGE = "Connect to review these settings.";
const REFUSED_MESSAGE = "Your environment did not accept this change.";
const NOTICE_GONE_MESSAGE = "This notice is no longer available.";

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

function reviewRefusal(answer: EnvironmentAnswer): EnvironmentCloudError {
  return isRedirect(answer)
    ? new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE)
    : new EnvironmentCloudError("refused", REFUSED_MESSAGE);
}

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

/** A held value is read for the masked line alone; never kept, logged or shown unmasked. */
export type ReviewHeldEntry = EnvironmentReviewEntryV12 & {
  readonly op: "put" | "delete";
  readonly heldRevision: number;
  readonly liveRevision: number | null;
  /** Host-proposal holds carry a generation. Historical Move holds do not. */
  readonly sharingGeneration?: number;
};

const NO_HELD_FACTS = {
  command: null,
  description: null,
  harness: null,
  value: null,
} as const;

export async function readEnvironmentReview(
  cloud: EnvironmentCloud,
  environmentId: string,
) {
  return readProjectedReview(cloud, environmentId, ({ entry }) => entry);
}

/** Values exist only while a caller makes its validated, masked projection. */
export interface ReviewHeldProjectionInput {
  readonly entry: ReviewHeldEntry;
  readonly proposed: unknown;
  readonly current: {
    readonly revision: number;
    readonly value: unknown;
  } | null;
}

/** Projected before its answer enters a query cache. */
export async function readProjectedReviewHolds<Projection>(
  cloud: EnvironmentCloud,
  environmentId: string,
  project: (input: ReviewHeldProjectionInput) => Projection,
): Promise<readonly Projection[]> {
  const { entries } = await readProjectedReview(cloud, environmentId, project);
  return entries;
}

async function readProjectedReview<Projection>(
  cloud: EnvironmentCloud,
  environmentId: string,
  project: (input: ReviewHeldProjectionInput) => Projection,
): Promise<{
  readonly entries: readonly Projection[];
  readonly uploadedHostIds: readonly string[];
}> {
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
  const holds: Projection[] = [];
  for (const entry of review?.needsYou ?? []) {
    // Authn's `needs_link` entries are not shown on any surface.
    if (entry.type !== "held") continue;
    const kind = environmentItemKindSchema.safeParse(entry.kind);
    if (!kind.success) continue;
    const held: ReviewHeldEntry = {
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
      // authn's held change names no trigger for any kind it holds.
      event: null,
      op: entry.op,
      heldRevision: entry.revision,
      liveRevision: entry.live?.revision ?? null,
      ...(entry.sharingGeneration === null
        ? {}
        : { sharingGeneration: entry.sharingGeneration }),
    };
    holds.push(
      project({ entry: held, proposed: entry.value, current: entry.live }),
    );
  }
  return {
    entries: holds,
    uploadedHostIds: (review?.hosts ?? [])
      .filter((host) => host.uploadedSettings === true)
      .map((host) => host.hostId),
  };
}

export interface ReviewChoiceOutcome {
  readonly outcome: "applied" | "conflict" | "gone" | "forbidden";
}

function choiceOutcome(
  answer: EnvironmentAnswer,
  choice: "approve" | "discard",
): ReviewChoiceOutcome {
  if (answer.status === 403) return { outcome: "forbidden" };
  if (answer.status === 409 && choice === "approve") {
    const conflict = authnHeldApplyConflictSchema.safeParse(answer.body);
    if (conflict.success && conflict.data.code === "revision_conflict") {
      return { outcome: "conflict" };
    }
  }
  if (answer.status === 404 || answer.status === 409)
    return { outcome: "gone" };
  if (!isSuccess(answer)) throw reviewRefusal(answer);
  return { outcome: "applied" };
}

/** Of two windows applying one hold, one writes it; the other gets a replay of that write or `gone`. */
export async function applyHeldChange(
  cloud: EnvironmentCloud,
  environmentId: string,
  hold: {
    readonly heldId: string;
    readonly revision: number;
    readonly expectedLiveRevision: number | null;
  },
): Promise<ReviewChoiceOutcome> {
  return choiceOutcome(
    await sendReview(
      cloud,
      "POST",
      heldPath(environmentId, hold.heldId, "apply"),
      {
        revision: hold.revision,
        expectedLiveRevision: hold.expectedLiveRevision,
      },
      REVIEW_OFFLINE_MESSAGE,
    ),
    "approve",
  );
}

export async function applyReviewChoice(
  cloud: EnvironmentCloud,
  environmentId: string,
  entry: Pick<ReviewHeldEntry, "entryId" | "heldRevision" | "liveRevision">,
  choice: "approve" | "discard",
): Promise<ReviewChoiceOutcome> {
  if (choice === "approve") {
    return applyHeldChange(cloud, environmentId, {
      heldId: entry.entryId,
      revision: entry.heldRevision,
      expectedLiveRevision: entry.liveRevision,
    });
  }
  return choiceOutcome(
    await sendReview(
      cloud,
      "POST",
      heldPath(environmentId, entry.entryId, "discard"),
      { revision: entry.heldRevision },
      REVIEW_OFFLINE_MESSAGE,
    ),
    "discard",
  );
}

/** The value is read only to take its digest and is never returned. */
export interface HeldChangeForMatch {
  readonly heldId: string;
  readonly revision: number;
  readonly kind: string;
  readonly key: string;
  readonly os: string | null;
  readonly op: "put" | "delete";
  readonly hostId: string;
  /** Null for a hold stored before authn recorded it; it matches no save. */
  readonly sharingGeneration: number | null;
  /** Null for a delete and for a value that is no item value; either matches no save. */
  readonly valueDigest: string | null;
}

/** SHA-256, as lowercase hex, of a value's one canonical text. */
export function settingValueDigest(value: SettingValue): Promise<string> {
  return webCryptoSha256Hex(utf8Bytes(canonicalSettingValue(value)));
}

export async function readHeldChangesForMatch(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<readonly HeldChangeForMatch[]> {
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
  const holds: HeldChangeForMatch[] = [];
  for (const entry of review?.needsYou ?? []) {
    if (entry.type !== "held") continue;
    let valueDigest: string | null = null;
    if (entry.op === "put") {
      const value = settingValueSchema.safeParse(entry.value);
      valueDigest = value.success ? await settingValueDigest(value.data) : null;
    }
    holds.push({
      heldId: entry.heldId,
      revision: entry.revision,
      kind: entry.kind,
      key: entry.key,
      os: entry.os,
      op: entry.op,
      hostId: entry.hostId,
      sharingGeneration: entry.sharingGeneration,
      valueDigest,
    });
  }
  return holds;
}

const noticeAddressSchema = z.tuple([
  z.number().int().nonnegative(),
  z.string().min(1),
  z.string().min(1),
  z.enum(ITEM_OS_VALUES).nullable(),
]);

/** Opaque to the screen; made and read here only. */
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
 * `undoAvailable` says only that nothing superseded the change, not that this
 * reader may undo it: listing needs `read`, Undo `write`.
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
      undoAvailable: true,
    });
  }
  return notices;
}

/** authn applies an Undo at once, so it is never `pending`. */
export type UndoOutcome = Exclude<
  EnvironmentWriteOutcome,
  { readonly outcome: "pending" }
>;

/**
 * authn asks a grant of the host alone, so a 403 `executable_write_needs_grant` is
 * `needs_grant`; any other 403 is the person's role.
 */
export async function undoNotice(
  cloud: EnvironmentCloud,
  environmentId: string,
  noticeId: string,
): Promise<UndoOutcome> {
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
  if (answer.status === 403) {
    if (errorBodyCode(answer.body) === "executable_write_needs_grant")
      return { outcome: "needs_grant" };
    throw new EnvironmentCloudError("forbidden", NEEDS_PERMISSION_MESSAGE);
  }
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
