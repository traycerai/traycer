import { z } from "zod";
import {
  draftComposerPortableSchema,
  draftComposerPortableWriteSchema,
  draftInterviewPortableSchema,
  draftStashPortableSchema,
  draftTargetSchema,
  draftWorkspaceSnapshotSchema,
  type DraftDialectKind,
  type DraftSurfaceKind,
} from "@traycer/protocol/persistence/draft/schemas";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Host <-> client wire shapes for the live draft store.
 *
 * ## Optional capability
 *
 * Every unary method is registered `degrade: { kind: "unsupported" }` and
 * none is on the released floor. A host that predates this surface answers
 * `E_HOST_UNSUPPORTED`; the client's contract is today's device-local
 * drafts, an absent capability rather than a broken one.
 *
 * ## Two kind vocabularies
 *
 * The wire `kind` is the UI surface
 * (`landing | new-chat | chat-composer | interview | stash-entry`). The
 * published `draft/v1` dialect collapses the first three to `kind: "draft"`
 * and keeps the screen identity in `surfaceKind`. Mapping helpers live
 * beside these schemas so host and client cannot drift.
 */

export const draftKindSchema = lazySchema(() =>
  z.enum(["landing", "new-chat", "chat-composer", "interview", "stash-entry"]),
);
export type DraftKind = z.infer<typeof draftKindSchema>;

export const draftOriginSchema = lazySchema(() => z.enum(["own", "replica"]));
export type DraftOrigin = z.infer<typeof draftOriginSchema>;

/**
 * Host-projected adoption. The host store only holds adopted drafts
 * (upsert of an unknown id creates); unadopted landing drafts never
 * leave the client.
 */
export const draftAdoptionSchema = lazySchema(() =>
  z.object({
    state: z.literal("adopted"),
    hostId: z.string().min(1),
  }),
);
export type DraftAdoption = z.infer<typeof draftAdoptionSchema>;

/**
 * Publication halt causes for the drafts-scope backup indicator. Chat
 * backup's set plus `stale-authority` — the self-resolving cause a publish
 * lands on when the cloud row's authority epoch has moved past this host.
 */
export const draftPublicationHaltCauseSchema = lazySchema(() =>
  z.enum([
    "conflict",
    "quarantined",
    "repair-pending",
    "forked-lineage",
    "too-large",
    "escalation",
    "plan-ineligible",
    "stale-authority",
  ]),
);
export type DraftPublicationHaltCause = z.infer<
  typeof draftPublicationHaltCauseSchema
>;

export const draftPublicationStatusSchema = lazySchema(() =>
  z.enum(["unpublished", "current", "behind", "unknown"]),
);
export type DraftPublicationStatus = z.infer<
  typeof draftPublicationStatusSchema
>;

