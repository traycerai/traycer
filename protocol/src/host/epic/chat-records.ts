import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { cloudChatVisibilitySchema } from "@traycer/protocol/host/epic/cloud-chat";
import { tuiAgentRecordSummarySchema } from "@traycer/protocol/host/epic/tui-agent-records";
// The PERSISTED variant, with its `.default(...)` backstops, and not the
// wire-strict one: this is a read of a record that may have been written before
// `serviceTier` or `profileId` existed, and the strict schema exists to stop a
// partial WRITE from null-clobbering fields it never looked at. Parsing a
// legacy record with it would fail the read outright.
import {
  agentModeSchema,
  chatRunSettingsSchema,
  guiHarnessIdSchema,
  permissionModeSchema,
} from "@traycer/protocol/persistence/epic/foundation";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

/**
 * The epic's chat RECORDS, as its serving host's chat registry holds them.
 *
 * ## Why this method exists at all
 *
 * The renderer's chat record set - which chats exist, what they are called,
 * where they sit in the agent tree, whether they are archived - had exactly one
 * producer: the epic Y.Doc's `chats` map. That was true while the document was
 * the registry. It stopped being true in chat-sync-v2: creation no longer writes
 * a doc record (ticket 19, single-write) and the upgrade sweep DELETES the
 * records that are already published (ticket 20). "No doc record" became the
 * ordinary steady state, and the renderer's record layer became a shrinking set
 * of pre-upgrade frozen entries converging on empty - so a migrated chat lost
 * its tree row, its rename/archive affordances, and (through a record-gated
 * subscribe) its live open, on its own owning host.
 *
 * This read is the missing half: the host serves the store-backed rows, and the
 * client folds them into the same record table the doc projection feeds. The
 * document keeps whatever frozen entries it still has - the client's union is
 * what makes the two populations one list.
 *
 * ## What a row is, and what it deliberately is not
 *
 * One row per LIVE chat, field-for-field what the registry row carries and
 * nothing derived. Deleted chats are absent (the registry holds a tombstone;
 * nothing outside the store wants one). `runSettingsSummary` is the registry's
 * own settings summary - the harness id and only the harness id, because that
 * is all the row holds; the full run-settings tuple lives in the chat's own
 * stream, not in a list read.
 *
 * ## Scope: everything this host may show the viewer, own AND foreign
 *
 * Originally the viewer's OWN rows only, because the host's registry held
 * nothing else. With the record layer's two-way SQLite <-> cloud sync it also
 * holds FOREIGN rows - replicas of chats owned by other hosts (or other
 * identities) that the server delivered into this host's per-viewer inbox. So
 * the response is the complete, ALREADY-AUTHORIZATION-FILTERED list, and
 * `origin` is what tells the two populations apart.
 *
 * The authorization decision is not made here and never was. Own rows are the
 * caller's by construction; foreign rows are in the local store only because
 * the server put them in this viewer's change feed, and a revocation removes
 * them through the same feed. The enumeration-oracle property therefore holds
 * unchanged: an epic the caller cannot see and an epic in which nothing is
 * visible to them answer identically.
 *
 * ## Optional, with a degrade story
 *
 * Registered `degrade: { kind: "unsupported" }` and not on the released floor.
 * A host predating this method answers `E_HOST_UNSUPPORTED`, and the client's
 * contract is DOC-ONLY MODE: the record table is exactly the doc projection,
 * which is precisely how that host's own records behave. There is no failure to
 * render, because there is nothing the user could do about it except upgrade the
 * host they are already talking to.
 */
export const listChatRecordsRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ListChatRecordsRequest = z.infer<
  typeof listChatRecordsRequestSchema
>;

/**
 * Row origin, from the SERVING host's point of view.
 *
 * - `own`     - this host is the row's authoritative writer. It minted the
 *   chat, its registry row is the source of truth for every host-authoritative
 *   field, and its outbox is what replicates them outward.
 * - `foreign` - a READ-ONLY REPLICA this host pulled from its per-viewer
 *   change feed. Every host-authoritative field on it is a copy of another
 *   host's state, and a mutation aimed at it has to go to the owning host.
 *
 * Host-stated rather than client-derived. It is not
 * `ownerUserId === signedInUserId`: a user's chat living on ANOTHER of their
 * own hosts is FOREIGN here, because authority follows the chat-host binding,
 * not the identity. Nor is it a comparison the client should make against
 * `originHostId`, which names the MINTING host and answers a different
 * question than "may this host write the row". The host knows which of its
 * rows its outbox owns; that fact is what ships.
 */
