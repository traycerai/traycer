import {
  preservedChatEventSchema,
  preservedChatMessageSchema,
  type PreservedChatEvent,
  type PreservedChatMessage,
} from "@traycer/protocol/persistence/chat-sync/entries";
import {
  chatSyncHostPrivateSchema,
  chatSyncHostPrivateStorageSchema,
  type ChatSyncHostPrivate,
} from "@traycer/protocol/persistence/chat-sync/host-private";
import {
  canonicalJsonStringify,
  canonicalizeJsonObject,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  mergeResidual,
  reprojectResidualCapture,
  storageProjection,
  withResidualCapture,
} from "@traycer/protocol/persistence/chat-sync/residual";
import {
  CHAT_SYNC_SCHEMA_VERSION,
  chatSyncReaderVersionSchema,
  chatSyncSchemaVersionSchema,
  type ChatSyncPayloadVersion,
} from "@traycer/protocol/persistence/chat-sync/version";
import { z } from "zod";

/**
 * The `chat-shard` record: one immutable, content-addressed PART of a
 * published chat.
 *
 * A shard is a cohort, not a snapshot. Messages are assigned to a shard at
 * creation and never rebalanced, so an old shard is byte-stable under append
 * and a publish re-uploads only the cohorts whose own contents changed. The
 * head (`head.ts`) names the parts and states their order; a shard states only
 * what it holds.
 *
 * ## Three sections, one record
 *
 * Message cohorts are the reason the layout exists, but two other head
 * sections graduate into parts once they outgrow the head: the event log
 * (cohort-style, because events are id-keyed like messages) and the opaque
 * `hostPrivate` envelope (whole). They ride this same record rather than two
 * more, because the transport, the verification and the version line are
 * identical for all three - only the payload differs.
 *
 * `section` says which one, and the shape is flat rather than a nested
 * discriminated union: one captured residual level, one storage projection,
 * one encoder. `refineChatShardSection` is what keeps "flat" from meaning
 * "mushy" - it rejects a shard whose payload does not match its own tag, so a
 * malformed part fails at parse rather than being half-assembled.
 *
 * ## What is NOT here
 *
 * No `key`, no storage generation, no publication seq. A shard is addressed by
 * the sha256 of its canonical bytes and by nothing else; the key layout is a
 * host/server concern derived from that hash under a `(task, tenant kind)`
 * prefix, and readers never parse keys. A shard also carries no watermark: the
 * head owns `throughRecordSeq` for the publication as a whole, and duplicating
 * it per part would invent a second thing to disagree.
 *
 * ## COMPAT: what a same-major minor may add HERE
 *
 * The `shard` residual bag does not survive a clone's re-publication - assembly
 * keeps only the head's, and a clone re-shards from its own projection, so
 * there is nothing left to attach a per-shard bag to. A minor may therefore add
 * a top-level field here for per-PUBLICATION bookkeeping, but must not put
 * load-bearing chat-level data on this record: durable additions go head-level
 * or message-level. `captured-levels.ts` states the rule and why it is not an
 * oversight to fix.
 */

export const chatShardSectionSchema = z.enum([
  "messages",
  "events",
  "host-private",
]);
export type ChatShardSection = z.infer<typeof chatShardSectionSchema>;

export const chatShardRecordShape = {
  /**
   * Self-describing record version. Carried INSIDE the part as well as being
   * implied by the head that named it: a shard downloaded on its own - an
   * orphan found by a startup sweep, a quarantined candidate during
   * CAS-conflict repair - has to be identifiable without the head. Pinned to a
   * literal (see `version.ts`) so a payload cannot claim to be anything other
   * than the contract that accepted it.
   */
  schemaVersion: chatSyncSchemaVersionSchema,
  /**
   * Chat this part belongs to. The one field that makes a detached shard
   * attributable, and the cross-check that stops a part from another chat -
   * or another chat's fork - being assembled into this one.
   */
  chatId: z.string().min(1),
  /** Which head section this part carries. */
  section: chatShardSectionSchema,
  /**
   * Ordered preserved messages: non-empty when `section` is `"messages"`,
   * empty otherwise. A shard IS a cohort, so there is no empty one - see
   * `refineChatShardSection`.
   */
  messages: z.array(preservedChatMessageSchema),
  /** Ordered preserved events: non-empty when `section` is `"events"`, empty otherwise. */
  events: z.array(preservedChatEventSchema),
  /** Opaque host state: present when `section` is `"host-private"`, `null` otherwise. */
  hostPrivate: chatSyncHostPrivateSchema.nullable(),
} as const;

/**
 * A shard's payload must match its own `section` tag, and that section must
 * actually carry something.
 *
 * Stated as a refinement rather than as a nested discriminated union so the
 * record stays one flat captured level (see the module note). Both halves fail
 * closed:
 *
 * - **Wrong section.** A `"messages"` shard carrying events is a writer bug,
 *   and assembling it would silently drop them.
 * - **Empty section.** A shard IS a cohort, and an empty cohort is not one. An
 *   empty `"events"` shard paired with a head whose `events` are `null` states
 *   an impossible graduation - a section that outgrew the head yet holds
 *   nothing - and it would assemble to `status: "ok"` with an empty log, which
 *   is indistinguishable from a chat that never had events. An empty chat is
 *   represented by an EMPTY SHARD LIST in the head, never by an empty shard;
 *   the alternative mints content addresses and fetches for nothing.
 *
 * `host-private` is the same rule stated over a nullable rather than an array:
 * the envelope must be present.
 */
