import { z } from "zod";

/**
 * Host <-> client wire shapes for reading a PUBLISHED chat out of the cloud.
 *
 * ## The host is a byte pipe, and that is the whole design
 *
 * A client has no route to traycer-server: it holds no CloudData base URL and
 * no service token, and it never has. The local host holds both, so every cloud
 * read hops through it. What changed in v2 is what the host is allowed to DO on
 * that hop: nothing.
 *
 * | Step | v1 | v2 |
 * | --- | --- | --- |
 * | resolve the head | host parsed the ref and gated on it | host passes the head string through, unread |
 * | fetch the parts | host fetched, folded, verified | host streams ONE part per call, by digest |
 * | verify digests | host | CLIENT, against the head it parsed |
 * | assemble | host | CLIENT |
 * | cache | none | CLIENT, content-addressed by part digest |
 *
 * Two properties fall out of that, and both are the point:
 *
 * 1. **Verification is where the interpretation is.** The client parses the
 *    head, so the client is the only party that knows what the parts are
 *    supposed to hash to. A host that verified would be verifying against
 *    numbers it read out of a document it is not allowed to understand.
 * 2. **The reader's cache is content-addressed and therefore incremental.**
 *    Parts are immutable and named by digest, so a returning reader asks only
 *    for the digests it lacks - after one new turn, that is the tail shard and
 *    the head. v1 refetched the whole publication after every compaction; there
 *    is no compaction here and no whole-publication refetch either.
 *
 * The reading host is whatever host the DEVICE runs, which is generally NOT the
 * chat's owning host. That is what makes the owner-offline path work: my laptop
 * being asleep does not stop my phone's host from piping me the bytes, because
 * they come from the cloud and the token comes from me.
 *
 * ## All of these are optional capabilities
 *
 * Every method here is registered `degrade: { kind: "unsupported" }` and none is
 * on the released floor - a new method NAME is handshake-fatal against a
 * released peer. A host that predates this surface answers `E_HOST_UNSUPPORTED`
 * for these calls and nothing else, and the client's contract is to hide the
 * cloud-chat surface rather than render a failure: the honest reading of "this
 * host cannot reach cloud chats" is an absent section, not a broken tab.
 */

// ---- Identity ---------------------------------------------------------- //

/**
 * Full identity of one cloud chat.
 *
 * `chatId` is NOT globally unique - it is host-minted, and two hosts can mint
 * the same id under one task - so identity is the TRIPLE. Every request, cache
 * key and list key here carries all three.
 *
 * `ownerUserId` is an EXPECTATION, never a selector. The server's read APIs take
 * `(taskId, chatId)` and pick a row by viewer precedence, which can land on a
 * different row than the one the caller was looking at; the host compares what
 * came back against this and refuses rather than answering from the wrong chat.
 * Every read below therefore has an `ambiguous-identity` arm, and it is a
 * SUCCESS value: rendering the other row would show one person's chat under
 * another person's list entry, which is a privacy bug wearing a UI costume.
 */
export const cloudChatIdentitySchema = z.object({
  taskId: z.string().min(1),
  chatId: z.string().min(1),
  ownerUserId: z.string().min(1),
});
export type CloudChatIdentity = z.infer<typeof cloudChatIdentitySchema>;

export const cloudChatVisibilitySchema = z.enum(["private", "task"]);
export type CloudChatVisibility = z.infer<typeof cloudChatVisibilitySchema>;