export const chatRecordOriginSchema = z.enum(["own", "foreign"]);
export type ChatRecordOrigin = z.infer<typeof chatRecordOriginSchema>;

/**
 * One chat, as the serving host's registry knows it.
 *
 * Archive state ships as BOTH `archived` (the boolean every row can answer,
 * because it is what the cloud row stores) and `archivedAt` (the timestamp only
 * an own row has, because it is what the host registry stores). Neither field
 * subsumes the other: dropping the boolean would misread every foreign archived
 * chat as active, and dropping the timestamp would force the renderer - whose
 * projection has always carried one - to invent one on the way back.
 *
 * ONE row shape, shared by the list read below and by the delta stream's
 * `upsert` frame, deliberately: the host applies its inbox to SQLite and then
 * pushes the same rows to its clients, so a poll and a push that disagreed
 * about the shape would be a bug with two places to fix. Both surfaces are
 * unreleased today, so sharing costs nothing. Once EITHER ships, this const is
 * frozen for that surface and the next field forks a versioned copy
 * (`chatRecordSummarySchemaV11`, the `hostNotificationEntrySchemaV21` pattern)
 * rather than being edited in place - a shared builder must never silently
 * rewrite a released shape.
 */
export const chatRecordSummarySchema = z.object({
  chatId: z.string().min(1),
  /**
   * IDENTITY-BEARING, not informational. `chatId` is host-minted and therefore
   * NOT globally unique: server-side a chat is identified by the triple
   * `(taskId, ownerUserId, chatId)`, and two users can legitimately hold the
   * same `chatId` within one task. Anything that keys, caches, dedupes or
   * unions these rows must key on the owner too - dropping it collapses two
   * different people's chats into one entry, which is a privacy bug wearing a
   * UI costume. Non-empty for the same reason `chatId` is: an empty owner
   * would give every owner-less row one shared record key, so the wire
   * boundary rejects it rather than letting a consumer discover the collision.
   */
  ownerUserId: z.string().min(1),
  /** The host that MINTED the chat - the registry's `originHostId`. Identity
   * for host-scoped keying (a chat is bound to its minting host for life), so
   * non-empty like the other two identity components. */
  originHostId: z.string().min(1),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  parentChatId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /**
   * Whether the chat is archived. THE RENDERING-AUTHORITATIVE FIELD, and the
   * only one of this pair that every row can answer.
   *
   * It exists because the two planes disagree about the TYPE of this fact: the
   * host registry stores an archive TIMESTAMP, the cloud row stores a BOOLEAN,
   * and a foreign row is a replica of the cloud row. So a client that derived
   * archived-ness from `archivedAt` would read every foreign archived chat as
   * active. For an own row this is exactly `archivedAt !== null`; for a foreign
   * row it is the only truth there is.
   */
  archived: z.boolean(),
  /**
   * WHEN the chat was archived, or `null`.
   *
   * `null` means one of two different things and cannot distinguish them:
   * an active chat, or a FOREIGN archived chat whose timestamp never crossed
   * the cloud row (which carries only the boolean). Read `archived` for the
   * state; read this only to DISPLAY a time, and only when `archived` is true.
   */
  archivedAt: z.number().int().nonnegative().nullable(),
  /**
   * The registry's run-settings SUMMARY: the harness id, or `null` when the
   * chat has no settings (or was written before the field existed). Not the
   * settings tuple - the registry does not hold one.
   */
  runSettingsSummary: z.string().nullable(),
  /**
   * Per-chat MONOTONIC revision of this row's state.
   *
   * The record layer's staleness test, and the only ordering fact on the row.
   * The owning host bumps it on every host-authoritative write and the server
   * bumps it on every server-authoritative one; a consumer - the inbox
   * applying a feed op, or a client applying a stream `upsert` - accepts a row
   * only when its revision strictly exceeds the one already held, and drops it
   * otherwise. That is what makes replayed, reordered and duplicated deltas
   * harmless without any merge logic.
   *
   * Per CHAT, so revisions from two different chats are incomparable, and it
   * is NOT a timestamp: host clocks skew, and `updatedAt` is display metadata
   * that no ordering decision may read.
   */
  revision: z.number().int().nonnegative(),
  /**
   * Who may read the chat - SERVER-AUTHORITATIVE, replicated in.
   *
   * The same vocabulary the cloud row defines, reused rather than restated:
   * this field IS that row's value, carried into the host's SQLite by the
   * inbox, so a second enum here would be a seam where two spellings of one
   * fact could drift apart. `private` is the owner alone; `task` is every
   * collaborator holding a task permission.
   *
   * A host may never write it. A row that has not yet been published, or whose
   * host has never heard from the server about it, reads `private` - the
   * closed default, so an unsynced row is never rendered as shared.
   */
  visibility: cloudChatVisibilitySchema,
  /** Whether the serving host owns this row or holds a read-only replica. */
  origin: chatRecordOriginSchema,
});
export type ChatRecordSummary = z.infer<typeof chatRecordSummarySchema>;

