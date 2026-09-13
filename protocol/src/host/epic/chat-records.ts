import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { cloudChatVisibilitySchema } from "@traycer/protocol/host/epic/cloud-chat";
import {
  recordListRecencyPatchSchema,
  recordListRevisionSchema,
  recordListStampSchema,
} from "@traycer/protocol/host/epic/record-list-revision";
import {
  tuiAgentRecordSummarySchema,
  tuiAgentRecordSummaryV12Schema,
  tuiAgentRecordSummaryV13Schema,
} from "@traycer/protocol/host/epic/tui-agent-records";
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

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

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
 * about the shape would be a bug with two places to fix.
 *
 * BOTH surfaces have now shipped (`epic.listChatRecords@1.0`,
 * `host.chatRecords.subscribe@1.0`-`@1.2`), so this const is FROZEN: it is the
 * row those released minors promised, and editing it in place would silently
 * rewrite four released shapes at once. Every further field goes onto a fork,
 * never here.
 *
 * The two surfaces' live rows have since DIVERGED, and the fork is per
 * surface rather than shared: the list serves
 * {@link chatRecordSummaryV12Schema} (this row plus `docResident` plus `head`)
 * and the stream carries {@link chatRecordSummaryStreamV13Schema} (this row
 * plus `head` alone). `docResident` is the field that cannot be shared - see
 * the stream row's note for why a delta may not state it.
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

/** FROZEN. `epic.listChatRecords@1.0` serves exactly this response. */
export const listChatRecordsResponseSchema = z.object({
  chats: z.array(chatRecordSummarySchema),
});
export type ListChatRecordsResponse = z.infer<
  typeof listChatRecordsResponseSchema
>;

// ─── `epic.listChatRecords@1.1` - the doc-remainder union ──────────────────
//
// The chat half of the eviction `epic.listTuiAgents@1.1` already made for
// terminal agents, and it is that minor's shape field-for-field, deliberately:
// the two methods answer the same question about two record populations, and
// two different answers to "where did this row come from" would be a seam
// nobody could keep straight.
//
// ## The failure it prevents
//
// `epic.listChatRecords@1.0` answers out of this host's chat registry. That was
// the whole population while every client also held an epic-doc replica and
// unioned the doc's `chats` subtree in itself. The lanes DELETE that replica -
// `epic.state.subscribe` carries typed rows, not a document - so any chat that
// lives only in the doc reaches a lane client here or nowhere.
//
// Two populations are still doc-resident and neither is hypothetical:
//
//   1. NOT-YET-SWEPT rows. The chat-sync-v2 upgrade sweep deletes doc records
//      once they are published; until an epic has been opened by an upgraded
//      host, its pre-upgrade entries are still only in the document.
//   2. FOREIGN-HOST rows. The sweep is gated on the BINDING host - it refuses
//      to touch an entry another host owns, because that host may still be
//      writing it. So a serving host's doc map legitimately holds entries bound
//      to un-upgraded PEER hosts, and no registry read can produce them.
//
// The TUI resolver's own comment names the symptom exactly: they do not error,
// they are simply absent.
//
// ## The gate is the CALLER'S DECLARATION, not its version
//
// Serving the remainder is correct for a caller with no doc replica and WRONG
// for one that has it - duplicate rows, and a union that must then choose
// between its live doc entry and this host's poll-time copy of the same entry.
// That choice has no good answer.
//
// Gating on this method's own negotiated minor CANNOT answer the question:
// whether a caller holds a replica is decided by which epic READ LANE it
// subscribed to, negotiated independently on the same connection. A renderer
// speaking `listChatRecords@1.1` while still on the monolith is not
// hypothetical - it is every build between this change and the lane cutover.
//
// So `@1.1` grows its REQUEST. The client is the only party that knows, and a
// fact it declares cannot drift out of step with a version it negotiated
// elsewhere. Both `hasDocReplica` declarations - this one and
// `epic.listTuiAgents`' - flip at the same cutover, for the same reason.