export function refineChatShardSection(
  shard: {
    readonly section: ChatShardSection;
    readonly messages: readonly unknown[];
    readonly events: readonly unknown[];
    readonly hostPrivate: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const populated: Record<ChatShardSection, boolean> = {
    messages: shard.messages.length > 0,
    events: shard.events.length > 0,
    "host-private": shard.hostPrivate !== null,
  };

  for (const section of chatShardSectionSchema.options) {
    if (section === shard.section || !populated[section]) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [sectionPath(section)],
      message: `A "${shard.section}" shard must not carry ${section} content`,
    });
  }

  if (populated[shard.section]) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [sectionPath(shard.section)],
    message:
      shard.section === "host-private"
        ? `A "host-private" shard must carry a hostPrivate envelope`
        : `A "${shard.section}" shard must carry at least one entry; an empty chat is an empty shard list on the head, not an empty shard`,
  });
}

function sectionPath(section: ChatShardSection): string {
  return section === "host-private" ? "hostPrivate" : section;
}

/**
 * The registered writer schema's inner value. `_internal/chat-sync-schemas.ts`
 * owns the single registered instance; this is the same construction, exported
 * so the reader schema below can mirror it without re-declaring the shape.
 */
export const chatShardSchema = withResidualCapture(
  "shard",
  chatShardRecordShape,
).superRefine(refineChatShardSection);

/**
 * The forward-compatible READER schema: same major, any minor, everything else
 * identical. See `version.ts` for why acceptance widens while the writer keeps
 * stamping the pinned literal.
 *
 * Built through `reprojectResidualCapture`, which does NOT register a capture
 * site - this is the same `shard` level, only more accepting.
 */
export const chatShardReaderSchema = reprojectResidualCapture({
  ...chatShardRecordShape,
  schemaVersion: chatSyncReaderVersionSchema,
}).superRefine(refineChatShardSection);

/**
 * The persisted shape: declared fields, no `residual`, unmodeled keys allowed
 * at every captured level. What the frozen `storage` surface is generated
 * from, because a capturing schema cannot describe its own wire form.
 */
export const chatShardStorageSchema = storageProjection({
  ...chatShardRecordShape,
  hostPrivate: chatSyncHostPrivateStorageSchema.nullable(),
});

/**
 * Public structural mirror of the registered record.
 *
 * The record's Zod value lives behind the `_internal/` privacy boundary, so
 * this module carries the type and the encoder instead - consumers (and the
 * encoder itself) never import the private schema module or take a dependency
 * cycle through the registry. `chat-sync-record-shape.test.ts` asserts this
 * type and the registered value stay mutually assignable.
 */
export type ChatShardRecord = {
  readonly schemaVersion: ChatSyncPayloadVersion;
  readonly chatId: string;
  readonly section: ChatShardSection;
  // Element types match Zod's inference exactly - see the note on
  // `ChatHeadRecord` for why a `readonly T[]` would break the mirror guard.
  readonly messages: PreservedChatMessage[];
  readonly events: PreservedChatEvent[];
  readonly hostPrivate: ChatSyncHostPrivate | null;
  /** Top-level keys a newer minor added, preserved for re-emission. */
  readonly residual: JsonObject;
};

/**
 * Domain shard -> canonical persisted JSON.
 *
 * Preserved variants encode back to their `raw`, which is why a subtree this
 * reader never interpreted survives a read/write cycle. The MAJOR is stamped
 * from the constant rather than copied off the record - the writer states what
 * it actually wrote - while the minor is carried, so a shard read forward
 * re-publishes as the version it actually contains rather than being
 * relabelled.
 *
 * **Canonical form is the schema-NORMALIZED encoding**, not a byte echo of the
 * input: a field carrying `.default(...)` materializes on the way through, so
 * `encode(decode(x))` can differ from `canonical(x)` for an input that omitted
 * one. What holds, and what the tests pin, is IDEMPOTENCE -
 * `encode(decode(encode(decode(x))))` equals `encode(decode(x))` - which is
 * exactly what makes a shard's content address stable across read/write
 * cycles. Without it a clone target's re-publication would mint new hashes for
 * unchanged cohorts and re-upload the whole chat.
 *
 * Deliberately hand-written rather than `z.encode(...)` on the record schema:
 * the encoder is what a publisher hashes and uploads, so its output must be
 * predictable and independent of how Zod chooses to reverse nested codecs and
 * defaults.
 */
export function encodeChatShard(record: ChatShardRecord): JsonObject {
  const { messages, events, hostPrivate, residual, ...declared } = record;

  return canonicalizeJsonObject(
    mergeResidual(
      {
        ...declared,
        schemaVersion: {
          major: CHAT_SYNC_SCHEMA_VERSION.major,
          minor: record.schemaVersion.minor,
        },
        messages: messages.map((message) => message.raw),
        events: events.map((event) => event.raw),
        hostPrivate:
          hostPrivate === null ? null : encodeHostPrivate(hostPrivate),
      },
      residual,
    ),
  );
}

/** A captured level whose declared fields are already plain JSON. */
export function encodeHostPrivate(
  hostPrivate: ChatSyncHostPrivate,
): JsonObject {
  const { residual, ...declared } = hostPrivate;
  return mergeResidual({ ...declared }, residual);
}

/**
 * Canonical bytes for a shard: what the publisher hashes into its content
 * address and uploads, and what a reader hashes to verify the part it fetched.
 * Canonicalization normalizes object key order, so two publishers of the same
 * cohort produce the same bytes and therefore the same object.
 */
export function serializeChatShard(record: ChatShardRecord): string {
  return canonicalJsonStringify(encodeChatShard(record));
}