export const listChatRecordsResponseSchema = z.object({
  chats: z.array(chatRecordSummarySchema),
});
export type ListChatRecordsResponse = z.infer<
  typeof listChatRecordsResponseSchema
>;

/**
 * `epic.getChatRunSettings@1.0` - ONE chat's full run-settings tuple.
 *
 * ## Why a second read exists next to the row above
 *
 * The row carries `runSettingsSummary` - the harness id and nothing else -
 * because the registry index it is served from must hold every chat in an epic
 * at once, and a growing chat-shaped settings object has no place in it (see
 * `chat-registry-row.ts`). That was the whole tuple's only client-side source
 * once the single-write pivot stopped writing doc chat entries, so every
 * surface that renders resolved settings for a chat it has not opened - the
 * sidebar's agent hover card is the one that exists - lost model, reasoning
 * effort, service tier, profile and permission mode at the same moment.
 *
 * This is the narrow read that gives them back WITHOUT widening the list: it is
 * keyed on one chat, it is issued only when such a surface actually asks (the
 * hover card fetches on open, beside `worktree.getBinding`), and it answers
 * from the same store the row does - one keyed `json_extract`, no transcript
 * materialized. A list read would pay that cost for every chat in the epic to
 * serve the one the pointer is resting on.
 *
 * ## `settings` is nullable, and the two nulls mean different things
 *
 * `null` covers both "this host holds no projection for that chat" and "the
 * chat has no persisted settings" (a legacy record written before the field, or
 * one that has never run a turn). Deliberately NOT distinguished and
 * deliberately NOT an error: every caller renders the same nothing for both,
 * and a chat id this host does not know is a routing answer the CLIENT already
 * has - it addresses the read to the chat's owning host, so a miss here means
 * the row moved, not that the caller asked wrongly.
 *
 * ## Owner-scoped, like every other chat read
 *
 * Rows owned by the calling identity only. A chat living on ANOTHER of the
 * viewer's hosts is served by THAT host - the client resolves a requester for
 * the chat's `originHostId` rather than asking whichever host its tab happens
 * to be bound to - so this method never needs a foreign arm. A foreign replica
 * carries only the summary anyway (the cloud metadata row does not replicate
 * the tuple), so serving one here would be inventing detail this host was never
 * told.
 *
 * ## Optional, with a degrade story
 *
 * Registered `degrade: { kind: "unsupported" }` and not on the released floor.
 * A host predating it answers `E_HOST_UNSUPPORTED` and the caller renders what
 * the row already gave it - the harness mark - which is strictly what that
 * host's own client showed before this method existed.
 */
export const getChatRunSettingsRequestSchema = z.object({
  epicId: z.string().min(1),
  chatId: z.string().min(1),
});
export type GetChatRunSettingsRequest = z.infer<
  typeof getChatRunSettingsRequestSchema
>;

export const getChatRunSettingsResponseSchema = z.object({
  settings: chatRunSettingsSchema.nullable(),
});
export type GetChatRunSettingsResponse = z.infer<
  typeof getChatRunSettingsResponseSchema
>;

