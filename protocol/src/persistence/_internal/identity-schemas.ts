import {
  identityDocumentEntrySchema,
  identityRecordSchema,
  identitySkillReservationSchema,
} from "@traycer/protocol/persistence/identity/schemas";

/**
 * Private Zod values for the `identity`, `identity-document` and
 * `identity-skill-reservation` records.
 *
 * Both live in an identity's ROOT Tiptap room: `identity` is the whole of
 * `doc.getMap("identity")`, and `identity-document` is ONE VALUE of
 * `doc.getMap("documents")` - the map itself is not a record, because its keys
 * are file paths and its leniency is per entry (a key a reader cannot parse is
 * dropped, never the map). `identity-skill-reservation` is one value of
 * `doc.getMap("skillReservations")`, on the same per-entry rule.
 *
 * Registered as two records rather than one nested shape for that reason: a
 * single `identity-index` record would make one malformed document entry fail
 * the identity's settings too, which is the opposite of what the index doc's
 * readers need.
 *
 * Only the persistence registry imports this module; every other consumer
 * reaches the schemas through
 * `getRecordSchema(persistenceRecordRegistry, "identity" | "identity-document"
 * | "identity-skill-reservation")`.
 */
export const identityRecordValueSchema = identityRecordSchema;
export const identityDocumentRecordSchema = identityDocumentEntrySchema;
export const identitySkillReservationRecordSchema =
  identitySkillReservationSchema;
