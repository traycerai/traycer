import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The single literal version of the chat-sync publication contract.
 *
 * Deliberately its own module, importing nothing but Zod, so the registered
 * payload schemas (`_internal/chat-sync-schemas.ts`), the registry entries,
 * and the writers (`head.ts` / `shard.ts`) can all bind to the SAME literal
 * without a dependency cycle.
 *
 * **One version line for both records.** `chat-head` and `chat-shard` are two
 * halves of one publication: a shard embeds the same message / block / event
 * sub-schemas the head's core is built from, and a reader that gates on the
 * head then parses the shards it names. Every change that moves one moves the
 * other, so they bump together, always - the same argument that put
 * `chat-snapshot` and its increment on one line in the v1 design.
 *
 * Why a literal rather than the generic `{major, minor}` schema: a payload's
 * `schemaVersion` is self-identifying - it is what a repair verb, an orphan
 * sweep, or a clone target trusts when a downloaded object is detached from
 * the row that pointed at it. A generic schema lets a v1.0 parser accept a
 * payload claiming `{major: 99, minor: 77}`, which makes that field worthless
 * exactly when it matters. Pinning it means a payload can only ever claim the
 * version of the contract that accepted it.
 *
 * A new minor adds new contracts with their own literal here (`z.literal(1)`
 * for 1.1, and so on) alongside their registry entries.
 *
 * **1.2** carries canonical interview settlement: the interview content block
 * gained `outcome`, `draftAnswers`, `settlement`, `diagnostics` and `delivery`,
 * and each interview answer gained `selection`. Every one of those is
 * `.default(...)`-ed, so a 1.1 record parses unchanged, and §2/§3 of
 * `COMPATIBILITY.md` (the passthrough's `raw` re-emission and residual capture)
 * already make a 1.1 reader's re-publication of a 1.2 chat mechanically
 * lossless - which is why `CHAT_SYNC_1_1_READER_FLOOR` is NOT raised and a 1.2
 * head still stamps `minReaderVersion: null`. The bump exists because the
 * coupled-bump ritual requires the record minor for a `chat.subscribe` field
 * that also lands in a publication (these rode `chat.subscribe@1.7`), and
 * because a payload's self-identifying version is what a detached repair
 * candidate is trusted on.
 */
// 1.3 adds `chat.imported` to `KNOWN_CHAT_EVENT_TYPES`. A new chat-event type
// is a MINOR here and only here: the unknown-variant passthrough
// (`passthrough.ts`) is what lets an older reader meet the event, keep it whole
// in `raw`, and re-publish it unchanged - the mechanism `COMPATIBILITY.md`
// names as reclassifying this class of addition from breaking to additive.
// (Renumbered from 1.2 when main's interview-settlement bump took that minor.)
// 1.3 also drops `outerHtml` and the raw `attributes` map from the browser
// annotation record (root cause H: page content in collaborator-readable chat
// persistence); both fields are unreleased, so this takes no bump of its own.
//
// 1.3 also carries `tool_call.agentMessageReceipt` (the receiver-side message
// id a `traycer_send_message` call landed as - a `chat.subscribe@1.7+` field
// that lands in a publication). It rides this still-unreleased minor rather
// than opening 1.4: `host-v1.2.0` shipped chat-sync 1.1, so 1.3 is already the
// next line a released reader will meet. Defaulted `null`, so a 1.1 record
// parses unchanged and residual capture (§3) carries it through an older
// publisher losslessly - `CHAT_SYNC_1_1_READER_FLOOR` stays where it is.
// 1.4 adds autonomous_resume.deliveryPlacement, defaulting to unknown for
// old data. It is presentation metadata; the minimum reader does not change.
//
// 1.4 also carries `error.failure` (the typed provider failure behind an
// error block - a `chat.subscribe@1.10` field that lands in a publication). It
// rides this still-unreleased minor on the same rule as `agentMessageReceipt`
// above: `host-v1.3.0` shipped chat-sync 1.3, so 1.4 is the next line a
// released reader will meet. Defaulted `null`, so an older record parses
// unchanged and residual capture (§3) carries it through an older publisher
// losslessly; the minimum reader does not change.
//
// 1.4 also carries `autonomous_resume.triggers[].managedCommand.hostId` (the
// host a resume trigger's shell runs on - a `chat.subscribe@1.11` field that
// lands in a publication), on the same still-unreleased-minor rule. Defaulted
// `null`; the minimum reader does not change.
//
// 1.5 reopens `core.settings.permissionMode` from a closed enum to a checked
// string, so a mode added after this minor does not make a published chat
// unreadable - the same reopening `noticeKind` got in 1.3, for the same reason
// (`open-harness.ts`). Widening a leaf from enum to string is additive for a
// reader: every value a 1.4 record can carry still parses, and the reverse
// direction is what the reopening exists to survive.
// `CHAT_SYNC_1_1_READER_FLOOR` is NOT raised, and this reopening on its own
// stamps no floor: §2/§3's `raw` re-emission and residual capture keep an older
// reader's re-publication lossless. Scoped to the reopening deliberately - a
// 1.5 head CAN carry `minReaderVersion`, for a reason unrelated to this leaf.
// `chatSyncReaderFloorForTranscriptEvents` in `head.ts` returns
// `CHAT_SYNC_UNATTENDED_DENIAL_READER_FLOOR` for any publication whose events
// hold an unattended auto-judge denial row (or 1.6's higher notice floor when a
// judge notice is there too), so a publisher must still ask it
// rather than reading "1.5 stamps null" here and hard-coding the null; skipping
// the call ships a head an older reader projects with the refusal row missing.
//
// **It protects readers from 1.5 ONWARD, and `auto` is on the wrong side of
// that line.** `host-v1.3.x` ships chat-sync 1.3, whose
// `snapshotChatRunSettingsSchema` still inherits the closed three-value enum,
// and `decodeChatHeadDocument` parses the whole payload at step 4 - before
// `gateChatHeadVersion` is ever called, and before residual capture can see the
// leaf. So a chat published in `auto` decodes `schema-rejected` on every reader
// shipped before this minor: no data loss and no misreading, but a shared chat
// or clone source such a reader cannot open until it updates.
//
// That residual window is precedented rather than new - 1.3's `noticeKind`
// reopening left exactly the same window toward the 1.1 readers `host-v1.2.0`
// shipped, and `harness_message` and the five `fallback_*` kinds were added
// into it. Closing it for `auto` specifically would mean publishing a
// pre-`auto` value in this field and carrying the real mode elsewhere, which
// trades a fail-closed refusal for a record that misreports a
// permission-relevant field to the readers least able to know better (and
// clones as that value). That is a product call, not a schema one; it is
// deliberately NOT taken here, and nothing in this file should be read as
// claiming the exposure does not exist.
// (Renumbered from 1.4 on the merge to main, which had taken that minor for
// the delivery-placement field above.)
// 1.6 carries the negative provider-history marker (`providerHistory:
// "excluded"`) on an accepted opening message that has not been sent yet.
// Additive, and deliberately WITHOUT a reader floor (see the note above
// `chatSyncReaderFloorForTranscriptEvents` in `head.ts`): an older reader
// renders the row as the ordinary user message it is, and the marker's only
// consumer is a host keeping the row out of provider history. Nor can an older
// host clone the row into a new chat's history: every fork slices at an
// assistant record, and nothing follows an unresolved opening.
//
// 1.6 also carries the auto-mode judge notice row (`autoJudgeNoticeRowSource`
// in `row-order.ts`) and, unlike the marker above, it DOES stamp a floor:
// `CHAT_SYNC_AUTO_JUDGE_NOTICE_READER_FLOOR`, for the reason the 1.5 denial row
// does - an older reader parses the `permission.blocked` event and projects no
// row for it. It rides this still-unreleased minor on the same rule as the
// fields above (`host-v1.3.0` shipped chat-sync 1.3).
//
// 1.6 also carries `text.providerNotice.receipt` (the settled fallback card's
// structured account - a `chat.subscribe@1.18` field that lands in a
// publication), on the same still-unreleased-minor rule: the newest release,
// `host-v1.3.1`, still ships chat-sync 1.3. Optional, so an older record
// parses unchanged, and a content block's `raw` re-emission (§2 of
// `COMPATIBILITY.md`) carries the key through an older reader's
// re-publication. No reader floor: an older reader renders the notice from
// `title` / `message` / `details` exactly as before, which is the divider that
// notice was until this key existed.
export const CHAT_SYNC_SCHEMA_VERSION = { major: 1, minor: 6 } as const;

export type ChatSyncSchemaVersion = typeof CHAT_SYNC_SCHEMA_VERSION;

/**
 * Payload-side schema for `schemaVersion`, pinned to the constant above so the
 * two cannot drift. A payload claiming any other version is not a v1.1 record
 * and does not parse as one.
 */
export const chatSyncSchemaVersionSchema = lazySchema(() =>
  z.object({
    major: z.literal(CHAT_SYNC_SCHEMA_VERSION.major),
    minor: z.literal(CHAT_SYNC_SCHEMA_VERSION.minor),
  }),
);

/**
 * The version a READER may accept, as opposed to the one a writer stamps.
 *
 * The gate admits every same-major publication whatever its minor - that is
 * what makes the passthrough and the residual bags worth having. The strict
 * schema above would then reject a genuine 1.1 payload immediately after
 * download, leaving the promise unreachable end to end, so acceptance is
 * widened here to "same major, any minor" while the writer keeps stamping the
 * pinned literal.
 *
 * Nothing about the anti-forgery property is given up. A payload still cannot
 * claim a version its parser did not accept: the major is pinned, so no
 * payload can pass itself off as belonging to a different contract line, and
 * a shard is still cross-checked against the head that named it.
 *
 * Older minors are accepted too: a 1.4 reader meeting a 1.0 head is the
 * ordinary case, not the interesting one.
 */
export const chatSyncReaderVersionSchema = lazySchema(() =>
  z.object({
    major: z.literal(CHAT_SYNC_SCHEMA_VERSION.major),
    minor: z.number().int().nonnegative(),
  }),
);

/**
 * A payload version as a reader may see it: this contract's major, any minor.
 * `ChatSyncSchemaVersion` (the writer's pinned literal) is a narrowing of it,
 * so a freshly written record satisfies both.
 */
export type ChatSyncPayloadVersion = {
  readonly major: ChatSyncSchemaVersion["major"];
  readonly minor: number;
};

/** Lowercase hex SHA-256, the only form a content address is written in. */
export const sha256HexSchema = lazySchema(() =>
  z.string().regex(/^[0-9a-f]{64}$/),
);
