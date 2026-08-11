/**
 * Public sub-schemas, types and helpers of the `chat-head` / `chat-shard`
 * publication contract.
 *
 * The registered record schemas live in
 * `persistence/_internal/chat-sync-schemas.ts` and are reachable only through
 * `getRecordSchema(persistenceRecordRegistry, "chat-head" | "chat-shard",
 * "latest")`. Everything re-exported here is a building block of those records,
 * or a reader-side helper over them, not a record itself - so it stays public.
 *
 * See `persistence/COMPATIBILITY.md` ("Chat-sync contract") for the evolution
 * rules: passthrough vocabulary, the core / host-private partition, the
 * graduation rule, and the coupled bump ritual.
 */

export * from "./json";
export * from "./version";
export * from "./residual";
export * from "./passthrough";
export * from "./open-harness";
export * from "./entries";
export * from "./core";
export * from "./host-private";
export * from "./shard";
export * from "./head";
export * from "./assembly";
export * from "./presentation";
export * from "./captured-levels";