/**
 * Frozen harness id set for `epic.getChatRunSettings@1.0`, as the v1.2.0 tags
 * (2026-08-24) shipped it.
 *
 * This method is the reason the freeze audit cannot stop at the three canonical
 * id-carrying methods: its response embeds the PERSISTED `guiHarnessIdSchema`
 * (`persistence/epic/foundation.ts`), a second, deliberately-independent copy of
 * the harness enum, and nothing about the method's name suggests a catalog. It
 * is also `degrade: unsupported` and outside `RELEASED_FLOOR`, so a plain
 * `bun run test` stays green - only the tag-based `protocol-compat` gate saw it,
 * which is exactly the shape of the Hermes A2A-profiles trap recorded in
 * `adding-a-harness.md`.
 *
 * `.extract()` off the live persisted enum rather than a hand-written list, the
 * same idiom `guiHarnessIdSchemaV70` uses in `agent/shared.ts`: removing an id
 * from the live enum then fails to compile here instead of silently narrowing a
 * released line. Do NOT add ids here - extend the persisted enum and let the
 * v2.0 line carry them.
 */
export const chatRunSettingsHarnessIdSchemaV10 = guiHarnessIdSchema.extract([
  "claude",
  "codex",
  "opencode",
  "traycer",
  "cursor",
  "grok",
  "qwen",
  "kiro",
  "droid",
  "kimi",
  "copilot",
  "kilocode",
  "openrouter",
  "amp",
  "devin",
  "pi",
  "hermes",
  "omp",
  "huggingface",
]);

/**
 * Frozen `epic.getChatRunSettings@1.0` settings tuple. Hand-copied off
 * `chatRunSettingsSchema` rather than `.extend()`ed from it, so a field added to
 * the persisted tuple cannot leak onto this released line - the same discipline
 * `providerLoginCapabilitySchemaV10` and `guiHarnessOptionBaseShapeV70` follow,
 * and for the same reason: pinning only the id over a LIVE body is a half
 * freeze.
 *
 * Keeps the persisted variant's `.default(...)` backstops verbatim (see the
 * import comment at the top of this file): this is a READ of a record that may
 * predate `serviceTier` / `profileId`, and the strict schema would fail it.
 */
export const chatRunSettingsSchemaV10 = z.object({
  harnessId: chatRunSettingsHarnessIdSchemaV10,
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  profileId: z.string().nullable().default(null),
});
export type ChatRunSettingsV10 = z.infer<typeof chatRunSettingsSchemaV10>;

export const getChatRunSettingsResponseSchemaV10 = z.object({
  settings: chatRunSettingsSchemaV10.nullable(),
});
export type GetChatRunSettingsResponseV10 = z.infer<
  typeof getChatRunSettingsResponseSchemaV10
>;

/**
 * `host.chatRecords.subscribe@1.0` - the record-change PUSH stream, the
 * freshness half of the read above.
 *
 * ## Why host-scoped and not per-epic
 *
 * One subscription per client, for every epic that host has open, plus its own
 * rows regardless of which epic they belong to. A per-epic stream would need a
 * socket per open epic to say the same things, and it could not carry own-row
 * changes at all: the outbox drains whether or not the epic it belongs to is
 * open, so those deltas exist outside any epic subscription's lifetime. Frames
 * therefore NAME their epic and per-epic filtering is the client's, exactly as
 * `host.notifications.feed.subscribe` and `agent.activity.subscribe` are
 * host-scoped for the same reason.
 *
 * ## Two ops, and they are the same two the cloud feed speaks
 *
 * `upsert` and `remove`, end to end: the host pulls its per-viewer change feed
 * from the cloud in this grammar, applies it to SQLite, and re-emits in this
 * grammar to its clients. A thin client is a host client, never a feed client -
 * it holds no cursor, contacts no cloud, and learns one delta language.
 *
 * `remove` exists because the transitions it carries are INEXPRESSIBLE as
 * state for the affected viewer: unshare, shared -> private, epic-membership
 * loss, deletion. A row that left the viewer's entitlement cannot announce its
 * own departure through an updated copy of itself, which is precisely why the
 * plane below this one is a change feed and not a filtered snapshot.
 *
 * ## No snapshot frame, no resume cursor - deliberately, at 1.0
 *
 * `epic.listChatRecords` IS the snapshot, and the client already polls it. So
 * the stream carries deltas only, and (re)connect means: re-read the list,
 * then apply what arrives. Deltas are self-describing and revision-guarded, so
 * a client that missed some while disconnected converges on its next poll
 * rather than on a replay this host would have to retain a log to serve.
 *
 * A cursor is exactly the kind of thing a later ADDITIVE MINOR can add to the
 * open request once a delta log exists to resume from; shipping the field now,
 * against a host with nothing to seek in, would be a promise the wire made and
 * the implementation could not keep.
 *
 * ## Ordering and staleness
 *
 * `revision` is per-chat monotonic and the only ordering fact: apply an
 * `upsert` when its revision strictly exceeds the one held for that chat, drop
 * it otherwise. `remove` carries no revision because it needs none - removal is
 * TERMINAL AND ABSORBING, the one lifecycle rule in this design, so it applies
 * unconditionally and idempotently and no later `upsert` resurrects the row on
 * this client.
 *
 * ## Optional, with a degrade story
 *
 * Post-v1.0.0 stream method, so it is implicitly optional: the `/stream`
 * handshake checks compatibility per method at subscribe time, a host that
 * predates it never advertises it, and the client's subscription resolves to
 * `onMethodSupport(method, "unsupported")`. The contract for that arm is that
 * the client KEEPS THE POLL and loses nothing but latency - `epic.listChatRecords`
 * (and, on a host older still, its own doc-only degrade) already produces the
 * whole record table. Never add this name to the unary released floor
 * (`released-floor.ts`), which is fail-closed on the name set.
 */
