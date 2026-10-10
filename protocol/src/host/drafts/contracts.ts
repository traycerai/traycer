import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  draftsDeleteRequestSchema,
  draftsDeleteResponseSchema,
  draftsListRequestSchema,
  draftsListResponseSchema,
  draftsListResponseSchemaV10,
  draftDocumentSchemaV10,
  draftsPutBlobRequestSchema,
  draftsPutBlobRequestSchemaV11,
  draftsPutBlobResponseSchema,
  draftsReadBlobRequestSchema,
  draftsReadBlobResponseSchema,
  draftsReadBlobResponseSchemaV11,
  draftsRetractRequestSchema,
  draftsRetractResponseSchema,
  draftsSubscribeClientFrameSchemaV10,
  draftsSubscribeOpenRequestSchemaV10,
  draftsSubscribeServerFrameSchemaV10,
  draftsSubscribeServerFrameSchemaV11,
  draftsUpsertRequestSchema,
  draftsUpsertResponseSchema,
  draftsUpsertResponseSchemaV10,
} from "./schemas";

/**
 * Live draft store surface. Brand-new v1.0 methods, none on
 * `RELEASED_FLOOR_METHOD_NAMES`, all registered with
 * `degrade: { kind: "unsupported" }`.
 *
 * A host that predates them answers `E_HOST_UNSUPPORTED` and the client
 * keeps today's device-local drafts.
 *
 * The 1.5.0 tags shipped this family, so its first lines are RELEASED and
 * pinned. A line that carries a draft document (`upsert`, `list`, the
 * subscribe stream) is frozen at the document those tags shipped, and a newer
 * line carries the live one.
 */

export const draftsUpsertV10 = defineRpcContract({
  method: "drafts.upsert",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsUpsertRequestSchema,
  // Frozen at the document the 1.5.0 tags shipped. The REQUEST stays live: it
  // is a client→host slot.
  responseSchema: draftsUpsertResponseSchemaV10,
});

// The LIVE line: the echo carries the live document.
export const draftsUpsertV20 = defineRpcContract({
  method: "drafts.upsert",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: draftsUpsertRequestSchema,
  responseSchema: draftsUpsertResponseSchema,
});

export const draftsUpsertUpgradeV10ToV20 = defineUpgradePath<
  typeof draftsUpsertV10,
  typeof draftsUpsertV20
>({
  from: draftsUpsertV10.schemaVersion,
  to: draftsUpsertV20.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

export const draftsUpsertDowngradeV20ToV10 = defineDowngradePath<
  typeof draftsUpsertV20,
  typeof draftsUpsertV10
>({
  from: draftsUpsertV20.schemaVersion,
  to: draftsUpsertV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => {
    // The response echoes the one document the caller just wrote, so there is
    // nothing to filter: pass through or refuse. A 1.0 caller writes only what
    // its own schema can spell, so the echo of its own write always fits.
    const parsed = draftsUpsertResponseSchemaV10.safeParse(response);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "DOWNGRADE_UNSUPPORTED",
          message: "This draft requires a newer Traycer client.",
        },
      };
    }
    return { ok: true, value: parsed.data };
  },
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
  // Frozen at the document the 1.5.0 tags shipped.
  responseSchema: draftsListResponseSchemaV10,
});

// The LIVE line: rows carry the live document.
export const draftsListV20 = defineRpcContract({
  method: "drafts.list",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: draftsListRequestSchema,
  responseSchema: draftsListResponseSchema,
});

export const draftsListUpgradeV10ToV20 = defineUpgradePath<
  typeof draftsListV10,
  typeof draftsListV20
