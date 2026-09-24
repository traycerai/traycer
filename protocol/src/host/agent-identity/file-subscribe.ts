/**
 * `agentIdentity.file.subscribe@1.0` - the DOC lane: ONE identity file's body,
 * bidirectionally synced.
 *
 * `artifact.subscribe`'s shape with `path` in place of `artifactId`, and that is
 * a deliberate near-copy rather than a shared generic. The two lanes carry the
 * same class of thing - a `Y.XmlFragment` a human co-edits - so every frame,
 * every refusal code and every invariant transfers; what does NOT transfer is
 * the address, and an address is exactly the part of a contract that must not be
 * generic. A body lane keyed on an opaque "document id" would let a caller
 * address an artifact through the identity family, or an identity file through
 * the epic family, with the authorization subject decided by whichever resolver
 * happened to pick the subscription up.
 *
 * The consequence to keep in mind when reading both: a fix to one lane's
 * behaviour is not a fix to the other's. They are versioned separately and
 * forever.
 *
 * ## Markdown only
 *
 * Only paths in the `documents` map have a fragment. A blob has bytes, not a
 * CRDT, and it reaches a client through the plane's signed read URL; asking this
 * lane for one is refused with `notAFragment` rather than served as an empty
 * document, which is what an unmodelled miss would look like.
 *
 * ## Attach IS the open request
 *
 * Opening the stream attaches, closing it detaches. No attach/detach client
 * frames, and therefore no state machine reconciling them against a connection
 * lifetime they do not control.
 *
 * ## Every attach names both generations
 *
 * - `authorityEpoch` - the IDENTITY's replica identity, minted by
 *   `agentIdentity.state.subscribe`. Required and non-null: a client can only
 *   open a file it learned about from the index lane, so the epoch is always in
 *   hand, and making it optional would only create a path where the check is
 *   silently skipped.
 * - `docGuid`, inside the seed offer - the BODY's identity. A file deleted and
 *   recreated at the same path, or renamed away and back, keeps the epoch (that
 *   names the identity's replica, not the file) but NEVER its guid: each new
 *   life of a path - each fresh `incarnation` on the index lane - gets a body
 *   with a fresh guid, and a delta computed against the wrong one would union
 *   two logically different documents.
 *
 * The remedies differ, which is why the codes do: a stale epoch means the
 * client's whole view of the identity is void, while a stale doc guid means only
 * this body re-seeds - which the host does silently, by answering with a full
 * `doc` frame instead of a delta.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  epicLaneAuthorityEpochSchema,
  epicLaneEpochFrameFields,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";
import {
  agentIdentityIdSchema,
  agentIdentityPathSchema,
} from "@traycer/protocol/host/agent-identity/schemas";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The state a reattaching client already holds for THIS body, so the host can
 * answer with a Yjs delta instead of re-shipping the document.
 *
 * The two fields travel as ONE object because neither is meaningful alone and
 * the loose form's failure is SILENT: a state vector without its document
 * identity would be diffed against whichever document the host holds now, and
 * the resulting "delta" would union two histories. Nesting makes "both or
 * neither" structural, so there is no cross-field runtime check for a later
 * reader to overlook.
 *
 * `.optional()` and never `.default()`: a defaulted offer would materialize a
 * key the caller never wrote, splitting a client's subscription cache between
 * the params it passed and the params that were parsed for one attach.
 */
export const agentIdentityFileSeedOfferSchema = lazySchema(() =>
  z.object({
    /**
     * Taken off the `doc` frame that seeded the replica, NEVER derived from the
     * path: a file deleted and recreated has a new guid under the same path, so
     * the path cannot answer "is my replica the same document as yours".
     */
    knownDocGuid: z.string().min(1),
    /** Base64 `Y.encodeStateVector` of the replica the client still holds. */
    stateVectorBase64: z.string().min(1),
  }),
);
export type AgentIdentityFileSeedOffer = z.infer<
  typeof agentIdentityFileSeedOfferSchema
>;

export const agentIdentityFileSubscribeOpenRequestSchemaV10 = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    path: agentIdentityPathSchema,
    /** Minted by `agentIdentity.state.subscribe`; there is nowhere else to get one. */
    authorityEpoch: epicLaneAuthorityEpochSchema,
    seedOffer: agentIdentityFileSeedOfferSchema.optional(),
  }),
);
export type AgentIdentityFileSubscribeOpenRequestV10 = z.infer<
  typeof agentIdentityFileSubscribeOpenRequestSchemaV10
>;

/**
 * WHY a body is not being served.
 *
 * CLOSED. A client handed only a free-text reason would have to STRING-MATCH to
 * decide between "re-read the index lane and reattach", "render a
 * file-unavailable affordance" and "this path has no body at all", and those are
 * three different products of one frame. Widening is a NEW MINOR.
 *
 * - `staleAuthorityEpoch` - the attach named an epoch this host is not serving.
 *   Always terminal; the client's whole view of the identity is void.
 * - `fileNotFound` - no such path under this identity at this epoch, or it is
 *   deleted. Terminal; the index lane is authoritative about why.
 * - `notAFragment` - the path exists and is a BLOB. Terminal, and distinct from
 *   `fileNotFound` because the client's next move is different: fetch the bytes
 *   through the plane rather than report a missing file.
 * - `bodyUnavailable` - the file exists, is markdown, and the host cannot
 *   currently materialize its body - typically its shard room is down. NOT
 *   necessarily terminal; see `terminal`.
 */
