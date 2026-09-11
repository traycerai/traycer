import { draftHeadSchema } from "@traycer/protocol/persistence/draft/schemas";

/**
 * Private Zod value for the `draft-head` record.
 *
 * A published draft is a small mutable head on the personal `drafts` scope
 * row (chat id = `draftId`, tenant `draft`). Unlike `chat-head` it names no
 * shards: images are chat-blobs and the dialect document is inline. The
 * stored document still carries the required tenant `parts` envelope
 * (always empty on `draft/v1`) so the sync layer can compute deletions.
 *
 * Only the persistence registry imports this module; every other consumer
 * reaches the schema through
 * `getRecordSchema(persistenceRecordRegistry, "draft-head", "latest")`.
 */
export const draftHeadRecordSchema = draftHeadSchema;