export const draftPublicationSchema = lazySchema(() =>
  z.object({
    status: draftPublicationStatusSchema,
    lastPublishedAt: z.number().int().nonnegative().nullable(),
    publishedRevision: z.number().int().nonnegative().nullable(),
    halted: z
      .object({
        cause: draftPublicationHaltCauseSchema,
        since: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
);
export type DraftPublication = z.infer<typeof draftPublicationSchema>;

/**
 * A draft is mutated only by the host it was created on; ownership never
 * moves. A device editing a draft another host owns FORKS it: a new id on
 * its own host, the same content, and a one-shot `supersedes` pointer to
 * the ancestor. The fork's host retires the ancestor's cloud row once the
 * fork is first published or deleted; the ancestor's host, finding its row
 * tombstoned, deletes its local row if unchanged since its last publication
 * and otherwise re-mints it under a fresh id (again with `supersedes`).
 */
const draftDocumentCommonFields = {
  draftId: lazySchema(() => z.string().min(1)),
  target: draftTargetSchema,
  revision: lazySchema(() => z.number().int().nonnegative()),
  lastTouchedAt: lazySchema(() => z.number().int().nonnegative()),
  workspace: lazySchema(() => draftWorkspaceSnapshotSchema.nullable()),
  ownerHostId: lazySchema(() => z.string().min(1)),
  origin: draftOriginSchema,
  adoption: draftAdoptionSchema,
  publication: draftPublicationSchema,
  /**
   * Host-authored echo of `DraftWrite.supersedes`, also set by a host
   * re-mint: the ancestor draft id this row replaces. A client that still
   * has the ancestor open re-keys that tab onto this row in place (the
   * upsert precedes the ancestor's delete frame). Cleared to `null`
   * once the supersession debt is paid, so a cold `drafts.list` never
   * re-keys on a stale pointer. Defaulted on the wire, not required: a host
   * that predates supersession still lists and echoes its rows.
   */
  supersedes: lazySchema(() => z.string().min(1).nullable().default(null)),
} as const;

const draftWriteCommonFields = {
  draftId: lazySchema(() => z.string().min(1)),
  target: draftTargetSchema,
  /**
   * Base revision the client last saw. `0` on first create. The host
   * accepts unconditionally (whole-document LWW) and bumps.
   */
  revision: lazySchema(() => z.number().int().nonnegative()),
  lastTouchedAt: lazySchema(() => z.number().int().nonnegative()),
  workspace: lazySchema(() => draftWorkspaceSnapshotSchema.nullable()),
  /**
   * Write-plane only. An ancestor draft id whose cloud row this host
   * retracts once the written draft is first published or deleted. Sent on
   * the fork's FIRST upsert and `null` on every other write. Never enters
   * the `draft/v1` head; the dialect and its `{1,0}` pin do not change.
   * Defaulted on the wire, like the document's echo: a write that omits it
   * owes nothing.
   */
  supersedes: lazySchema(() => z.string().min(1).nullable().default(null)),
} as const;

export const draftDocumentSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      ...draftDocumentCommonFields,
      kind: z.literal("landing"),
      portable: draftComposerPortableSchema,
    }),
    z.object({
      ...draftDocumentCommonFields,
      kind: z.literal("new-chat"),
      portable: draftComposerPortableSchema,
    }),
    z.object({
      ...draftDocumentCommonFields,
      kind: z.literal("chat-composer"),
      portable: draftComposerPortableSchema,
    }),
    z.object({
      ...draftDocumentCommonFields,
      kind: z.literal("interview"),
      portable: draftInterviewPortableSchema,
    }),
    z.object({
      ...draftDocumentCommonFields,
      kind: z.literal("stash-entry"),
      portable: draftStashPortableSchema,
    }),
  ]),
);
export type DraftDocument = z.infer<typeof draftDocumentSchema>;

export const draftWriteSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      ...draftWriteCommonFields,
      kind: z.literal("landing"),
      portable: draftComposerPortableWriteSchema,
    }),
    z.object({
      ...draftWriteCommonFields,
      kind: z.literal("new-chat"),
      portable: draftComposerPortableWriteSchema,
    }),
    z.object({
      ...draftWriteCommonFields,
      kind: z.literal("chat-composer"),
      portable: draftComposerPortableWriteSchema,
    }),
    z.object({
      ...draftWriteCommonFields,
      kind: z.literal("interview"),
      portable: draftInterviewPortableSchema,
    }),
    z.object({
      ...draftWriteCommonFields,
      kind: z.literal("stash-entry"),
      portable: draftStashPortableSchema,
    }),
  ]),
);
export type DraftWrite = z.infer<typeof draftWriteSchema>;

export const draftsUpsertRequestSchema = lazySchema(() =>
  z.object({
    draft: draftWriteSchema,
  }),
);
export type DraftsUpsertRequest = z.infer<typeof draftsUpsertRequestSchema>;

export const draftsUpsertResponseSchema = lazySchema(() =>
  z.object({
    draft: draftDocumentSchema,
  }),
);
export type DraftsUpsertResponse = z.infer<typeof draftsUpsertResponseSchema>;

export const draftsDeleteRequestSchema = lazySchema(() =>
  z.object({
    draftId: z.string().min(1),
  }),
);
export type DraftsDeleteRequest = z.infer<typeof draftsDeleteRequestSchema>;

