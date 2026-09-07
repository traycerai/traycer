import {
  chatEventSchema,
  chatEventSchemaPreImported,
  chatEventSchemaPreInReplyTo,
  chatEventSchemaPreReasonix,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  chatRunSettingsSchema,
  chatRunSettingsSchemaPreReasonix,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  messageSchema,
  messageSchemaPreImage,
  messageSchemaPreInReplyTo,
  messageSchemaPreReasonix,
  messageSchemaPreSettlement,
} from "@traycer/protocol/persistence/epic/messages";
import {
  activeSessionChainSchema,
  activeSessionChainSchemaPreReasonix,
} from "@traycer/protocol/persistence/epic/senders";
import { z } from "zod";

/**
 * Sentinel host id stamped on chats imported from v1.0.0 task-chain persistence.
 * There is no real host behind these chats - the migrator had no host binding to preserve - so renderers must gate host-bound affordances (terminal tabs, worktree actions) behind `isLegacyHost()`.
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
  retryDeadlineStartedAt: z.number().nullable().optional(),
  // A due wake can be parked behind a detached interview while a later history rewrite temporarily clears the chat's active chain.
  heldChain: activeSessionChainSchema.nullable().optional(),
});
export type ClaudePendingWake = z.infer<typeof claudePendingWakeSchema>;

// Pre-Reasonix copy for `chat.subscribe@1.6`: `heldChain` names the harness
// whose session the parked wake will resume.
const claudePendingWakeSchemaPreReasonix = z.object({
  sessionId: z.string(),
  toolUseId: z.string(),
  scheduledFor: z.number(),
  prompt: z.string(),
  reason: z.string(),
  retryDeadlineStartedAt: z.number().nullable().optional(),
  heldChain: activeSessionChainSchemaPreReasonix.nullable().optional(),
});

// `claudePendingWakeSchema` is persisted state. The chat.subscribe snapshots
// below are frozen wire contracts, so they retain this pre-deadline shape.
const claudePendingWakeSchemaPreRetryDeadline = z.object({
  sessionId: z.string(),
  toolUseId: z.string(),
  scheduledFor: z.number(),
  prompt: z.string(),
  reason: z.string(),
});

/**
 * Top-level chat record. On disk `messages` is a Y.Array; `hostId` is the bound host (clone-not-migrate).
 */

export const chatSchema = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  /**
   * May be the literal LEGACY_HOST_ID for chats migrated from v1.0.0 schemas; use isLegacyHost() to gate renderer affordances that require a live host binding.
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
  /** Wall-clock ms when this chat was archived, or `null` while active. */
  archivedAt: z.number().nullable().default(null),
  /**
   * The user-facing provider handle, pinned once and rendered from this record forever (see the prompt-freeze decision log).
   * Defaulted (not just nullable) so an absent key still parses.
   */
  pinnedUserProviderHandle: z.string().nullable().default(null),
  /**
   * Digest cursor for the role-registry delivery channel (see roles-snapshot-delivery): the hash of the canonically-serialized claims last delivered to this agent.
   * Unlike `pinnedUserProviderHandle`, an absent key and an explicit `null` are equivalent here - both read as "never delivered" (a brand-new agent, or a record persisted before this field existed).
   */
  lastDeliveredRolesDigest: z.string().nullable().default(null),
});
export type Chat = z.infer<typeof chatSchema>;

/** Frozen Epic 2.0 chat record. */
export const chatSchemaPreReasonix = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z.array(claudePendingWakeSchemaPreReasonix).default([]),
  messages: z.array(messageSchemaPreReasonix),
  events: z.array(chatEventSchemaPreReasonix).default([]),
  archivedAt: z.number().nullable().default(null),
  pinnedUserProviderHandle: z.string().nullable().default(null),
  lastDeliveredRolesDigest: z.string().nullable().default(null),
});

