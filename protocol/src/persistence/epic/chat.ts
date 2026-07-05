import { chatEventSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/foundation";
import { messageSchema } from "@traycer/protocol/persistence/epic/messages";
import { activeSessionChainSchema } from "@traycer/protocol/persistence/epic/senders";
import { z } from "zod";

/**
 * Sentinel host id stamped on chats imported from v1.0.0 task-chain
 * persistence. There is no real host behind these chats - the migrator
 * had no host binding to preserve - so renderers must gate host-bound
 * affordances (terminal tabs, worktree actions) behind `isLegacyHost()`.
 */
export const LEGACY_HOST_ID = "legacy";

export function isLegacyHost(id: string): boolean {
  return id === LEGACY_HOST_ID;
}

export const claudePendingWakeSchema = z.object({
  sessionId: z.string(),
  toolUseId: z.string(),
  scheduledFor: z.number(),
  prompt: z.string(),
  reason: z.string(),
});
export type ClaudePendingWake = z.infer<typeof claudePendingWakeSchema>;

/**
 * Top-level chat record. On disk, `messages` is a yjs-backed Y.Array;
 * the materialized shape that the framework versions is a plain array of
 * messages. `hostId` mirrors `tuiAgentSchema.hostId` so every tab
 * artifact carries its bound host - chats are tabs are bound to a
 * host for life (see CLAUDE.md). Cross-host continuation is
 * clone-not-migrate; this id is the clone source.
 */

export const chatSchema = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  /**
   * May be the literal LEGACY_HOST_ID for chats migrated from v1.0.0
   * schemas; use isLegacyHost() to gate renderer affordances that
   * require a live host binding.
   */
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  settings: chatRunSettingsSchema.nullable().default(null),
  activeSessionChain: activeSessionChainSchema.nullable().default(null),
  claudePendingWakes: z.array(claudePendingWakeSchema).default([]),
  messages: z.array(messageSchema),
  events: z.array(chatEventSchema).default([]),
});
export type Chat = z.infer<typeof chatSchema>;
