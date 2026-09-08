/**
 * `artifact.subscribe@1.0` - the DOC lane: one artifact body, bidirectionally
 * synced.
 *
 * The third lane retiring `epic.subscribe`, and the only one that carries
 * binary payloads. It is opened per OPEN TILE and closed with it, exactly as
 * `chat.subscribe` is opened per open chat - which is the entire behavioural
 * change from the monolith, whose defining cost was fanning out every artifact
 * room in the epic at connect whether or not a human was looking at any of
 * them.
 *
 * Artifact bodies are the one genuinely CRDT-shaped thing in an epic: humans
 * co-edit them, so Yjs earns its cost here and nowhere else. Every other class -
 * the artifact index, chat records, role claims, comment threads - is
 * server-arbitrated rows and rides `epic.state.subscribe` as typed text.
 *
 * ## Attach IS the open request
 *
 * `@2` needed `attachArtifact` / `detachArtifact` CLIENT frames because one
 * subscription multiplexed every artifact in the epic. A per-artifact lane has
 * no such need: opening the stream attaches, closing it detaches, and the two
 * frames disappear along with the state machine that had to reconcile them
 * against a connection lifetime they did not control.
 *
 * ## Every attach names its generations - both of them
 *
 * Two independent identities are checked at open, and conflating them is how
 * histories get spliced:
 *
 * - `authorityEpoch` - the EPIC's replica identity, the same value
 *   `epic.state.subscribe` stamps. Required and non-null: a tile can only
 *   render a body for an artifact it learned about from the records lane, so
 *   the epoch is always in hand, and making it optional would only create a
 *   path where the check is silently skipped. An attach naming an epoch the
 *   host is not serving is refused with a terminal
 *   `unavailable / staleAuthorityEpoch`; the client re-reads the records lane
 *   and reattaches.
 * - `docGuid` - the BODY's identity, inside the seed offer below. An artifact
 *   deleted and recreated keeps neither, and a delta computed against the
 *   wrong one would union two logically different documents.
 *
 * The failure modes are deliberately different because the remedies are: a
 * stale epoch means the client's whole epic view is void, while a stale doc
 * guid means only this body must be re-seeded - which the host does silently,
 * by answering with a full `doc` frame instead of a delta.
 *
 * ## No windowing, deliberately
 *
 * Plain doc sync, with no range/window vocabulary. Artifact bodies are orders
 * of magnitude smaller than chat transcripts - the plane windowing was built
 * for - so a window here would be machinery with nothing to bound. Revisit on
 * telemetry showing outlier bodies, not on symmetry with `chat.subscribe`.
 *
 * ## Awareness lives here, and root awareness is gone
 *
 * Collaboration carets bind the ARTIFACT doc's `Awareness`, which this lane
 * carries. The monolith's root-document awareness never left the store and had
 * no consumer, so it is dropped rather than ported - the one frame kind from
 * `@1` that no lane inherits.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  epicLaneAuthorityEpochSchema,
  epicLaneEpochFrameFields,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";

/**
 * The state a reattaching client already holds for THIS body, so the host can
 * answer with a Yjs delta instead of re-shipping the document.
 *
 * The two fields travel as ONE object rather than as sibling request keys, on
 * the `epicSubscribeClientSeedOfferSchema` precedent, because neither is
 * meaningful alone and the loose form's failure is silent. A state vector
 * WITHOUT its document identity is the exact hazard `epic.subscribe@1.2`'s
 * `roomId` was introduced for: the host would diff it against whichever
 * document it holds now, which may be a recreated artifact's fresh doc, and the
 * resulting "delta" would union two histories. Nesting makes "both or neither"
 * structural, so there is no cross-field runtime check for a later reader to
 * overlook.
 *
 * `.optional()` and never `.default()`: a defaulted offer would materialize a
 * key the caller never wrote, splitting a client's subscription cache between
 * the params it passed and the params that were parsed for what is logically
 * one attach.
 */
