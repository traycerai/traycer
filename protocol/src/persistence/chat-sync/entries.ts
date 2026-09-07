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

/** The id-keyed leaves of a published chat: messages, their content blocks, and the durable event log. */

// ---- Content blocks ---------------------------------------------------- //

/** Content-block `type` values this build interprets. */
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

/** Domain block -> preserved pair. */
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
 * Assistant message with `sender` reopened and `blocks` swapped for the passthrough-preserving wrapper.
 * Derived from `assistantMessageSchema`'s live shape rather than hand-copied: this is an evolving contract, not a frozen wire line, so every field it does NOT deliberately change should keep flowing from the epic tree at.
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
