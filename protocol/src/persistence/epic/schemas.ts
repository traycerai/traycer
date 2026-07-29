/**
 * Public sub-schemas and inferred types of the V200 epic record.
 *
 * The top-level `epicSchema` (the registered `epic` record) lives in
 * `protocol/persistence/_internal/epic-schemas.ts` and is reachable
 * only through `getRecordSchema(persistenceRecordRegistry, "epic", "latest")`.
 * Everything re-exported here is a building block of that record, not a
 * record itself, so it stays public.
 *
 * This file is now a barrel - the per-concern shapes live in sibling
 * files (`foundation`, `content-blocks`, `senders`, `messages`,
 * `chat-events`, `chat`, `artifacts`, `tui-agents`). Splitting kept the
 * 591-line monolith from growing unbounded; importing through this barrel
 * preserves every existing consumer path.
 *
 * yjs-backed fields in the on-disk shape are modeled as their
 * materialized plain-JSON equivalents:
 *
 * - `Y.XmlFragment` (spec/ticket/review body text) → `jsonContentSchema`
 * - `Y.Array` chat messages → `z.array(messageSchema)`
 * - `Y.Array` chat events → `z.array(chatEventSchema)` when initialized
 *
 * That materialization is what actually crosses boundaries (wire,
 * backup, migration input) so it is also what the framework should diff
 * across future versions.
 */

export * from "./foundation";
export * from "./content-blocks";
export * from "./senders";
export * from "./messages";
export * from "./chat-events";
export * from "./chat";
export * from "./artifacts";
export * from "./tui-agents";
export * from "./role-claims";