/** Idempotent: `deleted` is false when the row was already gone. */
export const draftsDeleteResponseSchema = lazySchema(() =>
  z.object({
    deleted: z.boolean(),
  }),
);
export type DraftsDeleteResponse = z.infer<typeof draftsDeleteResponseSchema>;

export const draftsListRequestSchema = lazySchema(() => z.object({}));
export type DraftsListRequest = z.infer<typeof draftsListRequestSchema>;

/**
 * A retained `deleted = 1` row. `drafts.list` returns these beside live
 * rows so a reconnecting client can apply an authoritative delete it
 * missed while disconnected (submit on A, B offline, B reconnects).
 * `revision` is the tombstone's revision: hold
 * `{ kind: "tombstone", revision }` so a later higher-revision upsert
 * still revives.
 *
 * `positive()`, and the `delete` subscribe frame's `revision` is the same
 * domain: a deletion is a BUMP of the row's revision, so `0` names no
 * deletion at all. Splitting the two would let a host emit a delete a
 * `drafts.list` could not represent, and the reconnecting client would then
 * order that id by `storeSeq` instead of by revision.
 */
export const draftListTombstoneSchema = lazySchema(() =>
  z.object({
    draftId: z.string().min(1),
    revision: z.number().int().positive(),
  }),
);
export type DraftListTombstone = z.infer<typeof draftListTombstoneSchema>;

export const draftsListResponseSchema = lazySchema(() =>
  z.object({
    /**
     * Personal `drafts` scope id (`scp_…`) this host resolved for the
     * caller, or `null` when cloud publication is gated or not yet
     * ready. The client lists published drafts through the byte-pipe
     * (`epic.listCloudChats` + `epic.resolveCloudChatHead`) against this
     * task id. Optional on the wire so fixtures that predate T8 still
     * parse; a live host that implements T6 always sends it.
     */
    scopeId: z.string().min(1).nullable().optional(),
    drafts: z.array(draftDocumentSchema),
    /**
     * Every retained tombstone at this snapshot. Always present (empty
     * when none). Live `drafts` never include these ids; a reconnecting
     * client must treat each as an authoritative delete rather than
     * inferring deletion from absence.
     */
    tombstones: z.array(draftListTombstoneSchema),
    /**
     * Store-wide sequence the listing reflects. Host bumps `storeSeq` on
     * every draft-store mutation (upsert and delete). A subscribe frame
     * against `absent` applies only when `frame.storeSeq > snapshotSeq`.
     *
     * MUST (frontier atomicity): sequence allocation commits atomically
     * with its mutation, and `snapshotSeq` is captured under the same
     * serialized frontier as BOTH the live rows and `tombstones`. The
     * response reflects EVERY mutation with `storeSeq <= snapshotSeq`
     * and NONE with `storeSeq > snapshotSeq`. Forbidden: read rows, then
     * let a create commit at 21, then stamp `snapshotSeq = 21` — the
     * buffered create frame is equal-seq and dropped forever.
     */
    snapshotSeq: z.number().int().nonnegative(),
  }),
);
export type DraftsListResponse = z.infer<typeof draftsListResponseSchema>;

/**
 * Retract the cloud row of a draft this host holds NO row for: a foreign
 * draft (another host's, listed here through the account directory) the
 * user deleted from History. The host deletes the row through
 * `cloud.deleteChat` in the caller's drafts scope; the owning host then
 * finds its row tombstoned and applies its own tombstone rule. A live own
 * row for the id is a `drafts.delete`, not a retract, and is refused.
 * Kept separate from `drafts.delete` so an absent local row stays an
 * honest `{ deleted: false }` there.
 */
export const draftsRetractRequestSchema = lazySchema(() =>
  z.object({
    draftId: z.string().min(1),
  }),
);
export type DraftsRetractRequest = z.infer<typeof draftsRetractRequestSchema>;

/** Idempotent: `retracted` is false when the cloud row was already gone. */
export const draftsRetractResponseSchema = lazySchema(() =>
  z.object({
    retracted: z.boolean(),
  }),
);
export type DraftsRetractResponse = z.infer<typeof draftsRetractResponseSchema>;

