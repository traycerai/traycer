import { snapshotChatRunSettingsSchema } from "@traycer/protocol/persistence/chat-sync/open-harness";
import {
  storageProjection,
  withResidualCapture,
} from "@traycer/protocol/persistence/chat-sync/residual";
import { z } from "zod";

/**
 * Presentation core of a `chat-head`: everything a cloud renderer or a clone target interprets about the chat ITSELF, as opposed to its transcript.
 * The partner section is `host-private.ts`, which the protocol never interprets.
 */

// ---- Lifecycle --------------------------------------------------------- //

/**
 * Where the chat sits in its lifecycle at capture time.
 * `deleted` heads exist so a deletion is publishable as state rather than as the absence of a record - a reader that only ever sees "the row vanished" cannot distinguish a deletion from a fetch failure.
 */
export const chatLifecycleStateSchema = z.enum([
  "active",
  "archived",
  "deleted",
]);
export type ChatLifecycleState = z.infer<typeof chatLifecycleStateSchema>;

export const chatLifecycleShape = {
  state: chatLifecycleStateSchema,
  /** Wall-clock ms the chat was archived, or `null` while unarchived. */
  archivedAt: z.number().nullable(),
  /** Wall-clock ms the chat was deleted, or `null` while live. */
  deletedAt: z.number().nullable(),
} as const;

export const chatLifecycleSchema = withResidualCapture(
  "core.lifecycle",
  chatLifecycleShape,
);
export type ChatLifecycle = z.infer<typeof chatLifecycleSchema>;

// ---- Run settings ------------------------------------------------------ //

/** Run settings with residual capture. */
export const chatSyncRunSettingsSchema = withResidualCapture(
  "core.settings",
  snapshotChatRunSettingsSchema.shape,
);
export type ChatSyncRunSettings = z.infer<typeof chatSyncRunSettingsSchema>;

// ---- Core -------------------------------------------------------------- //

export const chatHeadCoreShape = {
  chatId: z.string().min(1),
  /** Parent chat in the chat tree, or `null` for a root chat. */
  parentChatId: z.string().nullable(),
  ownerUserId: z.string().min(1),
  /** Host that owned the chat when the head was published. */
  originHostId: z.string().min(1),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lifecycle: chatLifecycleSchema,
  /** Run settings the chat was last configured with; `null` before first run. */
  settings: chatSyncRunSettingsSchema.nullable(),
} as const;

export const chatHeadCoreSchema = withResidualCapture(
  "core",
  chatHeadCoreShape,
);
export type ChatHeadCore = z.infer<typeof chatHeadCoreSchema>;

// ---- Wire projections -------------------------------------------------- //

// The PERSISTED shapes, derived from the same maps with nested captured levels substituted.
// A capturing schema cannot describe the wire itself - see `storageProjection` for why - so the frozen storage surface comes from here.

export const chatLifecycleStorageSchema = storageProjection(chatLifecycleShape);

export const chatSyncRunSettingsStorageSchema = storageProjection(
  snapshotChatRunSettingsSchema.shape,
);

export const chatHeadCoreStorageSchema = storageProjection({
  ...chatHeadCoreShape,
  lifecycle: chatLifecycleStorageSchema,
  settings: chatSyncRunSettingsStorageSchema.nullable(),
});