export const artifactSubscribeSeedOfferSchema = z.object({
  /**
   * The `docGuid` this client's replica was seeded from - taken off the `doc`
   * frame that seeded it, never derived from `artifactId`. A body that was
   * deleted and recreated has a NEW guid under the same artifact id, so the
   * artifact id cannot answer "is my replica the same document as yours".
   */
  knownDocGuid: z.string().min(1),
  /**
   * Base64 `Y.encodeStateVector` of the replica the client still holds. The
   * host answers `Y.encodeStateAsUpdate(doc, thisVector)` - everything it has
   * that the client does not.
   */
  stateVectorBase64: z.string().min(1),
});
export type ArtifactSubscribeSeedOffer = z.infer<
  typeof artifactSubscribeSeedOfferSchema
>;

export const artifactSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string().min(1),
  artifactId: z.string().min(1),
  /**
   * The epic replica generation this attach is made under - `epicGeneration` in
   * the governing invariant, spelled `authorityEpoch` here because it is the
   * same value the records lane stamps and two names for one epoch is exactly
   * the drift these lanes exist to avoid.
   */
  authorityEpoch: epicLaneAuthorityEpochSchema,
  seedOffer: artifactSubscribeSeedOfferSchema.optional(),
});
export type ArtifactSubscribeOpenRequestV10 = z.infer<
  typeof artifactSubscribeOpenRequestSchemaV10
>;

/**
 * WHY a body is not being served.
 *
 * CLOSED enum, and closed for the reason `chatRecordRemovalReasonSchema` is: a
 * client handed only a free-text reason would have to STRING-MATCH to decide
 * between "reattach after re-reading the records lane" and "render a body
 * unavailable affordance", and those are different products of the same frame.
 * A reason this version cannot represent leaves a client unable to render the
 * end state at all, so widening is a NEW MINOR, never a silent addition. The
 * human-readable `reason` alongside it is for logs, never for branching.
 *
 * - `staleAuthorityEpoch` - the attach named an epoch this host is not serving.
 *   Always terminal. The client's whole epic view is void: re-read
 *   `epic.state.subscribe`, then reattach under the epoch it reports.
 * - `artifactNotFound` - no such artifact under this epic at this epoch, or it
 *   is tombstoned. Terminal; the records lane is authoritative about why.
 * - `bodyUnavailable` - the artifact exists and the host cannot currently
 *   materialize its body. NOT necessarily terminal - see `terminal`.
 */
export const artifactSubscribeUnavailableCodeSchema = z.enum([
  "staleAuthorityEpoch",
  "artifactNotFound",
  "bodyUnavailable",
]);
export type ArtifactSubscribeUnavailableCode = z.infer<
  typeof artifactSubscribeUnavailableCodeSchema
>;

/**
 * Every server frame repeats `artifactId`, which one subscription makes
 * redundant by construction.
 *
 * Kept anyway, and the redundancy is the point: these frames cross a shared
 * multiplexed connection alongside every other open tile's lane, so a frame
 * that named no artifact would be unreadable in a log, a replay capture, or a
 * crash dump - the three places this contract is most likely to be debugged
 * from. INVARIANT: it always equals the open request's `artifactId`; a frame
 * where it does not is a host bug, not a routing instruction.
 */
const artifactSubscribeAddressFields = {
  artifactId: z.string().min(1),
} as const;