/** Lowercase hex sha256 — the only form a draft blob address is written in. */
export const draftBlobSha256Schema = lazySchema(() =>
  z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex sha256 digest"),
);
export type DraftBlobSha256 = z.infer<typeof draftBlobSha256Schema>;

/**
 * Write one content-addressed image blob into the host-wide draft store.
 * Idempotent: a second put of the same digest is a success, not an error.
 * The host hashes the decoded bytes and refuses a digest mismatch before
 * storing. Unary base64, same posture as `epic.readChatAttachment`.
 */
export const draftsPutBlobRequestSchema = lazySchema(() =>
  z.object({
    sha256: draftBlobSha256Schema,
    /** Base64 of the RAW bytes — what `sha256` is over. */
    bytesBase64: z.string(),
  }),
);
export type DraftsPutBlobRequest = z.infer<typeof draftsPutBlobRequestSchema>;

/**
 * The `@1.1` wire ceiling for one draft blob, in base64 CHARACTERS: the
 * 5 MiB decoded ceiling the client's image preparation targets, expanded by
 * base64's 4-chars-per-3-bytes ratio.
 *
 * Decoded rather than encoded because the ceiling is a statement about the
 * IMAGE - every provider budget, the preparation ladder and the host store's
 * own guard are all in decoded bytes - and a cap written in encoded characters
 * would drift from all of them.
 */
export const DRAFT_BLOB_MAX_BYTES = 5 * 1024 * 1024;
export const DRAFT_BLOB_MAX_BASE64_LENGTH =
  Math.ceil(DRAFT_BLOB_MAX_BYTES / 3) * 4;

/**
 * `drafts.putBlob@1.1` - the `@1.0` request with `bytesBase64` capped.
 *
 * A NEW INSTANCE, and `draftsPutBlobRequestSchema` stays pinned to
 * `draftsPutBlobV10`: narrowing a released request schema in place would refuse
 * a payload a released client is entitled to send, which is the one direction
 * a same-version edit can break a peer that is already in the field.
 *
 * A DECLARATION, NOT THE ENFORCEMENT. It bites only when both peers negotiate
 * `>= 1.1`, so it can never be the thing standing between an oversized image
 * and the disk. The enforcement is the host store's version-independent decoded
 * cap in `FileDraftBlobStore.put`, plus the client's own pre-send guard; what
 * this buys is that an over-cap body is refused at the PARSE, before a
 * multi-megabyte string is chunked onto the wire and re-materialized on the
 * host's event loop.
 */
export const draftsPutBlobRequestSchemaV11 = lazySchema(() =>
  z.object({
    sha256: draftBlobSha256Schema,
    /** Base64 of the RAW bytes — what `sha256` is over. */
    bytesBase64: z.string().max(DRAFT_BLOB_MAX_BASE64_LENGTH),
  }),
);
export type DraftsPutBlobRequestV11 = z.infer<
  typeof draftsPutBlobRequestSchemaV11
>;

export const draftsPutBlobResponseSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true) }),
    z.object({
      ok: z.literal(false),
      reason: z.literal("digest-mismatch"),
    }),
  ]),
);
export type DraftsPutBlobResponse = z.infer<typeof draftsPutBlobResponseSchema>;

/**
 * Read one blob a draft's `blobHashes` names. The second-device path:
 * a client that did not author the draft asks the host, not a local
 * partition. Missing and corrupt both collapse to `missing` (fail
 * closed per-image). Transient IO rides the RPC error channel.
 *
 * Named `readBlob` to match `epic.readChatAttachment` (unary base64
 * byte fetch).
 */
export const draftsReadBlobRequestSchema = lazySchema(() =>
  z.object({
    sha256: draftBlobSha256Schema,
  }),
);
export type DraftsReadBlobRequest = z.infer<typeof draftsReadBlobRequestSchema>;

export const draftsReadBlobResponseSchema = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      bytesBase64: z.string(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.literal("missing"),
    }),
  ]),
);
export type DraftsReadBlobResponse = z.infer<
  typeof draftsReadBlobResponseSchema
>;

