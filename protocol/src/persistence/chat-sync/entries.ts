import {
  definePreservedVariant,
  preserveKnownVariant,
  type PreservedVariant,
} from "@traycer/protocol/persistence/chat-sync/passthrough";
import {
  jsonObjectSchema,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  snapshotAgentSenderSchema,
  snapshotChatEventSchema,
  snapshotContentBlockSchema,
  snapshotUserMessageSchema,
  type SnapshotChatEvent,
  type SnapshotContentBlock,
} from "@traycer/protocol/persistence/chat-sync/open-harness";
import { chatEventTypeSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { assistantMessageSchema } from "@traycer/protocol/persistence/epic/messages";
import { z } from "zod";

/**
 * The id-keyed leaves of a published chat: messages, their content blocks, and
 * the durable event log. These are what a `chat-shard` carries, and they are
 * reused VERBATIM from the v1 `chat-snapshot` core - forward compatibility is
 * a property of the message encoding, not of the sync layer, so it carries
 * across the publication-layout pivot untouched.
 *
 * The message / block / event leaves reuse the registered epic sub-schemas
 * rather than re-declaring them. That keeps one source of truth for a chat's
 * shape across the Yjs-era `epic` record and this contract; the cost is that a
 * change to those sub-schemas trips BOTH frozen-surface guards, which is the
 * correct signal - the change really is a change to both contracts.
 *
 * Two adjustments are made on top of those shared leaves:
 *
 * - message `role`, content-block `type` and chat-event `type` ride
 *   passthrough-preserving wrappers, so a newer writer's vocabulary survives
 *   an older reader (see `passthrough.ts`);
 * - every closed harness-id enum is reopened to a plain string, so adding a
 *   harness does not make existing chats unreadable (see `open-harness.ts`).
 */

// ---- Content blocks ---------------------------------------------------- //

/**
 * Content-block `type` values this build interprets. Anything else is
 * preserved verbatim and surfaces as `value: null`.
 *
 * Kept as an explicit list rather than derived from `contentBlockSchema`'s
 * internals: the list IS the reader's declared vocabulary, and a test
 * cross-checks it against the union's JSON Schema so adding a block type
 * without listing it here fails loudly instead of silently demoting every
 * block of that type to "unknown".
 */
export const KNOWN_CONTENT_BLOCK_TYPES = [
  "text",
  "reasoning",
  "tool_call",
  "file_change",
  "command",
  "subagent",
  "approval",
  "todo",
  "plan",
  "error",
  "compaction",
  "autonomous_resume",
  "steer",
  "interview",
  "artifact_operation",
] as const;

export const preservedContentBlockSchema = definePreservedVariant({
  discriminant: "type",
  knownVariants: KNOWN_CONTENT_BLOCK_TYPES,
  knownSchema: snapshotContentBlockSchema,
  label: "content block",
});
export type PreservedContentBlock = PreservedVariant<SnapshotContentBlock>;

/**
 * Domain block -> preserved pair. Routes through `z.encode` so the
 * codec-backed `autonomous_resume` block is written in its PERSISTED form
 * (`wakeTriggers` split out) rather than its domain form - writing the domain
 * form verbatim is exactly the regression this helper exists to prevent.
 */
export function preserveContentBlock(
  block: SnapshotContentBlock,
): PreservedContentBlock {
  const encoded: JsonObject = jsonObjectSchema.parse(
    z.encode(snapshotContentBlockSchema, block),
  );
  return preserveKnownVariant("type", encoded, block);
}

// ---- Messages ---------------------------------------------------------- //

/**
 * Assistant message with `sender` reopened and `blocks` swapped for the
 * passthrough-preserving wrapper.
 *
 * Derived from `assistantMessageSchema`'s live shape rather than hand-copied:
 * this is an evolving contract, not a frozen wire line, so every field it does
 * NOT deliberately change should keep flowing from the epic tree at its live
 * type. A hand copy could go stale on a field type while still passing a
 * name-only parity check.
 */
export const chatSyncAssistantMessageSchema = z.object({
  ...assistantMessageSchema.shape,
  sender: snapshotAgentSenderSchema,
  blocks: z.array(preservedContentBlockSchema),
});
export type ChatSyncAssistantMessage = z.infer<
  typeof chatSyncAssistantMessageSchema
>;

export const chatSyncMessageSchema = z.discriminatedUnion("role", [
  snapshotUserMessageSchema,
  chatSyncAssistantMessageSchema,
]);
export type ChatSyncMessage = z.infer<typeof chatSyncMessageSchema>;

export const KNOWN_CHAT_MESSAGE_ROLES = ["user", "assistant"] as const;

export const preservedChatMessageSchema = definePreservedVariant({
  discriminant: "role",
  knownVariants: KNOWN_CHAT_MESSAGE_ROLES,
  knownSchema: chatSyncMessageSchema,
  label: "chat message",
});
export type PreservedChatMessage = PreservedVariant<ChatSyncMessage>;

export function preserveChatMessage(
  message: ChatSyncMessage,
): PreservedChatMessage {
  const encoded: JsonObject = jsonObjectSchema.parse(
    z.encode(chatSyncMessageSchema, message),
  );
  return preserveKnownVariant("role", encoded, message);
}

// ---- Events ------------------------------------------------------------ //

/**
 * Chat-event `type` is an ENUM, not a union, so a new event type is normally
 * a breaking persistence change - widening an enum makes shipped strict
 * readers reject the whole record. Wrapping events in the same passthrough
 * carrier reclassifies that to a minor, for the same reason it does for
 * content-block types.
 */
export const KNOWN_CHAT_EVENT_TYPES = chatEventTypeSchema.options;

export const preservedChatEventSchema = definePreservedVariant({
  discriminant: "type",
  knownVariants: KNOWN_CHAT_EVENT_TYPES,
  knownSchema: snapshotChatEventSchema,
  label: "chat event",
});
export type PreservedChatEvent = PreservedVariant<SnapshotChatEvent>;

export function preserveChatEvent(
  event: SnapshotChatEvent,
): PreservedChatEvent {
  const encoded: JsonObject = jsonObjectSchema.parse(
    z.encode(snapshotChatEventSchema, event),
  );
  return preserveKnownVariant("type", encoded, event);
}
