import { jsonObjectSchema } from "@traycer/protocol/persistence/chat-sync/json";
import {
  storageProjection,
  withResidualCapture,
} from "@traycer/protocol/persistence/chat-sync/residual";
import { z } from "zod";

/**
 * Opaque host-private section of a published chat.
 *
 * Everything the owning host needs to resume a chat but no cloud renderer or
 * clone target interprets: the active session chain, pending wakes, and
 * whatever the next harness integration needs. Deliberately UNTYPED at the
 * protocol layer.
 *
 * Why opaque rather than modeled: this state changes at host speed - every
 * new harness, every resume-semantics fix - while the presentation core
 * changes at reader speed. Modeling it here would force a record minor (and
 * a fixture regeneration, and a reader-compatibility argument) for changes no
 * reader can even observe. Keeping it as a validated-JSON bag means the host
 * evolves it freely and every reader still round-trips it losslessly.
 *
 * `revision` is host-owned and monotonic within a major; the protocol only
 * carries it. A host reading a publication whose `revision` exceeds what it
 * understands should treat `data` as opaque-and-preserve rather than guess.
 *
 * ONE-WAY DOOR: a field may be promoted out of `data` into the presentation
 * core (a record minor bump - see COMPATIBILITY.md), never demoted back into
 * it. Once shipped readers interpret a field, removing it from the core is a
 * major change no matter where the bytes end up.
 *
 * The SAME schema instance backs the head's inline section and the graduated
 * `host-private` shard - which is why the section can move between them
 * without a re-parse, and why there is exactly one `hostPrivate` captured
 * level rather than one per record.
 */
export const chatSyncHostPrivateShape = {
  /** Host-owned schema revision of `data`. Never interpreted by the protocol. */
  revision: z.number().int().nonnegative(),
  /** Opaque, validated-JSON host state. Preserved verbatim by every reader. */
  data: jsonObjectSchema,
} as const;

// The envelope itself captures residuals too: `data` is already opaque, but a
// future minor could add a sibling of `revision`, and an older reader must not
// drop it on re-publication (see `residual.ts`).
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