export const agentIdentityFileSubscribeUnavailableCodeSchema = lazySchema(() =>
  z.enum([
    "staleAuthorityEpoch",
    "fileNotFound",
    "notAFragment",
    "bodyUnavailable",
  ]),
);
export type AgentIdentityFileSubscribeUnavailableCode = z.infer<
  typeof agentIdentityFileSubscribeUnavailableCodeSchema
>;

/**
 * Every server frame repeats `path`, which one subscription makes redundant by
 * construction. Kept anyway, and the redundancy is the point: these frames cross
 * a shared multiplexed connection alongside every other open file's lane, so a
 * frame that named no path would be unreadable in a log, a replay capture or a
 * crash dump - the three places this contract is most likely to be debugged
 * from. INVARIANT: it always equals the open request's `path`; a frame where it
 * does not is a host bug, not a routing instruction.
 */
const agentIdentityFileAddressFields = {
  path: agentIdentityPathSchema,
} as const;

export const agentIdentityFileSubscribeServerFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /**
     * The body seed: either a full `Y.encodeStateAsUpdate`, or a DELTA against
     * the client's offer. `seededFromOffer` is the only thing that tells them
     * apart, and it is load-bearing.
     */
    z.object({
      kind: z.literal("doc"),
      ...epicLaneEpochFrameFields,
      ...agentIdentityFileAddressFields,
      /**
       * The identity of the document these bytes belong to. A client whose offer
       * named a DIFFERENT guid must discard its replica and install this one
       * wholesale - that is the reseed, and it is how a deleted-and-recreated
       * path can never splice histories.
       */
      docGuid: z.string().min(1),
      /** Base64 state vector of the host's doc AFTER the bytes carried here. */
      stateVectorBase64: z.string(),
      /**
       * Present ONLY when the payload is a delta against this client's offer -
       * the bytes are NOT self-sufficient and MUST be merged into the very
       * replica that produced the offer.
       *
       * Absence means a full seed, and every non-delta case is deliberately
       * indistinguishable: a cold attach, a guid that did not match, an
       * unparseable state vector, any host-side fallback. A full seed is always
       * safe to install, so collapsing them removes every branch where a client
       * could mistake one for the other.
       *
       * `z.literal(true)` rather than `z.boolean()`, so "full seed" has exactly
       * ONE representation (absence) and no consumer can branch on `=== false`
       * where it meant `!== true`. It FORBIDS the client's swap-in-a-fresh-doc
       * path; it does not select an apply function.
       */
      seededFromOffer: z.literal(true).optional(),
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * An incremental update to the body identified by `docGuid`. A client
     * holding a different guid must DROP these rather than apply them: they
     * describe a document it does not have.
     */
    z.object({
      kind: z.literal("docUpdate"),
      ...epicLaneEpochFrameFields,
      ...agentIdentityFileAddressFields,
      docGuid: z.string().min(1),
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * Coverage acknowledgement for updates the CLIENT pushed. Text-only and
     * separate from `docUpdate` because it carries no bytes - it answers "how
     * much of what I sent have you got", which is what lets a client retire its
     * unsynced watermark without waiting for its own edit to echo back.
     */
    z.object({
      kind: z.literal("docAck"),
      ...epicLaneEpochFrameFields,
      ...agentIdentityFileAddressFields,
      docGuid: z.string().min(1),
      coverageStateVectorBase64: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    /**
     * Awareness (carets, selections, presence).
     *
     * EPHEMERA: fire-and-forget, never cursored, and loss is correct behaviour
     * rather than a gap to fill. It carries no `docGuid` because a caret is not
     * document state - replaying one after a reseed would place a cursor from a
     * document that no longer exists.
     */
    z.object({
      kind: z.literal("awareness"),
      ...epicLaneEpochFrameFields,
      ...agentIdentityFileAddressFields,
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * The body is not being served. `code` says what a client should DO;
     * `reason` is a short host-side summary for logs and must never be parsed or
     * rendered as product copy.
     */
    z.object({
      kind: z.literal("unavailable"),
      ...epicLaneEpochFrameFields,
      ...agentIdentityFileAddressFields,
      code: agentIdentityFileSubscribeUnavailableCodeSchema,
      reason: z.string(),
      /**
       * Whether this lane is finished. Its own boolean rather than derived from
       * `code`, because `bodyUnavailable` is genuinely both - a shard that is
       * retrying and one that has given up - and folding them would force the
       * host to pick a lie for one of the two.
       */
      terminal: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      ...epicLaneTextFrameFields,
    }),
  ]),
);
export type AgentIdentityFileSubscribeServerFrameV10 = z.infer<
  typeof agentIdentityFileSubscribeServerFrameSchemaV10
>;

export const agentIdentityFileSubscribeClientFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /**
     * A local edit, pushed to the host. `docGuid` is the generation guard on the
     * WRITE path: a host that has reseeded the body since this client last heard
     * from it must DROP an update naming the old guid rather than merge it, or a
     * stale replica would resurrect content the reseed deliberately replaced.
     */
    z.object({
      kind: z.literal("applyUpdate"),
      ...agentIdentityFileAddressFields,
      docGuid: z.string().min(1),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("awareness"),
      ...agentIdentityFileAddressFields,
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("ping"),
      ...epicLaneTextFrameFields,
    }),
  ]),
);
export type AgentIdentityFileSubscribeClientFrameV10 = z.infer<
  typeof agentIdentityFileSubscribeClientFrameSchemaV10
>;

export const agentIdentityFileSubscribeV10 = defineStreamRpcContract({
  method: "agentIdentity.file.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: agentIdentityFileSubscribeOpenRequestSchemaV10,
  serverFrameSchema: agentIdentityFileSubscribeServerFrameSchemaV10,
  clientFrameSchema: agentIdentityFileSubscribeClientFrameSchemaV10,
});
