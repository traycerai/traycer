/**
 * Public sub-schemas, types and helpers of the `draft/v1` head dialect.
 *
 * The registered record schema lives in
 * `persistence/_internal/draft-schemas.ts` and is reachable only through
 * `getRecordSchema(persistenceRecordRegistry, "draft-head", "latest")`.
 * Everything re-exported here is a building block of that record, or the
 * document codec that wraps it with the tenant `parts` envelope.
 */
export * from "./version";
export * from "./schemas";
export * from "./document";