/**
 * `drafts.readBlob@1.1` - the same two arms with the SAME cap on the returned
 * body, so the ceiling is one fact about a draft blob rather than a rule that
 * only applies on the way in.
 *
 * The cap lands on the response because that is where this method's bytes are;
 * its request carries only a digest, and `draftsReadBlobRequestSchema` is
 * therefore shared by both minors unchanged.
 *
 * A `@1.1` reader that meets an over-cap body fails that one hash's parse,
 * which the transport already treats exactly as `missing`: the per-image skip
 * that renders the attachment unavailable. Such a body can only come from a
 * blob written before the store's own decoded cap existed, so the alternative -
 * no ceiling on the read line at all - would keep an unbounded string
 * reachable on a path the write side has already closed.
 */
export const draftsReadBlobResponseSchemaV11 = lazySchema(() =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      bytesBase64: z.string().max(DRAFT_BLOB_MAX_BASE64_LENGTH),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.literal("missing"),
    }),
  ]),
);
export type DraftsReadBlobResponseV11 = z.infer<
  typeof draftsReadBlobResponseSchemaV11
>;

const textFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(false)),
} as const;

export const draftsSubscribeOpenRequestSchemaV10 = lazySchema(() =>
  z.object({}),
);
export type DraftsSubscribeOpenRequestV10 = z.infer<
  typeof draftsSubscribeOpenRequestSchemaV10
>;

const storeSeqField = {
  /**
   * Host-store monotonic sequence of this mutation. Distinct from
   * per-draft `revision`: two drafts' revisions are incomparable, and
   * a deleted id is omitted from `drafts.list`, so bootstrap `absent`
   * has no revision to compare. `storeSeq` is the frontier that bounds
   * that case.
   *
   * MUST (restart): `storeSeq` is durably persisted and strictly
   * monotonic across host restarts. There is no epoch field on this
   * wire and one MUST NOT be added. Reset-on-restart would close
   * streams, discard buffers, and mandate a fresh list — the host
   * already has durable storage; keep the sequence.
   *
   * MUST (frontier atomicity): the allocated `storeSeq` commits in
   * the same transaction as the mutation it numbers. A seq that
   * outlives a rolled-back write (or a write that outlives its seq)
   * breaks the list/subscribe merge.
   */
  storeSeq: lazySchema(() => z.number().int().nonnegative()),
} as const;

/**
 * Host-scoped draft change frames. `drafts.list` is the snapshot
 * (live rows + `tombstones`); (re)connect means re-read the list,
 * apply tombstones as held deletes, then apply what arrives.
 *
 * A host re-mint (its cloud row was tombstoned by a fork elsewhere while
 * the row had unpublished edits) is an ordinary `upsert` frame whose
 * document carries `supersedes`, FOLLOWED by a `delete` frame for the old
 * id: a client with the old id open re-keys its tab onto the successor
 * before the ancestor is removed, and the delete then finds nothing.
 *
 * Merge rule (`draftSubscribeFrameApplies` is the executable form):
 * - held **present** (row or tombstone): apply iff
 *   `frame.revision > held.revision`. Tombstones retain revision and
 *   storeSeq; a later higher-revision upsert revives.
 * - held **absent**: apply iff `frame.storeSeq > snapshotSeq` of the
 *   bootstrap listing. A genuinely new draft (or a post-snapshot
 *   delete of an unknown id) passes; a buffered pre-snapshot upsert
 *   of an id the listing omitted because it was already deleted is
 *   dropped. Equal storeSeq is dropped.
 *
 * These two MUST statements are part of the merge rule, not host
 * folklore. T5 implements them; T7 relies on them.
 *
 * MUST (frontier atomicity): seq allocation commits atomically with
 * its mutation, and `snapshotSeq` is captured under the same
 * serialized frontier. A list response reflects every mutation with
 * `storeSeq <= snapshotSeq`. Stamping `snapshotSeq` after a later
 * mutation has committed (the "list rows, create at 21, stamp 21"
 * race) makes that create equal-seq and drops it forever.
 *
 * MUST (restart): `storeSeq` is durably persisted and strictly
 * monotonic across host restarts. Do not add an epoch field.
 */