export const artifactSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    /**
     * The body seed. Binary payload is either a full
     * `Y.encodeStateAsUpdate` over the host's doc, or a DELTA against the
     * client's offer - `seededFromOffer` is the only thing that distinguishes
     * them, and it is load-bearing.
     */
    z.object({
      kind: z.literal("doc"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      /**
       * The identity of the document these bytes belong to. A client whose
       * offer named a DIFFERENT guid must discard its replica and install this
       * one wholesale - that is the reseed, and it is how a deleted-and-
       * recreated artifact can never splice histories.
       */
      docGuid: z.string().min(1),
      /**
       * Base64 `Y.encodeStateVector` of the host's doc AFTER the bytes carried
       * here. The client's coverage watermark for this body: compare it against
       * the local replica to decide whether the body is converged or still owes
       * the host an update.
       */
      stateVectorBase64: z.string(),
      /**
       * Present ONLY when the payload is a delta against the offer this client
       * sent - i.e. the bytes are NOT self-sufficient and MUST be merged into
       * the very replica that produced the offer.
       *
       * Absence means a full seed, and every non-delta case is deliberately
       * indistinguishable: a cold attach, an offer whose `knownDocGuid` did not
       * match, an unparseable state vector, and any host-side fallback all look
       * identical. A full seed is always safe to install, so collapsing them
       * removes every branch where a client could mistake one for the other.
       *
       * `z.literal(true)` rather than `z.boolean()`, on the
       * `seededFromOffer` precedent: the fact is two-state, so this leaves
       * exactly ONE representation of "full seed" (absence) instead of two, and
       * no consumer can branch on `=== false` where it meant `!== true`.
       *
       * LOAD-BEARING, not cosmetic. Both forms apply through `Y.applyUpdate`,
       * so this does not select an apply function - it FORBIDS the client's
       * swap-in-a-fresh-doc path, which would drop every byte a delta
       * legitimately omitted.
       */
      seededFromOffer: z.literal(true).optional(),
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * An incremental update to the body identified by `docGuid`. A client that
     * holds a different guid must DROP these rather than apply them: they
     * describe a document it does not have.
     */
    z.object({
      kind: z.literal("docUpdate"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      docGuid: z.string().min(1),
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * Coverage acknowledgement for updates the CLIENT pushed: the host's state
     * vector after applying them.
     *
     * Text-only and separate from `docUpdate` because it carries no bytes -
     * it answers "how much of what I sent have you got", which is what lets a
     * client retire its unsynced watermark without waiting for its own edit to
     * echo back through the room.
     */
    z.object({
      kind: z.literal("docAck"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      docGuid: z.string().min(1),
      coverageStateVectorBase64: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    /**
     * Awareness (carets, selections, presence) for this body.
     *
     * EPHEMERA: fire-and-forget, never cursored, and loss is correct behaviour
     * rather than a gap to fill. It carries no `docGuid` because a caret is not
     * document state - replaying one after a reseed would place a cursor from a
     * document that no longer exists.
     */
    z.object({
      kind: z.literal("awareness"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * The body is not being served. `code` says what a client should DO;
     * `reason` is a short host-side summary for logs and must never be parsed
     * or rendered as product copy.
     */
    z.object({
      kind: z.literal("unavailable"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      code: artifactSubscribeUnavailableCodeSchema,
      reason: z.string(),
      /**
       * Whether this lane is finished. `true` means no later frame will arrive
       * on this subscription and the client must close and (if it still wants
       * the body) reattach; `false` means the host is retrying and the tile
       * should show a transient unavailable state without tearing down.
       *
       * Kept as its own boolean rather than derived from `code` because
       * `bodyUnavailable` is genuinely both - a room that is retrying and a
       * room that has given up - and folding them would force the host to pick
       * a lie for one of the two.
       */
      terminal: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type ArtifactSubscribeServerFrameV10 = z.infer<
  typeof artifactSubscribeServerFrameSchemaV10
>;

export const artifactSubscribeClientFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    /**
     * A local edit, pushed to the host. `docGuid` is the generation guard on
     * the WRITE path: a host that has reseeded the body since this client last
     * heard from it must DROP an update naming the old guid rather than merge
     * it, or a client's stale replica would resurrect content the reseed
     * deliberately replaced.
     */
    z.object({
      kind: z.literal("applyUpdate"),
      ...artifactSubscribeAddressFields,
      docGuid: z.string().min(1),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("awareness"),
      ...artifactSubscribeAddressFields,
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("ping"),
      ...epicLaneTextFrameFields,
    }),
  ],
);
export type ArtifactSubscribeClientFrameV10 = z.infer<
  typeof artifactSubscribeClientFrameSchemaV10
>;

export const artifactSubscribeV10 = defineStreamRpcContract({
  method: "artifact.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: artifactSubscribeOpenRequestSchemaV10,
  serverFrameSchema: artifactSubscribeServerFrameSchemaV10,
  clientFrameSchema: artifactSubscribeClientFrameSchemaV10,
});