/**
 * The `@1.1` row: the `@1.0` summary plus its ORIGIN PLANE.
 *
 * Not to be confused with `origin`, which is already on the row and answers a
 * different question - `own` / `foreign` is about WRITE AUTHORITY (does this
 * host's outbox own the row), while `docResident` is about WHICH STORE the row
 * was read out of. A foreign registry replica and a doc-resident entry are both
 * un-writable here and are not the same thing: the first is addressable through
 * the record-backed affordances by routing to its owning host, the second is
 * not addressable through them at all.
 *
 * ## Why the client is told, rather than handed a seamless union
 *
 * A `@1.0` client derived exactly this bit from its own doc replica, and the
 * GUI still routes on it: a doc-resident chat is NOT addressable through the
 * registry-backed mutations, so a client that could not tell the two apart
 * would send `epic.renameChat` / `epic.reparentChat` an id naming no registry
 * row. Serving the union without the marker would fix the disappearance and
 * silently introduce that mis-route - the worse bug of the two, because it
 * fails on WRITE instead of on render.
 *
 * So the marker is not metadata. It is the doc-replica-derived distinction,
 * preserved for a client that no longer has a doc replica to derive it from.
 */
export const chatRecordSummaryV11Schema = chatRecordSummarySchema.extend({
  docResident: z.boolean(),
});
export type ChatRecordSummaryV11 = z.infer<typeof chatRecordSummaryV11Schema>;

export const listChatRecordsResponseV11Schema = z.object({
  chats: z.array(chatRecordSummaryV11Schema),
});
export type ListChatRecordsResponseV11 = z.infer<
  typeof listChatRecordsResponseV11Schema
>;

/**
 * The `@1.1` request: the `@1.0` request plus the caller's own answer to the
 * only question that decides what this method should serve.
 *
 * `hasDocReplica: true` means the caller still holds a live epic-doc replica
 * (it subscribed on `epic.subscribe@1`) and therefore already sees every
 * doc-resident entry continuously, without this method's help. It gets registry
 * rows only - exactly `@1.0` content.
 *
 * `false` means it has no replica (it reads the epic through
 * `epic.state.subscribe`), so the doc-resident remainder reaches it here or
 * nowhere.
 *
 * REQUIRED, not optional: a `@1.1` caller always knows this about itself, and
 * an absent field would have to be given a default - which is precisely the
 * host-side guess this field exists to remove.
 */
export const listChatRecordsRequestV11Schema =
  listChatRecordsRequestSchema.extend({
    hasDocReplica: z.boolean(),
  });
export type ListChatRecordsRequestV11 = z.infer<
  typeof listChatRecordsRequestV11Schema
>;

/**
 * The chat's CLOUD PUBLICATION stamp, as the record row carries it.
 *
 * Restated here rather than imported from the internal `@traycerai/common`
 * chat schemas: this package is the OSS client<->host contract and may not
 * depend on an internal one. The same three fields the cloud row holds, and
 * the same meanings - it IS that stamp, replicated into the host's record
 * table by the inbox and pushed on to clients.
 *
 * ## Why all three fields, when only one is read for freshness
 *
 * `headSha256` is the digest of the head document's exact bytes, and it is the
 * only field a consumer keys a re-read on: it changes exactly when the
 * published transcript changes, so it is a cache key that cannot produce a
 * false hit. `publishedAt` is the ORDERING fact - server-monotonic, clamped
 * inside the CAS so it strictly rises under the row lock - and it is what lets
 * a consumer merge a head independently of `revision`, which orders METADATA
 * and nothing else. `throughRecordSeq` is display/diagnostic only: two forked
 * histories both number their turns, so ordering by it would permit exactly the
 * overwrite the digest exists to refuse (the same warning
 * `cloudChatSummarySchema` carries).
 */
export const chatRecordHeadStampSchema = z.object({
  /** Digest of the head document's exact bytes. The freshness key. */
  headSha256: sha256HexSchema,
  /** Sequence the head was pinned at. A projection - never an ordering fact. */
  throughRecordSeq: z.number().int().nonnegative(),
  /**
   * Server-monotonic publication time. The head's ONLY ordering fact. Bounded
   * like the row's other timestamps: the server stamps and clamps it as an
   * integer millisecond count, so a negative or fractional value cannot be a
   * publication time and is refused at the wire.
   */
  publishedAt: z.number().int().nonnegative(),
});
export type ChatRecordHeadStamp = z.infer<typeof chatRecordHeadStampSchema>;

