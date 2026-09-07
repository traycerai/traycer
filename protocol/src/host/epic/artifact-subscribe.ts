/**
 * `artifact.subscribe@1.0` - the DOC lane: one artifact body, bidirectionally synced.
 * The monolith's root-document awareness never left the store and had no consumer, so it is dropped rather than ported - the one frame kind from `@1` that no lane inherits.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  epicLaneAuthorityEpochSchema,
  epicLaneEpochFrameFields,
  epicLaneTextFrameFields,
} from "@traycer/protocol/host/epic/lane-cursor";

/**
 * `epic.subscribe@1.2` - The state a reattaching client already holds for THIS body, so the host can answer with a Yjs delta instead of re-shipping the document.
 * `.optional()` and never `.default()`: a defaulted offer would materialize a key the caller never wrote, splitting a client's subscription cache between the params it passed and the params that were parsed for what is.
 */
export const artifactSubscribeSeedOfferSchema = z.object({
  /**
   * The `docGuid` this client's replica was seeded from - taken off the `doc` frame that seeded it, never derived from `artifactId`.
   * A body that was deleted and recreated has a NEW guid under the same artifact id, so the artifact id cannot answer "is my replica the same document as yours".
   */
  knownDocGuid: z.string().min(1),
  /** Base64 `Y.encodeStateVector` of the replica the client still holds. */
  stateVectorBase64: z.string().min(1),
});
export type ArtifactSubscribeSeedOffer = z.infer<
  typeof artifactSubscribeSeedOfferSchema
>;

export const artifactSubscribeOpenRequestSchemaV10 = z.object({
  epicId: z.string().min(1),
  artifactId: z.string().min(1),
  authorityEpoch: epicLaneAuthorityEpochSchema,
  seedOffer: artifactSubscribeSeedOfferSchema.optional(),
});
export type ArtifactSubscribeOpenRequestV10 = z.infer<
  typeof artifactSubscribeOpenRequestSchemaV10
>;

/**
 * WHY a body is not being served.
 * The human-readable `reason` alongside it is for logs, never for branching.
 */
export const artifactSubscribeUnavailableCodeSchema = z.enum([
  "staleAuthorityEpoch",
  "artifactNotFound",
  "bodyUnavailable",
]);
export type ArtifactSubscribeUnavailableCode = z.infer<
  typeof artifactSubscribeUnavailableCodeSchema
>;

/** Every server frame repeats `artifactId`, which one subscription makes redundant by construction. */
const artifactSubscribeAddressFields = {
  artifactId: z.string().min(1),
} as const;

export const artifactSubscribeServerFrameSchemaV10 = z.discriminatedUnion(
  "kind",
  [
    /** The body seed. */
    z.object({
      kind: z.literal("doc"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      /**
       * The identity of the document these bytes belong to.
       * A client whose offer named a DIFFERENT guid must discard its replica and install this one wholesale - that is the reseed, and it is how a deleted-and- recreated artifact can never splice histories.
       */
      docGuid: z.string().min(1),
      /** Base64 `Y.encodeStateVector` of the host's doc AFTER the bytes carried here. */
      stateVectorBase64: z.string(),
      /**
       * Present ONLY when the payload is a delta against the offer this client sent - i.e. the bytes are NOT self-sufficient and MUST be merged into the very replica that produced the offer.
       */
      seededFromOffer: z.literal(true).optional(),
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * An incremental update to the body identified by `docGuid`.
     * A client that holds a different guid must DROP these rather than apply them: they describe a document it does not have.
     */
    z.object({
      kind: z.literal("docUpdate"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      docGuid: z.string().min(1),
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * Coverage acknowledgement for updates the CLIENT pushed: the host's state vector after applying them.
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
     * EPHEMERA: fire-and-forget, never cursored, and loss is correct behaviour rather than a gap to fill.
     */
    z.object({
      kind: z.literal("awareness"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      hasBinaryPayload: z.literal(true),
    }),
    /**
     * The body is not being served.
     * `code` says what a client should DO; `reason` is a short host-side summary for logs and must never be parsed or rendered as product copy.
     */
    z.object({
      kind: z.literal("unavailable"),
      ...epicLaneEpochFrameFields,
      ...artifactSubscribeAddressFields,
      code: artifactSubscribeUnavailableCodeSchema,
      reason: z.string(),
      /** Whether this lane is finished. */
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
    /** A local edit, pushed to the host. */
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
