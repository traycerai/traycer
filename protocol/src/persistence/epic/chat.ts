import {
  chatEventSchema,
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
  retryDeadlineStartedAt: z.number().nullable().optional(),
  // A due wake can be parked behind a detached interview while a later
  // history rewrite temporarily clears the chat's active chain. Preserve the
  // validated chain with the wake so host hydration can restore it instead of
  // pruning the wake after a restart during that handoff.
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
  /**
   * Wall-clock ms when this chat was archived, or `null` while active.
   * Archiving is a durable, host-backed flag (see the "Archive Mechanism"
   * in the chat-sidebar redesign plan): the sidebar hides an archived chat's
   * whole subtree behind the "Show archived" filter. Set/cleared via the
   * optional `epic.setChatArchived` RPC. Defaulted so records persisted
   * before archiving existed parse unchanged.
   */
  archivedAt: z.number().nullable().default(null),
  /**
   * The user-facing provider handle, pinned once and rendered from this
   * record forever (see the prompt-freeze decision log). Tristate, and the
   * two "unset" states are NOT equivalent: ABSENT (the raw persisted key is
   * missing - records written before this field existed) means "not pinned
   * yet", read lazily and pinned on the next prompt build; an explicit
   * `null` means "resolve failed at creation" and is final - render no
   * handle sentence for this agent, permanently, never retried. A fork
   * copies the source record's value rather than re-resolving. Defaulted
   * (not just nullable) so an absent key still parses.
   */
  pinnedUserProviderHandle: z.string().nullable().default(null),
  /**
   * Digest cursor for the role-registry delivery channel (see
   * roles-snapshot-delivery): the hash of the canonically-serialized claims
   * last delivered to this agent. Unlike `pinnedUserProviderHandle`, an
   * absent key and an explicit `null` are equivalent here - both read as
   * "never delivered" (a brand-new agent, or a record persisted before this
   * field existed). Compared against the current registry's digest to
   * decide whether the next prompt pull owes a fresh snapshot. A third
   * value is possible: the host may stamp a reserved sentinel string that
   * can never equal a real content digest, meaning "a push was attempted
   * but not confirmed delivered" - the next pull must treat the cursor as
   * behind and deliver a fresh truth snapshot before stamping a clean
   * digest again. The sentinel's literal value is host-owned, not part of
   * this contract.
   */
  lastDeliveredRolesDigest: z.string().nullable().default(null),
});
export type Chat = z.infer<typeof chatSchema>;

/**
 * Frozen Epic 2.0 chat record. It preserves the complete persisted chat shape
 * that shipped before Reasonix while holding every harness-bearing leaf to the
 * pre-Reasonix enum/anchor union. Wire-specific shape freezes remain separate.
 */
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

// Wire-freeze copy with `messages`/`events` swapped for their pre-`inReplyTo`
// freezes, bound to `chat.subscribe@1.0–1.3` snapshot serverFrames so those
// lines match the shipped wire and strip `inReplyTo` for older peers.
// Hand-frozen (non-sender fields reuse the live sub-schemas); NOT derived from
// the live shape. See `agentSenderSchemaPreInReplyTo`.
export const chatSchemaPreInReplyTo = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Pre-Reasonix freeze: this released line must never observe a harness id
  // its installed client's strict enum cannot decode (see
  // `chatRunSettingsSchemaPreReasonix`).
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z.array(claudePendingWakeSchemaPreRetryDeadline).default(
    [],
  ),
  messages: z.array(messageSchemaPreInReplyTo),
  events: z.array(chatEventSchemaPreInReplyTo).default([]),
});

// Wire-freeze copy without `archivedAt`, bound to `chat.subscribe@1.4`'s
// snapshot serverFrame so that released line stays verbatim - archiving rides
// a `1.5` minor instead (see `archivedAt` above and `chatSnapshotSchemaV14`).
// Hand-frozen (every other field reuses the live sub-schemas); NOT derived
// from the live shape.
export const chatSchemaV14 = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Pre-Reasonix freeze: this released line must never observe a harness id
  // its installed client's strict enum cannot decode (see
  // `chatRunSettingsSchemaPreReasonix`).
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z.array(claudePendingWakeSchemaPreRetryDeadline).default(
    [],
  ),
  // Pre-image freeze (see `messageSchemaPreImage`): this released line must
  // never observe `imageResults`/the image resolution record, which the live
  // `messageSchema` would otherwise silently gain.
  messages: z.array(messageSchemaPreImage),
  events: z.array(chatEventSchemaPreReasonix).default([]),
});

// Wire-freeze copy with `archivedAt` (the field `1.5` shipped) but without
// `pinnedUserProviderHandle` / `lastDeliveredRolesDigest`, bound to
// `chat.subscribe@1.5`'s snapshot serverFrame so that released line stays
// verbatim. Hand-frozen (every other field reuses the live sub-schemas); NOT
// derived from the live shape - see `chatSchemaV14`'s comment for why a
// released line must not follow `chatSchema` by reference.
export const chatSchemaV15 = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Pre-Reasonix freeze: this released line must never observe a harness id
  // its installed client's strict enum cannot decode (see
  // `chatRunSettingsSchemaPreReasonix`).
  settings: chatRunSettingsSchemaPreReasonix.nullable().default(null),
  activeSessionChain: activeSessionChainSchemaPreReasonix
    .nullable()
    .default(null),
  claudePendingWakes: z.array(claudePendingWakeSchemaPreRetryDeadline).default(
    [],
  ),
  // Pre-image freeze (see `messageSchemaPreImage`): this released line must
  // never observe `imageResults`/the image resolution record, which the live
  // `messageSchema` would otherwise silently gain.
  messages: z.array(messageSchemaPreImage),
  events: z.array(chatEventSchemaPreReasonix).default([]),
  archivedAt: z.number().nullable().default(null),
});

// Wire-freeze copy of the chat tree as `chat.subscribe@1.6` shipped it in
// `host-v1.2.0-rc.1`: every field the live `chatSchema` carried at that tag -
// including `pinnedUserProviderHandle` and `lastDeliveredRolesDigest`, both of
// which predate the RC - with `messages` pinned to
// `messageSchemaPreSettlement` so the RC cohort never observes canonical
// interview settlement or answer selection evidence.
//
// Hand-frozen field-for-field; NOT derived from `chatSchema`. `1.6` bound the
// LIVE chat schema by reference until this freeze, which is exactly the
// hazard `chatSchemaV14`'s comment describes - every later addition to
// `chatSchema` would otherwise leak onto a line that has shipped peers.
export const chatSchemaV16 = z.object({
  parentId: z.string().nullable(),
  id: z.string(),
  userId: z.string(),
  hostId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  isTitleEditedByUser: z.boolean(),
  // Every harness-bearing leaf additionally takes its pre-Reasonix freeze:
  // `1.6` is released with a nineteen-id enum, so the settings tuple, the
  // session chain, a parked wake's held chain, the message tree and the event
  // actors must all stay on ids that cohort can decode.
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