// ─── `epic.listChatRecords@1.2` - the publication head on the row ───────────
//
// The live-sync half of the published-copy tile. A viewer holding a published
// COPY of a chat - a collaborator's, or an owner's whose host is unreachable -
// read the cloud once per tile mount and never again, because nothing in the
// record row told it a new turn had been published. This carries the cloud
// head stamp, so the copy can follow completed turns off a plane that already
// exists.
//
// Additive minor on `@1.1`, whose REQUEST it takes unchanged: `hasDocReplica`
// answers a question this change does not touch, and re-asking it would be a
// second spelling of one fact. The `@1.1 -> @1.2` upgrade is therefore the
// IDENTITY, leaving `head` absent rather than writing `null` - see the row's
// own note on why those two are not the same statement.

/**
 * The `@1.2` row: the `@1.1` row plus the chat's cloud publication head.
 *
 * `.extend()`ed off {@link chatRecordSummaryV11Schema} rather than hand-copied
 * BECAUSE that const is the released `@1.1` shape (the
 * `tuiAgentRecordSummaryV11Schema` idiom, one file over): the derivation runs
 * from the released shape into the new one, so nothing can flow the other way
 * and rewrite a shipped line. The hand-copy discipline
 * `chatRunSettingsSchemaV10` follows is the opposite direction - pinning a
 * frozen copy of a schema that is still LIVE - and does not apply.
 *
 * ## `head` is optional AND nullable, and the two absences are not the same
 *
 * `null` is the host's positive statement that the row has no publication to
 * point at: an own row (this host's live chat - the tile never reads a copy of
 * something it is already serving), or a foreign row whose owner has never
 * published. ABSENT is the wire's older story - a `@1.0`/`@1.1` peer's row
 * upgraded onto this shape, which never carried the field at all. Consumers
 * collapse the two (`record.head ?? null`); the schema keeps them apart so an
 * upgrade path is never forced to put an affirmative "no head" claim in an
 * older peer's mouth.
 *
 * The optionality is also what makes this a MINOR: an added key on a
 * non-strict object is stripped by an older peer's schema, so the row still
 * projects onto every released minor.
 */
export const chatRecordSummaryV12Schema = chatRecordSummaryV11Schema.extend({
  head: chatRecordHeadStampSchema.nullable().optional(),
});
export type ChatRecordSummaryV12 = z.infer<typeof chatRecordSummaryV12Schema>;

export const listChatRecordsResponseV12Schema = z.object({
  chats: z.array(chatRecordSummaryV12Schema),
});
export type ListChatRecordsResponseV12 = z.infer<
  typeof listChatRecordsResponseV12Schema
>;

// ─── `epic.listChatRecords@1.3` - revision gating ───────────────────────────
//
// The chat half of the record-list revision gating, and it is
// `epic.listTuiAgents@1.3`'s shape field for field - the two methods answer
// the same question about two record populations, and two different gating
// grammars would be a seam nobody could keep straight.
//
// ## What it costs today
//
// Both lists are polled on a fixed 20s cadence per open epic tab, and neither
// request carries anything but `{ epicId, hasDocReplica }`. The host
// re-assembles every row, re-parses it, JSON-encodes the body and ships it -
// on a large epic a multi-MB answer that is almost always identical to the
// previous one. Over a megabyte the transport classifies the body BULK, so
// each answer also occupies the relay uplink for seconds and can mute other
// subscribers behind it.
//
// ## The shape, and where the reasoning lives
//
// The client sends the stamp it holds; the host answers `snapshot` (the `@1.2`
// body plus the new keys) or `unchanged` (the stamp plus recency patches).
// `record-list-revision.ts` carries the vocabulary - why the epoch is
// load-bearing, why quiet writes get a second counter - and
// `listTuiAgentsResponseV13Schema` carries the argument for the arm shapes,
// the nullable snapshot stamp and the emission gate. Restating either here
// would be two copies of one rule.
//
// The row is UNCHANGED from `@1.2`. The session facet this minor adds to the
// terminal-agent list has no chat counterpart: a chat has no PTY session to
// be asleep.