/** Lowercase hex sha256 - the only form a content address is written in. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

// ---- List -------------------------------------------------------------- //

/**
 * A chat as the CLOUD ROW knows it, and nothing more.
 *
 * ## What is deliberately missing, and why its absence is correct
 *
 * v1's summary carried a `readability` verdict per row, computed host-side, so
 * the list could render "needs a newer app" before you clicked. That verdict is
 * unavailable in v2 and cannot be recovered: it was derived from a record
 * version the server stamped on the row, and the v2 row holds an OPAQUE head
 * whose version lives inside the document. Computing readability would mean the
 * host parsing the head - the one thing this surface exists to stop.
 *
 * So a v2 row says only whether the chat has ever been published, and a version
 * refusal is discovered on open. That is a real regression in list-time
 * affordance, taken knowingly: it costs one refusal rendered a click later than
 * it used to be, and it buys a server and a host that can never again need
 * redeploying for a chat-format change.
 *
 * Object coordinates stay absent for the reason they always did: a client
 * addresses bytes by content digest through an authorized identity triple, and
 * a key is not something it should ever hold.
 */
export const cloudChatSummarySchema = z.object({
  identity: cloudChatIdentitySchema,
  ownerHostId: z.string().min(1),
  createdAt: z.number(),
  visibility: cloudChatVisibilitySchema,
  title: z.string().nullable(),
  isTitleEditedByUser: z.boolean(),
  parentChatId: z.string().nullable(),
  isArchived: z.boolean(),
  runSettingsSummary: z.string().nullable(),
  metadataUpdatedAt: z.number(),
  /**
   * Digest of the current head document's exact bytes, or `null` before the
   * owning host publishes a first head.
   *
   * Doubles as the client's integrity check on the resolve that follows: the
   * head arrives as a string, and this is what those bytes must hash to.
   */
  headSha256: sha256HexSchema.nullable(),
  /** Null until the owning host publishes a first head. */
  publishedAt: z.number().nullable(),
  /**
   * Sequence the published head was pinned at; null when unpublished.
   *
   * A listing and staleness projection, host-asserted. No authority decision
   * reads it - two forked histories both number their turns, so ordering by seq
   * permits exactly the overwrite the head digest exists to refuse.
   */
  throughRecordSeq: z.number().int().nonnegative().nullable(),
  /** True when the signed-in user owns this chat (their private rows list too). */
  isOwnedByViewer: z.boolean(),
});
export type CloudChatSummary = z.infer<typeof cloudChatSummarySchema>;

export const listCloudChatsRequestSchema = z.object({
  taskId: z.string().min(1),
});
export type ListCloudChatsRequest = z.infer<typeof listCloudChatsRequestSchema>;

/**
 * Every `task`-visible chat in the task plus the viewer's OWN private rows.
 *
 * ACL-filtered per caller, so two viewers on one installation have different
 * correct answers and anything caching this must key on the viewer as well as
 * the task.
 */
export const listCloudChatsResponseSchema = z.object({
  chats: z.array(cloudChatSummarySchema),
});
export type ListCloudChatsResponse = z.infer<
  typeof listCloudChatsResponseSchema
>;

// ---- Resolve the head -------------------------------------------------- //

export const resolveCloudChatHeadRequestSchema = cloudChatIdentitySchema;
export type ResolveCloudChatHeadRequest = z.infer<
  typeof resolveCloudChatHeadRequestSchema
>;

/**
 * Outcomes of resolving one chat's head.
 *
 * Note which refusal is NOT here: there is no `needs-newer-app`. The version
 * gate moved to the client along with the parsing, and that is not a relocation
 * of convenience - the head names its own minimum reader version INSIDE the
 * document, so only a party that reads the document can apply it. The client
 * gates after this call and before any part call, which preserves the property
 * v1's server-side gate bought: a reader that cannot interpret a publication
 * spends no part egress on it.
 */
