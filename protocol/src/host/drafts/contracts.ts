import { defineRpcContract } from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  draftsClaimRequestSchema,
  draftsClaimResponseSchema,
  draftsDeleteRequestSchema,
  draftsDeleteResponseSchema,
  draftsListRequestSchema,
  draftsListResponseSchema,
  draftsSubscribeClientFrameSchemaV10,
  draftsSubscribeOpenRequestSchemaV10,
  draftsSubscribeServerFrameSchemaV10,
  draftsUpsertRequestSchema,
  draftsUpsertResponseSchema,
} from "./schemas";

/**
 * Live draft store surface. Brand-new v1.0 methods, none on
 * `RELEASED_FLOOR_METHOD_NAMES`, all registered with
 * `degrade: { kind: "unsupported" }`.
 *
 * A host that predates them answers `E_HOST_UNSUPPORTED` and the client
 * keeps today's device-local drafts. This is the unreleased first minor
 * of the drafts family — freely editable until a release pins it.
 */

export const draftsUpsertV10 = defineRpcContract({
  method: "drafts.upsert",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsUpsertRequestSchema,
  responseSchema: draftsUpsertResponseSchema,
});

export const draftsDeleteV10 = defineRpcContract({
  method: "drafts.delete",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsDeleteRequestSchema,
  responseSchema: draftsDeleteResponseSchema,
});

/**
 * Snapshot of the host draft store. `snapshotSeq` is captured under the
 * same serialized frontier as the live rows AND `tombstones` (see
 * `draftsListResponseSchema`). Tombstones are how a reconnecting client
 * learns deletes it missed while disconnected; absence from `drafts`
 * is not a delete.
 */
export const draftsListV10 = defineRpcContract({
  method: "drafts.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsListRequestSchema,
  responseSchema: draftsListResponseSchema,
});

export const draftsClaimV10 = defineRpcContract({
  method: "drafts.claim",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsClaimRequestSchema,
  responseSchema: draftsClaimResponseSchema,
});

/**
 * Host-scoped draft change stream. Post-v1.0.0 stream method, so it is
 * implicitly optional: a host that predates it never advertises it and
 * the client's subscription degrades to `onMethodSupport(...,
 * "unsupported")`. The contract for that arm is device-local drafts
 * (same as the unary degrade). Never add this name to the unary
 * released floor.
 *
 * Frames carry `storeSeq`. Host MUST persist that sequence and keep it
 * strictly monotonic across restarts; there is no epoch on this wire.
 */
export const draftsSubscribeV10 = defineStreamRpcContract({
  method: "drafts.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: draftsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: draftsSubscribeServerFrameSchemaV10,
  clientFrameSchema: draftsSubscribeClientFrameSchemaV10,
});
