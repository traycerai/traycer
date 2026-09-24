/**
 * Public sub-schemas and types of the agent-identity index doc.
 *
 * The REGISTERED record schemas live in
 * `persistence/_internal/identity-schemas.ts` and are reachable only through
 * `getRecordSchema(persistenceRecordRegistry, "identity", "latest")` and
 * `…, "identity-document", "latest")`. Everything re-exported here is a
 * building block of those records.
 */
export * from "./schemas";