export const resolveCloudChatHeadOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("ok"),
      /**
       * The head document, verbatim, byte for byte as the publisher committed it.
       *
       * A STRING, not an object, and that is load-bearing twice over: the digest
       * below is over these exact bytes, and any normalizing round trip through a
       * JSON object would silently break the check. The host does not parse it.
       */
      head: z.string().min(1),
      /** Digest of `head`'s bytes, from the row. The client re-computes and checks. */
      headSha256: sha256HexSchema,
    }),
    /** The owning host has never published this chat. Not an error. */
    z.object({ status: z.literal("unpublished") }),
    /**
     * The cloud holds NO ROW for this identity at all - not even metadata.
     * Distinct from `unpublished` (row exists, head absent) because there is
     * no summary to return alongside it: `chat` is null exactly and only in
     * this arm. Doc-era chats that predate v2 publication land here, and so
     * does any identity the caller guessed. Deliberately identical for
     * "absent" and "not readable" - the server's own RBAC rule (a chat you
     * may not see is NOT FOUND, never forbidden) carries through unchanged.
     */
    z.object({ status: z.literal("missing") }),
    /** `(task, chat)` resolved to a row owned by someone else - see the identity note. */
    z.object({
      status: z.literal("ambiguous-identity"),
      resolvedOwnerUserId: z.string().min(1),
    }),
  ],
);
export type ResolveCloudChatHeadOutcome = z.infer<
  typeof resolveCloudChatHeadOutcomeSchema
>;

export const resolveCloudChatHeadResponseSchema = z
  .object({
    /** Null exactly when `outcome.status === "missing"` - no row, no summary. */
    chat: cloudChatSummarySchema.nullable(),
    outcome: resolveCloudChatHeadOutcomeSchema,
  })
  // The doc line above is a validated invariant, not prose: a "missing"
  // outcome with a summary attached (or a resolved outcome without one)
  // is a malformed response either way, and every consumer branches on
  // `outcome.status` while reading `chat` - so the contract refuses the
  // combination rather than letting one consumer discover it at runtime.
  .superRefine((response, ctx) => {
    const chatMustBeNull = response.outcome.status === "missing";
    if ((response.chat === null) !== chatMustBeNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chat"],
        message: chatMustBeNull
          ? 'A "missing" outcome carries no summary - `chat` must be null.'
          : "A resolved outcome must carry its summary - `chat` must not be null.",
      });
    }
  });
export type ResolveCloudChatHeadResponse = z.infer<
  typeof resolveCloudChatHeadResponseSchema
>;

// ---- Read one part ----------------------------------------------------- //

export const readCloudChatPartRequestSchema = z.object({
  ...cloudChatIdentitySchema.shape,
  /** The part's whole address. The client got it out of the head it parsed. */
  sha256: sha256HexSchema,
  /**
   * The length the HEAD promises for this part.
   *
   * Sent so the host can apply a staging ceiling without parsing the head - the
   * one number it needs to bound a transfer, handed to it rather than read out
   * of a document it must not interpret. It is NOT the authority on what the
   * bytes are: the client checks the delivered length and digest against its own
   * copy of the head, so a client that lied here only lies to itself.
   */
  declaredByteLength: z.number().int().nonnegative(),
});
export type ReadCloudChatPartRequest = z.infer<
  typeof readCloudChatPartRequestSchema
>;

/**
 * One part's bytes.
 *
 * ## Base64, not text
 *
 * A shard is canonical JSON today and would survive a `string` field, but this
 * is a BYTE channel and the payload kinds it will carry are not all text. A JS
 * string round trip is lossy for anything that is not valid UTF-8, and lossy in
 * the worst possible way here: the replacement characters would hash to
 * something else and surface as `digest-mismatch`, i.e. as a corrupt chat rather
 * than as a wire bug. The 4/3 expansion is the price of a channel that cannot
 * lie about what it moved, over a localhost socket, for a 64 KiB shard.
 *
 * ## `not-found` is data, not a throw
 *
 * A live head naming a part storage does not have is a real, diagnosable
 * condition (a premature sweep, an out-of-band deletion) and the reader's
 * response to it is a specific rendered state, not a retry. Collapsing it into a
 * transport error would make it indistinguishable from a dropped socket, which
 * IS retryable. Genuine transport failures still throw.
 */