>({
  from: draftsListV10.schemaVersion,
  to: draftsListV20.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/**
 * Omits each live row the 1.0 document cannot represent; everything else is
 * untouched, `tombstones` and `snapshotSeq` included.
 *
 * Omission is the honest arm here because of what this listing already means
 * to its reader: "absence from `drafts` is not a delete". A 1.0 client that is
 * not shown a row neither deletes it nor writes over it - it has no id to
 * address it by. The alternatives both rewrite the user's draft: clearing
 * `runSettings` hands the client a draft it would save back with the choice
 * gone, and refusing the whole listing takes every other draft away with it.
 *
 * The frontier holds. `snapshotSeq` still bounds every mutation the response
 * reflects; a withheld row is simply one this subscriber is also never sent an
 * `upsert` for (`drafts.subscribe@1.0`), so nothing later contradicts it.
 */
export const draftsListDowngradeV20ToV10 = defineDowngradePath<
  typeof draftsListV20,
  typeof draftsListV10
>({
  from: draftsListV20.schemaVersion,
  to: draftsListV10.schemaVersion,
  downgradeRequest: (request) => ({ ok: true, value: request }),
  downgradeResponse: (response) => ({
    ok: true,
    value: {
      ...response,
      drafts: response.drafts.flatMap((draft) => {
        const parsed = draftDocumentSchemaV10.safeParse(draft);
        return parsed.success ? [parsed.data] : [];
      }),
    },
  }),
});

/**
 * Retract the cloud row of a draft this host holds no row for (a foreign
 * draft deleted from History). Ownership never moves between hosts; this
 * is the only cross-host mutation a drafts client makes, and it is a
 * delete on the user's own authority. `{ retracted: false }` when the row
 * was already gone.
 */
export const draftsRetractV10 = defineRpcContract({
  method: "drafts.retract",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsRetractRequestSchema,
  responseSchema: draftsRetractResponseSchema,
});

/**
 * Host-wide draft image write. Idempotent, digest-verified before store.
 * Optional (`degrade: unsupported`); a host that predates it leaves
 * images on the device-local partition.
 */
export const draftsPutBlobV10 = defineRpcContract({
  method: "drafts.putBlob",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsPutBlobRequestSchema,
  responseSchema: draftsPutBlobResponseSchema,
});

/**
 * `@1.1` declares the wire ceiling for one blob
 * (`DRAFT_BLOB_MAX_BASE64_LENGTH`) on its own request instance. The response is
 * unchanged and shared by reference.
 *
 * NARROWING, so it takes a minor rather than an edit: the `@1.0` request is
 * pinned above and stays byte-identical, and a peer that negotiates `@1.0`
 * keeps sending and accepting exactly what it does today. The cap therefore
 * takes effect only where BOTH sides are `>= 1.1`, and the real enforcement
 * stays the host store's version-independent decoded cap - see the schema's
 * own note.
 */
export const draftsPutBlobV11 = defineRpcContract({
  method: "drafts.putBlob",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: draftsPutBlobRequestSchemaV11,
  responseSchema: draftsPutBlobResponseSchema,
});

/**
 * Identity in both directions: the two lines carry the same KEYS, and `@1.1`
 * differs only by a length bound on one of them.
 *
 * The upgrade deliberately does not re-check that bound. Upgrading is how a
 * `@1.0` caller's request reaches the canonical resolver, and this path never
 * re-parses (`upgradeRequestToVersion` applies pure functions), so an over-cap
 * `@1.0` body arrives exactly as it does today and is refused by the host
 * store's own decoded cap. Enforcing the wire cap here instead would convert a
 * released client's oversized put from a store-level refusal it understands
 * into a protocol-layer failure it has never seen.
 */
export const draftsPutBlobUpgradeV10ToV11 = defineUpgradePath<
  typeof draftsPutBlobV10,
  typeof draftsPutBlobV11
>({
  from: draftsPutBlobV10.schemaVersion,
  to: draftsPutBlobV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/**
 * Host-wide draft image read. The second-device / non-author path.
 * Missing and corrupt answer `{ ok: false, reason: "missing" }`.
 */
export const draftsReadBlobV10 = defineRpcContract({
  method: "drafts.readBlob",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: draftsReadBlobRequestSchema,
  responseSchema: draftsReadBlobResponseSchema,
});

/**
 * `@1.1` carries the same ceiling on the way OUT. The request has no body to
 * cap - it is a digest - so this line shares `draftsReadBlobRequestSchema` and
 * takes its own response instance; `@1.0`'s stays pinned above and uncapped.
 */
export const draftsReadBlobV11 = defineRpcContract({
  method: "drafts.readBlob",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: draftsReadBlobRequestSchema,
  responseSchema: draftsReadBlobResponseSchemaV11,
});

/** Identity both ways - same arms, same keys, one length bound added. */
export const draftsReadBlobUpgradeV10ToV11 = defineUpgradePath<
  typeof draftsReadBlobV10,
  typeof draftsReadBlobV11
>({
  from: draftsReadBlobV10.schemaVersion,
  to: draftsReadBlobV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => response,
});

/**
 * Host-scoped draft change stream. Post-v1.0.0 stream method, so it is
 * implicitly optional: a host that predates it never advertises it and
 * the client's subscription degrades to `onMethodSupport(...,
 * "unsupported")`. The contract for that arm is device-local drafts
 * (same as the unary degrade). Never add this name to the unary
 * released floor.
 *
 * Upsert/delete frames carry `storeSeq`. Host MUST persist that
 * sequence and keep it strictly monotonic across restarts; there is
 * no epoch on this wire. `scope` is advisory (resolved personal-scope
 * id) and does not carry `storeSeq`.
 */
export const draftsSubscribeV10 = defineStreamRpcContract({
  method: "drafts.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: draftsSubscribeOpenRequestSchemaV10,
  // Frozen at the document the 1.5.0 tags shipped.
  serverFrameSchema: draftsSubscribeServerFrameSchemaV10,
  clientFrameSchema: draftsSubscribeClientFrameSchemaV10,
});

/**
 * `@1.1` is the first minor whose `upsert` frames may carry a draft naming a
 * harness added after 1.5.0 (Command Code is the first). Nothing else changes:
 * the capability signal is the negotiated minor, and the host withholds such
 * an `upsert` from a `@1.0` subscriber.
 */
export const draftsSubscribeV11 = defineStreamRpcContract({
  method: "drafts.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: draftsSubscribeOpenRequestSchemaV10,
  serverFrameSchema: draftsSubscribeServerFrameSchemaV11,
  clientFrameSchema: draftsSubscribeClientFrameSchemaV10,
});
