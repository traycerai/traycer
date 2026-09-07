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
 * The `chat-shard` record: one immutable, content-addressed PART of a published chat.
 * Messages are assigned to a shard at creation and never rebalanced, so an old shard is byte-stable under append and a publish re-uploads only the cohorts whose own contents changed.
 */

export const chatShardSectionSchema = z.enum([
  "messages",
  "events",
  "host-private",
]);
export type ChatShardSection = z.infer<typeof chatShardSectionSchema>;

export const chatShardRecordShape = {
  /**
   * Self-describing record version.
   * Pinned to a literal (see `version.ts`) so a payload cannot claim to be anything other than the contract that accepted it.
   */
  schemaVersion: chatSyncSchemaVersionSchema,
  /** Chat this part belongs to. */
  chatId: z.string().min(1),
  section: chatShardSectionSchema,
  /** Ordered preserved messages: non-empty when `section` is `"messages"`, empty otherwise. */
  messages: z.array(preservedChatMessageSchema),
  /** Ordered preserved events: non-empty when `section` is `"events"`, empty otherwise. */
  events: z.array(preservedChatEventSchema),
  /** Opaque host state: present when `section` is `"host-private"`, `null` otherwise. */
  hostPrivate: chatSyncHostPrivateSchema.nullable(),
} as const;

/**
 * A shard's payload must match its own `section` tag, and that section must actually carry something.
 * `host-private` is the same rule stated over a nullable rather than an array: the envelope must be present.
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

/** The registered writer schema's inner value. */
export const chatShardSchema = withResidualCapture(
  "shard",
  chatShardRecordShape,
).superRefine(refineChatShardSection);

/** The forward-compatible READER schema: same major, any minor, everything else identical. */
export const chatShardReaderSchema = reprojectResidualCapture({
  ...chatShardRecordShape,
  schemaVersion: chatSyncReaderVersionSchema,
}).superRefine(refineChatShardSection);

/**
 * The persisted shape: declared fields, no `residual`, unmodeled keys allowed at every captured level.
 * What the frozen `storage` surface is generated from, because a capturing schema cannot describe its own wire form.
 */
export const chatShardStorageSchema = storageProjection({
  ...chatShardRecordShape,
  hostPrivate: chatSyncHostPrivateStorageSchema.nullable(),
});

/** Public structural mirror of the registered record. */
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
 * Preserved variants encode back to their `raw`, which is why a subtree this reader never interpreted survives a read/write cycle.
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
 * Canonical bytes for a shard: what the publisher hashes into its content address and uploads, and what a reader hashes to verify the part it fetched.
 */
export function serializeChatShard(record: ChatShardRecord): string {
  return canonicalJsonStringify(encodeChatShard(record));
}