/**
 * The `@1.3` response: a snapshot, or the statement that the client's rows are
 * still current.
 *
 * The `snapshot` arm's `chats` is the `@1.2` row - `head` included - so a
 * `@1.2` payload projects onto this arm with the two new keys stripped, which
 * is what admits the widening as a minor. The `unchanged` arm is a new ROOT
 * arm an older peer cannot parse, emitted only when the negotiated version is
 * at this minor and the client's `knownRevision` matched; the registry entry's
 * `responseGrowthProjectionGated: true` is the reviewed claim that it is.
 *
 * `listStamp` is nullable on the `snapshot` arm alone, so the `@1.2 -> @1.3`
 * upgrade path can say "that host issued no stamp" instead of inventing an
 * epoch a client would send back. See {@link listTuiAgentsResponseV13Schema}.
 */
export const listChatRecordsResponseV13Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    listStamp: recordListStampSchema.nullable(),
    chats: z.array(chatRecordSummaryV12Schema),
  }),
  z.object({
    kind: z.literal("unchanged"),
    listStamp: recordListStampSchema,
    touched: z.array(recordListRecencyPatchSchema),
  }),
]);
export type ListChatRecordsResponseV13 = z.infer<
  typeof listChatRecordsResponseV13Schema
>;

/**
 * The `@1.2` request plus the stamp the caller holds.
 *
 * REQUIRED and nullable on the `hasDocReplica` precedent: a `@1.3` caller
 * always knows whether it holds one, and an absent field would have to be
 * given a host-side default - the guess the field exists to remove. The value
 * is whatever the last answer's `listStamp` carried, sent back verbatim; a
 * client must never synthesize one, and must drop the one it holds when the
 * store it was read into is replaced.
 */
export const listChatRecordsRequestV13Schema =
  listChatRecordsRequestV11Schema.extend({
    knownRevision: recordListStampSchema.nullable(),
  });
export type ListChatRecordsRequestV13 = z.infer<
  typeof listChatRecordsRequestV13Schema
>;

/**
 * The `host.chatRecords.subscribe@1.3` chat row: the FROZEN base row plus the
 * publication head - and deliberately NOT {@link chatRecordSummaryV12Schema}.
 *
 * ## Why the stream row does not carry `docResident`
 *
 * `docResident` is a LIST-only field, and adding it here would make the host
 * assert something it cannot know. The delta plane's own reasoning, in
 * `chat-record-table.ts`'s `applyDelta`: this stream carries the base row,
 * which says nothing about the home, and - unlike the terminal-agent twin -
 * "a doc-homed row cannot produce a delta" is FALSE for chats, because
 * `ChatRegistryService.acquire` deliberately announces doc-homed chats through
 * `hydrateLegacyDocSecondary`. Stamping `docResident: false` on those rows
 * would route their renames to a writer that cannot address them. So the
 * consumer seeds `docResident: null` from a delta and lets the next `@1.1`+
 * list answer state the home; `HeldChatRecordRow.docResident` is nullable for
 * exactly that reason, and `chatRowSupersedesOnSnapshot` carries the waiver
 * that lets the answer fill it.
 *
 * Do not "unify" this with the list row. The two surfaces answer different
 * questions about provenance, and collapsing them re-introduces the routing
 * bug above.
 *
 * `head` has the same optional-and-nullable meaning it has on the list row.
 */
export const chatRecordSummaryStreamV13Schema = chatRecordSummarySchema.extend({
  head: chatRecordHeadStampSchema.nullable().optional(),
});
export type ChatRecordSummaryStreamV13 = z.infer<
  typeof chatRecordSummaryStreamV13Schema
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
 * Frozen harness id set for `epic.getChatRunSettings@2.0`, as the `1.3.0` tags
 * shipped it - everything through Reasonix, before Antigravity.
 *
 * v2.0 was opened to carry the ids v1.0 froze off, and bound the live
 * persisted enum on the reading that it was the unreleased head. 1.3.0 was cut
 * from a branch that predates Antigravity, so the tag froze v2.0 here while
 * `main` widened the enum underneath it - the same trap one line down, which
 * is the argument for pinning a released line the moment it ships rather than
 * when the next id arrives.
 *
 * `.extract()` off the live persisted enum for the reason the V10 note gives:
 * removing an id upstream then fails to compile here instead of silently
 * narrowing a released line.
 */