export const draftsSubscribeServerFrameSchemaV10 = lazySchema(() =>
  z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("upsert"),
        ...textFrameFields,
        ...storeSeqField,
        draftId: z.string().min(1),
        revision: z.number().int().nonnegative(),
        draft: draftDocumentSchema,
      }),
      z.object({
        kind: z.literal("delete"),
        ...textFrameFields,
        ...storeSeqField,
        draftId: z.string().min(1),
        // Same domain as `draftListTombstoneSchema.revision` - see there.
        revision: z.number().int().positive(),
      }),
      z.object({
        kind: z.literal("pong"),
        ...textFrameFields,
      }),
      /**
       * Advisory: the host's personal drafts-scope id resolved after
       * `drafts.list` returned `scopeId: null`. No `storeSeq` — this is
       * not a store mutation. A client that never sees it keeps the
       * cloud-drafts section absent (hide-not-fail), never errors.
       */
      z.object({
        kind: z.literal("scope"),
        ...textFrameFields,
        scopeId: z.string().min(1),
      }),
    ])
    .superRefine((frame, ctx) => {
      if (frame.kind !== "upsert") return;
      if (frame.draftId !== frame.draft.draftId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["draftId"],
          message:
            "An upsert's envelope must address the row it carries - `draftId` must equal `draft.draftId`.",
        });
      }
      if (frame.revision !== frame.draft.revision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revision"],
          message:
            "An upsert's envelope must order by the row it carries - `revision` must equal `draft.revision`.",
        });
      }
    }),
);
export type DraftsSubscribeServerFrameV10 = z.infer<
  typeof draftsSubscribeServerFrameSchemaV10
>;

/**
 * Local state the subscribe apply rule compares against. After
 * `drafts.list`, every returned row is `row`; an id the listing omitted
 * is `absent` (deleted and never-existed are indistinguishable). An
 * applied delete becomes `tombstone` (retains revision and storeSeq)
 * rather than `absent`, so a later stale frame is still comparable.
 */
export type DraftHeldRevisionState =
  | { readonly kind: "absent" }
  | { readonly kind: "row"; readonly revision: number }
  | {
      readonly kind: "tombstone";
      readonly revision: number;
      readonly storeSeq: number;
    };

export type DraftSubscribeFrameFrontier = {
  readonly revision: number;
  readonly storeSeq: number;
};

/**
 * Whether a subscribe `upsert` or `delete` may change local state.
 * Present held state is ordered by per-draft revision; absent held
 * state is ordered by the store-wide sequence against the list
 * snapshot. T5/T7 must call this — do not re-derive the rule.
 *
 * The helper assumes the host honored frontier atomicity and durable
 * restart monotonicity (see `snapshotSeq` / `storeSeq`). A list that
 * stamped `snapshotSeq` after a later mutation committed will make
 * this function drop that mutation forever (`storeSeq == snapshotSeq`).
 */
export function draftSubscribeFrameApplies(
  held: DraftHeldRevisionState,
  frame: DraftSubscribeFrameFrontier,
  snapshotSeq: number,
): boolean {
  if (held.kind === "absent") {
    return frame.storeSeq > snapshotSeq;
  }
  return frame.revision > held.revision;
}

/**
 * `flush` is the publication trigger on draft close / client blur
 * (decision log #10). `draftIds` names the drafts to publish now.
 * Empty is a no-op on both sides — a client with nothing pending must
 * not be read as "every dirty draft this host knows about".
 */
export const draftsSubscribeClientFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("flush"),
      ...textFrameFields,
      draftIds: z.array(z.string().min(1)),
    }),
  ]),
);
export type DraftsSubscribeClientFrameV10 = z.infer<
  typeof draftsSubscribeClientFrameSchemaV10
>;

export type { DraftDialectKind, DraftSurfaceKind };

export function draftDialectKindOf(kind: DraftKind): DraftDialectKind {
  if (kind === "interview") return "interview";
  if (kind === "stash-entry") return "stash-entry";
  return "draft";
}

export function draftSurfaceKindOf(kind: DraftKind): DraftSurfaceKind | null {
  if (kind === "landing" || kind === "new-chat" || kind === "chat-composer") {
    return kind;
  }
  return null;
}
