/**
 * The two unary reads that complete the epic lane surface:
 * `epic.getWorkspaceContext@1.0` and `epic.retryMigration@1.0`.
 *
 * Both replace something the monolith could only express as a FRAME on a
 * long-lived subscription, and both are unary for the same reason: neither is a
 * subscription-shaped fact. One is a one-shot read the client re-issues on
 * named events; the other is a command that needs an answer.
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { earlyMetaEpicSchema } from "@traycer/protocol/host/epic/snapshot-meta";

/**
 * `epic.getWorkspaceContext@1.0` - the workspace context a tab needs before any
 * lane can answer.
 *
 * ## What it is
 *
 * Exactly today's `earlyMeta` payload: repos, workspaces, repo mapping,
 * resolved workspace folders, unresolved repos, `epicLight`, and the caller's
 * permission role. The host already computes all of it from
 * `resolveWorkspaceContext` BEFORE the cloud room opens - typically ~200 ms
 * against ~8-11 s for a cold room sync - which is why the monolith emitted it
 * as a fast-path frame ahead of its own snapshot.
 *
 * ## Why it stops being a frame
 *
 * On the monolith it had to be a frame, because the only channel to the host
 * was the subscription and the payload had to overtake that subscription's own
 * snapshot. With the lanes it is what it always was: a read. Making it a unary
 * means the workspace-derived UI - git status, file tree, sidebar repo chip,
 * permission display - no longer waits on a stream to open, and the state lane
 * no longer has to carry a second, differently-shaped metadata frame whose only
 * job was to arrive early.
 *
 * ## The refresh contract - the part that is easy to lose
 *
 * The monolith's `earlyMeta` was RE-EMITTED, not one-shot: the host resent it
 * on reconnect and whenever a migration or permission signal changed what it
 * said. A naive unary port silently drops that, and the symptom is a stale repo
 * chip and a stale permission gate that nothing ever corrects.
 *
 * So the caller's obligation is explicit and part of this contract: fetch at
 * tab open, and REFETCH on reconnect and on every `epic.status.subscribe`
 * migration or permission frame. The control lane is what tells a client its
 * workspace context may have moved; this read is how it finds out what to.
 *
 * ## Optional, with a degrade story
 *
 * A new method name, so it is registered `degrade: { kind: "unsupported" }` and
 * never added to `RELEASED_FLOOR_METHOD_NAMES` (fail-closed on the name set - a
 * new floor name is handshake-fatal against every released peer). A host that
 * predates it answers `E_HOST_UNSUPPORTED`, and such a host is by definition
 * one that still serves `epic.subscribe@1`, whose `earlyMeta` frame is the
 * client's source for exactly this payload. The degrade is the legacy adapter
 * that is already there, not a blank surface.
 */
export const getWorkspaceContextRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type GetWorkspaceContextRequest = z.infer<
  typeof getWorkspaceContextRequestSchema
>;

/**
 * The context, wrapped rather than spread across the response's top level.
 *
 * The wrapper is not ceremony: `earlyMetaEpicSchema` is SHARED with the frozen
 * `earlyMeta` frame on `epic.subscribe@1.0`-`@1.3`, so growing it grows four
 * released lines at once. Keeping it as one named field means the day this read
 * needs a field the monolith never carried, `@1.1` adds a SIBLING key here and
 * leaves the shared shape alone - the `chatRunSettingsSchemaV10` discipline,
 * applied before rather than after the incident.
 */
export const getWorkspaceContextResponseSchema = z.object({
  context: earlyMetaEpicSchema,
});
export type GetWorkspaceContextResponse = z.infer<
  typeof getWorkspaceContextResponseSchema
>;

export const epicGetWorkspaceContextV10 = defineRpcContract({
  method: "epic.getWorkspaceContext",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: getWorkspaceContextRequestSchema,
  responseSchema: getWorkspaceContextResponseSchema,
});

/**
 * `epic.retryMigration@1.0` - re-run a major migration that failed.
 *
 * ## Why it stops being a client frame
 *
 * The monolith carried `retryMigration` as a CLIENT FRAME on `epic.subscribe`,
 * which gave the modal's Retry button no answer at all: the frame was
 * fire-and-forget, so "the host refused" and "the host never received it" were
 * the same observation, and the only feedback loop was waiting to see whether
 * migration frames resumed. A retry is a COMMAND. It gets a reply.
 *
 * The host side is unchanged in substance: it releases the current epic lease
 * for replacement and re-runs `openEpic`, which is retry-safe (server prepare
 * skips duplicates, room transformation is idempotent). Progress continues to
 * arrive on `epic.status.subscribe` - this call starts the work, it does not
 * report it.
 *
 * ## The caller keeps its control lane across the retry
 *
 * `epic.status.subscribe` does NOT close when a migration fails - the lane
 * stays open holding `migration: {state: "failed"}` as a stable snapshot
 * condition - and the retry reuses that same live session. So a client calls
 * this WITHOUT re-subscribing, and the resulting progress arrives on the
 * subscription it already had.
 *
 * That is a load-bearing property rather than a convenience: a caller that tore
 * down its control lane on `migrationFailed` and rebuilt it around this call
 * would be racing the host's own release-for-replacement, and the Retry button
 * would be wired to a channel that no longer exists. The epic REPLICA is
 * replaced by a retry (expect an `authorityEpoch` change and fresh lane
 * snapshots); the SUBSCRIPTION is not.
 *
 * ## `ok: true` and nothing else
 *
 * `{ ok: literal(true) }`, the shape every epic mutation in this package
 * returns. The response says the host ACCEPTED and started the retry; it makes
 * no claim about the outcome, which arrives as `migrationProgress` /
 * `migrationFailed` on the control lane. Encoding a result here would invent a
 * synchronous answer for an asynchronous process - and a client that waited for
 * it would hang for the length of a migration.
 *
 * A refusal is an RPC ERROR, not an `ok: false`: the two refusals that exist -
 * the caller lacks write access, and there is no failed migration to retry -
 * are already expressible as typed errors, and a boolean would collapse them
 * into one indistinguishable "no".
 *
 * ## Optional, with a degrade story
 *
 * `degrade: { kind: "unsupported" }`, off the released floor, same as the read
 * above. A host that predates it is a host still serving `epic.subscribe@1`,
 * where the retry frame it does understand still exists - so the legacy adapter
 * covers the gap, and a client must not surface a dead Retry button.
 */
export const retryMigrationRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type RetryMigrationRequest = z.infer<typeof retryMigrationRequestSchema>;

export const retryMigrationResponseSchema = z.object({ ok: z.literal(true) });
export type RetryMigrationResponse = z.infer<
  typeof retryMigrationResponseSchema
>;

export const epicRetryMigrationV10 = defineRpcContract({
  method: "epic.retryMigration",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: retryMigrationRequestSchema,
  responseSchema: retryMigrationResponseSchema,
});