export const hostChatRecordsSubscribeOpenRequestSchemaV10 = z.object({});
export type HostChatRecordsSubscribeOpenRequestV10 = z.infer<
  typeof hostChatRecordsSubscribeOpenRequestSchemaV10
>;

/**
 * WHY a row stopped being visible to this viewer.
 *
 * - `deleted` - the chat is gone for everyone. Terminal everywhere.
 * - `revoked` - the chat still exists; this viewer may no longer see it
 *   (unshared, flipped back to private, or removed from the epic).
 *
 * The distinction is not bookkeeping: it is the difference between the two
 * honest things an OPEN tab can say when its record disappears underneath it -
 * "this chat was deleted" versus "this chat is no longer shared with you" -
 * and a client handed only "gone" would have to guess which.
 *
 * CLOSED enum. A reason this contract version cannot represent would leave a
 * client unable to render the end state at all, so widening it is a NEW MINOR,
 * never a silent addition.
 */
export const chatRecordRemovalReasonSchema = z.enum(["deleted", "revoked"]);
export type ChatRecordRemovalReason = z.infer<
  typeof chatRecordRemovalReasonSchema
>;

/**
 * `epicId` / `chatId` / `revision` are the ENVELOPE - what the delta addresses
 * and where it sits in that chat's order - and every frame carries the parts it
 * can. `remove` has no row to put them in; `upsert` repeats its row's own
 * `chatId` and `revision` at the envelope so both frame kinds are addressed and
 * ordered the same way. INVARIANT, validated below rather than left as prose:
 * on an `upsert`, `chatId` equals `record.chatId` and `revision` equals
 * `record.revision`. A frame where they disagree is addressing one chat while
 * carrying another's row (or ordering a row by a revision it does not hold),
 * and whichever field a consumer happened to read would decide which chat it
 * corrupts - so the contract refuses the combination outright (the
 * `resolveCloudChatHeadResponseSchema` pattern).
 */
// ─── Frozen `host.chatRecords.subscribe@1.0` server-frame set (as shipped) ──
//
// IMMUTABLE, on the `epic.subscribe` precedent: a client that negotiated @1.0
// agreed to exactly these frame kinds. New frames go on a new minor's union
// below, and the host gates their emission on the NEGOTIATED version.
const hostChatRecordsSubscribeSharedServerFrameSchemasV10 = [
  z.object({
    kind: z.literal("upsert"),
    ...textFrameFields,
    epicId: z.string().min(1),
    chatId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    record: chatRecordSummarySchema,
  }),
  z.object({
    kind: z.literal("remove"),
    ...textFrameFields,
    epicId: z.string().min(1),
    chatId: z.string().min(1),
    reason: chatRecordRemovalReasonSchema,
  }),
  z.object({
    kind: z.literal("pong"),
    ...textFrameFields,
  }),
] as const;

