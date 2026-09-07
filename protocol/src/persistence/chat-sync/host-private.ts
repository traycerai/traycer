import { jsonObjectSchema } from "@traycer/protocol/persistence/chat-sync/json";
import {
  storageProjection,
  withResidualCapture,
} from "@traycer/protocol/persistence/chat-sync/residual";
import { z } from "zod";

/**
 * Opaque host-private section of a published chat.
 * Credentials, tokens, or anything security-sensitive must never enter `data`.
 */
export const chatSyncHostPrivateShape = {
  /** Host-owned schema revision of `data`. Never interpreted by the protocol. */
  revision: z.number().int().nonnegative(),
  /** Opaque, validated-JSON host state. Preserved verbatim by every reader. */
  data: jsonObjectSchema,
} as const;

// The envelope itself captures residuals too: `data` is already opaque, but a future minor could add a sibling of `revision`, and an older reader must not drop it on re-publication (see `residual.ts`).
export const chatSyncHostPrivateSchema = withResidualCapture(
  "hostPrivate",
  chatSyncHostPrivateShape,
);
export type ChatSyncHostPrivate = z.infer<typeof chatSyncHostPrivateSchema>;

/** The persisted shape - declared fields, no `residual`. */
export const chatSyncHostPrivateStorageSchema = storageProjection(
  chatSyncHostPrivateShape,
);

/** Empty host-private section, for readers/tests constructing a bare head. */
export const EMPTY_CHAT_SYNC_HOST_PRIVATE: ChatSyncHostPrivate = {
  revision: 0,
  data: {},
  residual: {},
};