// Wire-freeze copy with `messages`/`events` swapped for their pre-`inReplyTo` freezes, bound to `chat.subscribe@1.0-1.3` snapshot serverFrames so those lines match the shipped wire and strip `inReplyTo` for older peers.
// Hand-frozen (non-sender fields reuse the live sub-schemas); NOT derived from the live shape.
export const chatSchemaPreInReplyTo = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Pre-Reasonix freeze: this released line must never observe a harness id its installed client's strict enum cannot decode (see `chatRunSettingsSchemaPreReasonix`).
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z
    .array(claudePendingWakeSchemaPreRetryDeadline)
    .default([]),
  messages: z.array(messageSchemaPreInReplyTo),
  events: z.array(chatEventSchemaPreInReplyTo).default([]),
});

/**
 * The epic RECORD's view of a chat: the live shape with the event-type enum pinned to its pre-`chat.imported` vocabulary.
 * Derived from `chatSchema` rather than hand-frozen, deliberately: only this one enum is pinned, so the epic record keeps following every other chat change exactly as it did before.
 */
export const chatSchemaPreImported = chatSchema.extend({
  events: z.array(chatEventSchemaPreImported).default([]),
});

// Wire-freeze copy without `archivedAt`, bound to `chat.subscribe@1.4`'s snapshot serverFrame so that released line stays verbatim - archiving rides a `1.5` minor instead (see `archivedAt` above and.
// Hand-frozen (every other field reuses the live sub-schemas); NOT derived from the live shape.
export const chatSchemaV14 = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Pre-Reasonix freeze: this released line must never observe a harness id its installed client's strict enum cannot decode (see `chatRunSettingsSchemaPreReasonix`).
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z
    .array(claudePendingWakeSchemaPreRetryDeadline)
    .default([]),
  // Pre-image freeze (see `messageSchemaPreImage`): this released line must never observe `imageResults`/the image resolution record, which the live `messageSchema` would otherwise silently gain.
  messages: z.array(messageSchemaPreImage),
  // Frozen on both axes - pre-Reasonix actor AND pre-`chat.imported` type (the enum is strict on both sides, so a released line must not follow the live one).
  events: z.array(chatEventSchemaPreReasonix).default([]),
});

// Wire-freeze copy with `archivedAt` (the field `1.5` shipped) but without `pinnedUserProviderHandle` / `lastDeliveredRolesDigest`, bound to `chat.subscribe@1.5`'s snapshot serverFrame so that released line stays verbatim.
// Hand-frozen (every other field reuses the live sub-schemas); NOT derived from the live shape - see `chatSchemaV14`'s comment for why a released line must not follow `chatSchema` by reference.
export const chatSchemaV15 = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Pre-Reasonix freeze: this released line must never observe a harness id its installed client's strict enum cannot decode (see `chatRunSettingsSchemaPreReasonix`).
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z
    .array(claudePendingWakeSchemaPreRetryDeadline)
    .default([]),
  // Pre-image freeze (see `messageSchemaPreImage`): this released line must never observe `imageResults`/the image resolution record, which the live `messageSchema` would otherwise silently gain.
  messages: z.array(messageSchemaPreImage),
  // Frozen on both axes: see `chatSchemaV14` above.
  events: z.array(chatEventSchemaPreReasonix).default([]),
  archivedAt: z.number().nullable().default(null),
});

// Wire-freeze copy of the chat tree as `chat.subscribe@1.6` shipped it in `host-v1.2.0-rc.1`: every field the live `chatSchema` carried at that tag - including `pinnedUserProviderHandle` and `lastDeliveredRolesDigest`.
// Hand-frozen field-for-field; NOT derived from `chatSchema`.
export const chatSchemaV16 = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Every harness-bearing leaf additionally takes its pre-Reasonix freeze: `1.6` is released with a nineteen-id enum, so the settings tuple, the session chain, a parked wake's held chain, the message tree and the event.
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z.array(claudePendingWakeSchemaPreReasonix).default([]),
  messages: z.array(messageSchemaPreSettlement),
  events: z.array(chatEventSchemaPreReasonix).default([]),
  archivedAt: z.number().nullable().default(null),
  pinnedUserProviderHandle: z.string().nullable().default(null),
  lastDeliveredRolesDigest: z.string().nullable().default(null),
});