export const readCloudChatPartOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** Base64 of the RAW part bytes - what `sha256` is over. */
    bytesBase64: z.string(),
    /** Length of the DECODED bytes, so a client can check what it decoded. */
    byteLength: z.number().int().nonnegative(),
  }),
  z.object({ status: z.literal("not-found") }),
  z.object({ status: z.literal("ambiguous-identity") }),
]);
export type ReadCloudChatPartOutcome = z.infer<
  typeof readCloudChatPartOutcomeSchema
>;

export const readCloudChatPartResponseSchema = z.object({
  outcome: readCloudChatPartOutcomeSchema,
});
export type ReadCloudChatPartResponse = z.infer<
  typeof readCloudChatPartResponseSchema
>;

// ---- Payloads (the heavy content a chat NAMES but does not carry) ------- //

/**
 * One piece of heavy content a published chat names by digest.
 *
 * A `file_change` block names its before/after file text this way, a `plan`
 * block names its full markdown the same way, and an image rides as a hash
 * inside a user message's content tree. None of it travels inside a shard.
 *
 * `kind` is an open string rather than an enum, and that is what lets a payload
 * kind be added without a major here: a newer host may serve a kind this client
 * never asks for, and a newer client asking an older host for one is answered
 * `unavailable`. An enum would make every new kind a breaking change to this
 * method.
 */
export const cloudChatPayloadRefSchema = z.object({
  kind: z.string().min(1),
  sha256: sha256HexSchema,
});
export type CloudChatPayloadRef = z.infer<typeof cloudChatPayloadRefSchema>;

export const listCloudChatPayloadsRequestSchema = cloudChatIdentitySchema;
export type ListCloudChatPayloadsRequest = z.infer<
  typeof listCloudChatPayloadsRequestSchema
>;

/**
 * Which of a chat's payloads this reader may fetch.
 *
 * ## Why it is a separate call
 *
 * `presentChat` decides `resolvable` vs `missing` through a SYNCHRONOUS port,
 * once per payload ref in the transcript, so the answer must be in hand BEFORE
 * presentation runs. A probe per ref during presentation is not available to it,
 * and one afterwards is too late to have counted. Folding the answer onto the
 * head resolve was the obvious alternative and is not legal: adding a key to an
 * existing unary response is breaking for an older client even when nullable.
 *
 * ## Why it is worth a round trip
 *
 * Without it a client can still fetch lazily and render a marker on refusal, but
 * `ChatFidelity.missingPayloads` would read zero forever and the transcript's
 * "N attachments are unavailable" line would quietly become a lie. The whole
 * fidelity rule is that the gap be stated EXPLICITLY rather than left looking
 * like a chat with no diffs; a summary that under-reports is the failure, not a
 * cosmetic loss.
 *
 * Not an existence oracle: it answers a `(task, chat)` the caller may already
 * READ, with the refs that chat's own rows hold - never "is this digest
 * anywhere".
 */
export const listCloudChatPayloadsOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("ok"),
      refs: z.array(cloudChatPayloadRefSchema),
    }),
    /**
     * An outcome union rather than a bare `refs` array precisely so this case
     * cannot be reported as an empty list, which a reader would render as "no
     * attachments" for a chat that has them.
     */
    z.object({ status: z.literal("ambiguous-identity") }),
    /**
     * The cloud holds no row for this identity (never published, or not
     * readable - the server does not distinguish). An answer, not a throw,
     * for the same reason as the head resolve's `missing` arm: the copy
     * surface must say "never published", not "could not reach the cloud".
     */
    z.object({ status: z.literal("not-found") }),
  ],
);
export type ListCloudChatPayloadsOutcome = z.infer<
  typeof listCloudChatPayloadsOutcomeSchema
>;

export const listCloudChatPayloadsResponseSchema = z.object({
  outcome: listCloudChatPayloadsOutcomeSchema,
});
export type ListCloudChatPayloadsResponse = z.infer<
  typeof listCloudChatPayloadsResponseSchema
>;