const chatRunSettingsHarnessIdSchemaV20 = guiHarnessIdSchema.extract([
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
  "reasonix",
]);

/**
 * Frozen `epic.getChatRunSettings@2.0` settings tuple. Hand-copied off
 * `chatRunSettingsSchema` for the same reason the V10 copy is: pinning only
 * the id over a LIVE body is a half freeze.
 */
export const chatRunSettingsSchemaV20 = z.object({
  harnessId: chatRunSettingsHarnessIdSchemaV20,
  model: z.string().min(1),
  permissionMode: permissionModeSchema,
  reasoningEffort: z.string().nullable(),
  serviceTier: z.string().nullable().default(null),
  agentMode: agentModeSchema,
  profileId: z.string().nullable().default(null),
});
export type ChatRunSettingsV20 = z.infer<typeof chatRunSettingsSchemaV20>;

export const getChatRunSettingsResponseSchemaV20 = z.object({
  settings: chatRunSettingsSchemaV20.nullable(),
});
export type GetChatRunSettingsResponseV20 = z.infer<
  typeof getChatRunSettingsResponseSchemaV20
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

// ─── `host.chatRecords.subscribe@1.2` - cross-host terminal-agent replicas ──
//
// The TUI roster's phase-2 freshness half. The frame KINDS are unchanged from
// `@1.1`; what grows is the row `tuiUpsert` carries, from the single registry
// shape to the three-arm `origin` union - so a delta about a terminal agent
// owned by ANOTHER of the viewer's hosts can be pushed at all.
//
// `@1.1` stays installed and FROZEN, and the gate is the negotiated version as
// before: a `@1.1` subscriber agreed to a `tuiUpsert` carrying the full
// registry row, so the host must never hand it a narrow `cloud` arm it cannot
// parse. It keeps receiving its own host's rows exactly as it did.
export const hostChatRecordsSubscribeServerFrameSchemaV12 = z
  .discriminatedUnion("kind", [
    ...hostChatRecordsSubscribeSharedServerFrameSchemasV10,
    z.object({
      kind: z.literal("tuiUpsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      record: tuiAgentRecordSummaryV12Schema,
    }),
    // Unchanged from `@1.1`, restated rather than shared: the frozen `@1.1`
    // union is declared above this point and must not take a reference to a
    // const introduced below it.
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
export type HostChatRecordsSubscribeServerFrameV12 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV12
>;

// ─── `host.chatRecords.subscribe@1.3` - the publication head on the row ─────
//
// The live-sync half of the published-copy tile: a foreign row's `upsert` now
// carries the chat's cloud head stamp, so a viewer holding a published COPY
// learns that a new turn was published instead of reading the cloud once per
// tile mount. Frame KINDS are unchanged from `@1.2`; what grows is the row the
// chat `upsert` carries.
//
// `@1.0`-`@1.2` stay installed and FROZEN on the pre-`head` row, and the gate
// is the negotiated version exactly as it is for the `@1.1` kinds and the
// `@1.2` cloud arm. An older subscriber's schema would strip `head` anyway -
// this is an added key on a non-strict object, not a new frame kind - so the
// freeze here is about what the CONTRACT promised, not about a parse that
// would fail.
//
// The row is {@link chatRecordSummaryStreamV13Schema} - the base row plus
// `head`, NOT the list's `@1.2` row. `docResident` stays off the wire here on
// purpose; that schema's note carries the argument.
//
// Every arm is restated rather than spread from the frozen `@1.0` set: that
// set embeds the pre-`head` `chatRecordSummarySchema` in its `upsert`, which
// is precisely the arm this minor grows.
export const hostChatRecordsSubscribeServerFrameSchemaV13 = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      chatId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      record: chatRecordSummaryStreamV13Schema,
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
    // Unchanged from `@1.2`, restated for the same reason its own `tuiRemove`
    // was: a frozen union declared above must not take a reference to a const
    // introduced below it.
    z.object({
      kind: z.literal("tuiUpsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      record: tuiAgentRecordSummaryV12Schema,
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
export type HostChatRecordsSubscribeServerFrameV13 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV13
>;

// ─── `host.chatRecords.subscribe@1.4` - the list revision on every delta ────
//
// Stage 2 of the record-list revision gating. Stage 1 makes the 20s poll cheap
// when nothing changed; what it cannot do is make a CHANGE cheap - any
// registry fact moving invalidates the client's stamp, so the next tick ships
// a full snapshot per open tab. This minor closes that: every record delta
// carries the list revision the write produced, so a client that applies the
// delta advances its own stamp and the next poll answers `unchanged` again.
// After it, a snapshot ships only on a genuine gap.
//
// The client's rule is `epoch` equal AND `revision === held + 1`. Anything
// else is a gap - it invalidates and re-reads the list - which is why the
// stamp must be the composite AFTER the write and why one registry change
// must produce exactly one delta. `+ 1` rather than `>` deliberately: a
// consumer that accepted any forward jump would silently skip the changes in
// between, and those are precisely what it has no other way to learn.
//
// `pong` carries NO `listRevision`, and that is not an omission: it is a
// liveness frame, not a record change, and stamping it would either repeat a
// revision (inviting a consumer to treat a keepalive as progress) or claim one
// no write produced.
//
// The `tuiUpsert` row grows to {@link tuiAgentRecordSummaryV13Schema} - the
// session facet - for the reason the list minor ships the two together: the
// facet is a registry fact, so without a delta carrying it every spawn and
// every reap would cost a snapshot, which is the cost this minor exists to
// remove.
//
// A NEW FROZEN SET beside `@1.3`, not an edit of it: streams freeze rather
// than upgrade (there is no per-frame upgrade path to run), so a client that
// negotiated `@1.3` must keep receiving exactly the frames `@1.3` promised.
// Every arm is restated rather than spread from an older set for the same
// reason `@1.3` restated `@1.0`'s: those sets embed the pre-stamp frames this
// minor grows.
export const hostChatRecordsSubscribeServerFrameSchemaV14 = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      chatId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      listRevision: recordListRevisionSchema,
      record: chatRecordSummaryStreamV13Schema,
    }),
    z.object({
      kind: z.literal("remove"),
      ...textFrameFields,
      epicId: z.string().min(1),
      chatId: z.string().min(1),
      listRevision: recordListRevisionSchema,
      reason: chatRecordRemovalReasonSchema,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("tuiUpsert"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      listRevision: recordListRevisionSchema,
      record: tuiAgentRecordSummaryV13Schema,
    }),
    z.object({
      kind: z.literal("tuiRemove"),
      ...textFrameFields,
      epicId: z.string().min(1),
      tuiAgentId: z.string().min(1),
      listRevision: recordListRevisionSchema,
      reason: chatRecordRemovalReasonSchema,
    }),
  ])
  .superRefine(refineChatUpsertEnvelope)
  .superRefine(refineTuiUpsertEnvelope);
export type HostChatRecordsSubscribeServerFrameV14 = z.infer<
  typeof hostChatRecordsSubscribeServerFrameSchemaV14
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

export const hostChatRecordsSubscribeV12 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV12,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});

export const hostChatRecordsSubscribeV13 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV13,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});

// The OPEN REQUEST is unchanged, and stays `@1.0`'s empty object: the stamp a
// client holds is per (viewer, epic) and this stream is HOST-scoped, so there
// is nothing one subscription could send that would mean anything for every
// epic it covers. Resume is still the poll's job - see `@1.0`'s note on why
// the list IS the snapshot.
export const hostChatRecordsSubscribeV14 = defineStreamRpcContract({
  method: "host.chatRecords.subscribe",
  schemaVersion: { major: 1, minor: 4 } as const,
  openRequestSchema: hostChatRecordsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: hostChatRecordsSubscribeServerFrameSchemaV14,
  clientFrameSchema: hostChatRecordsSubscribeClientFrameSchemaV10,
});