/**
 * The minimal SUPERTYPE of both minors' frame unions that the envelope
 * invariants read - declared by hand rather than inferred so the refine
 * functions can be shared between the schemas without a circular
 * const/type reference (each schema's inferred type would name the refine
 * that builds it).
 */
type EnvelopeCheckedFrame =
  | {
      readonly kind: "upsert";
      readonly chatId: string;
      readonly revision: number;
      readonly record: { readonly chatId: string; readonly revision: number };
    }
  | {
      readonly kind: "tuiUpsert";
      readonly tuiAgentId: string;
      readonly revision: number;
      readonly record: {
        readonly tuiAgentId: string;
        readonly revision: number;
      };
    }
  | { readonly kind: "remove" }
  | { readonly kind: "tuiRemove" }
  | { readonly kind: "pong" };

/** The @1.0 envelope invariant, verbatim from the original inline refine. */
function refineChatUpsertEnvelope(
  frame: EnvelopeCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "upsert") return;
  const upsert = frame;
  if (upsert.chatId !== upsert.record.chatId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chatId"],
      message:
        "An upsert's envelope must address the row it carries - `chatId` must equal `record.chatId`.",
    });
  }
  if (upsert.revision !== upsert.record.revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revision"],
      message:
        "An upsert's envelope must order by the row it carries - `revision` must equal `record.revision`.",
    });
  }
}

/** The @1.1 addition: the same invariant for the terminal-agent upsert. */
function refineTuiUpsertEnvelope(
  frame: EnvelopeCheckedFrame,
  ctx: z.RefinementCtx,
): void {
  if (frame.kind !== "tuiUpsert") return;
  const upsert = frame;
  if (upsert.tuiAgentId !== upsert.record.tuiAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tuiAgentId"],
      message:
        "A tuiUpsert's envelope must address the row it carries - `tuiAgentId` must equal `record.tuiAgentId`.",
    });
  }
  if (upsert.revision !== upsert.record.revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revision"],
      message:
        "A tuiUpsert's envelope must order by the row it carries - `revision` must equal `record.revision`.",
    });
  }
}

export const hostChatRecordsSubscribeServerFrameSchemaV10 = z
  .discriminatedUnion(
    "kind",
    hostChatRecordsSubscribeSharedServerFrameSchemasV10,
  )
  .superRefine(refineChatUpsertEnvelope);
export type HostChatRecordsSubscribeServerFrameV10 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV10
>;

// ─── `host.chatRecords.subscribe@1.1` - additive: terminal-agent deltas ─────
//
// The TUI eviction's freshness half: terminal-agent records live in the same
// registry the chat rows do, and their deltas ride the SAME host-scoped
// stream rather than a socket of their own. Additive minor on the
// `epic.subscribe@1.1` precedent - a client that negotiated @1.0 never
// receives the new kinds; the host gates emission on the negotiated version.
//
// `tuiRemove` reuses the chat removal-reason vocabulary. Today a TUI row can
// only ever say `deleted` (the rows are structurally owner-only, so there is
// no entitlement to revoke), but the enum is shared rather than narrowed so
// a future sharing surface cannot fork the vocabulary.
export const hostChatRecordsSubscribeServerFrameSchemaV11 = z
  .discriminatedUnion("kind", [
    ...hostChatRecordsSubscribeSharedServerFrameSchemasV10,
    z.object({
      kind: z.literal("tuiUpsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      record: tuiAgentRecordSummarySchema,
    }),
    z.object({
      kind: z.literal("tuiRemove"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      reason: chatRecordRemovalReasonSchema,
    }),
  ])
  .superRefine(refineChatUpsertEnvelope)
  .superRefine(refineTuiUpsertEnvelope);
export type HostChatRecordsSubscribeServerFrameV11 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV11
>;

export const hostChatRecordsSubscribeClientFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type HostChatRecordsSubscribeClientFrameV10 = z.infer<
  typeof hostChatRecordsSubscribeClientFrameSchemaV10
>;

export const hostChatRecordsSubscribeV10 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV10,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});

export const hostChatRecordsSubscribeV11 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV11,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});