export const readCloudChatPayloadRequestSchema = z.object({
  ...cloudChatIdentitySchema.shape,
  ref: cloudChatPayloadRefSchema,
});
export type ReadCloudChatPayloadRequest = z.infer<
  typeof readCloudChatPayloadRequestSchema
>;

/**
 * `unavailable` is the ORDINARY answer here, not an error, and modelling it as
 * data is the point.
 *
 * Content that lives only on the originating device cannot be fetched from
 * anywhere else, and the gap must render EXPLICITLY rather than as a blank card
 * - which would read as "this chat has no diff". A payload that was never
 * published, whose bytes the origin host no longer holds, or whose kind this
 * host cannot serve all resolve to the same marker a reader already draws.
 *
 * A transport failure is NOT this. It throws, so a client retries rather than
 * caching a permanent "unavailable" for a payload one bad request away.
 */
export const readCloudChatPayloadOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("ok"),
      /** Base64 of the RAW payload bytes - what `ref.sha256` is over. */
      bytesBase64: z.string(),
      /** Length of the DECODED bytes, so a client can check what it decoded. */
      byteLength: z.number().int().nonnegative(),
    }),
    z.object({ status: z.literal("unavailable") }),
    /**
     * Carries no resolved owner, unlike the head resolve: the reader's action is
     * identical either way, and a value nobody acts on is a channel not worth
     * opening.
     */
    z.object({ status: z.literal("ambiguous-identity") }),
  ],
);
export type ReadCloudChatPayloadOutcome = z.infer<
  typeof readCloudChatPayloadOutcomeSchema
>;

export const readCloudChatPayloadResponseSchema = z.object({
  outcome: readCloudChatPayloadOutcomeSchema,
});
export type ReadCloudChatPayloadResponse = z.infer<
  typeof readCloudChatPayloadResponseSchema
>;

// ---- Visibility mutations ---------------------------------------------- //
//
// Same optional-capability channel as the five reads above. New method names,
// both `{major:1, minor:0}`, both `degrade: { kind: "unsupported" }`: a host
// that predates them answers `E_HOST_UNSUPPORTED` and the client hides Share /
// Mark-all-private rather than rendering a failure.
//
// Request keys follow the cloud-chat convention (`taskId`, not `epicId`). The
// host is a bearer pass-through; the server owns owner-binding and ACL.

/**
 * Flip one cloud chat's visibility (`private` | `task`).
 *
 * The response carries the updated row so a client can reconcile its list
 * cache without a second list hop.
 */
export const setCloudChatVisibilityRequestSchema = z.object({
  taskId: z.string().min(1),
  chatId: z.string().min(1),
  visibility: cloudChatVisibilitySchema,
});
export type SetCloudChatVisibilityRequest = z.infer<
  typeof setCloudChatVisibilityRequestSchema
>;

export const setCloudChatVisibilityResponseSchema = z.object({
  chat: cloudChatSummarySchema,
});
export type SetCloudChatVisibilityResponse = z.infer<
  typeof setCloudChatVisibilityResponseSchema
>;

/**
 * Set this caller's per-task default visibility, optionally applying it to
 * every chat they already own on the task.
 *
 * `applyToExisting: false` writes the preference only (new chats inherit it).
 * `applyToExisting: true` also bulk-updates existing owned rows. `updatedCount`
 * is the number of rows whose stored visibility actually changed.
 */
export const setChatSharingDefaultRequestSchema = z.object({
  taskId: z.string().min(1),
  defaultVisibility: cloudChatVisibilitySchema,
  applyToExisting: z.boolean(),
});
export type SetChatSharingDefaultRequest = z.infer<
  typeof setChatSharingDefaultRequestSchema
>;

export const setChatSharingDefaultResponseSchema = z.object({
  updatedCount: z.number().int().nonnegative(),
});
export type SetChatSharingDefaultResponse = z.infer<
  typeof setChatSharingDefaultResponseSchema
>;
