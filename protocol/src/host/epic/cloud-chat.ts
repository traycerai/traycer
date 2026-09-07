import { z } from "zod";

/**
 * Host <-> client wire shapes for reading a PUBLISHED chat out of the cloud.
 * A client has no route to traycer-server: it holds no CloudData base URL and no service token, and it never has.
 */

// ---- Identity ---------------------------------------------------------- //

/** Full identity of one cloud chat. */
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
 * That verdict is unavailable in v2 and cannot be recovered: it was derived from a record version the server stamped on the row, and the v2 row holds an OPAQUE head whose version lives inside the document.
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
   * Digest of the current head document's exact bytes, or `null` before the owning host publishes a first head.
   * Doubles as the client's integrity check on the resolve that follows: the head arrives as a string, and this is what those bytes must hash to.
   */
  headSha256: sha256HexSchema.nullable(),
  /** Null until the owning host publishes a first head. */
  publishedAt: z.number().nullable(),
  /** Sequence the published head was pinned at; null when unpublished. */
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
 * ACL-filtered per caller, so two viewers on one installation have different correct answers and anything caching this must key on the viewer as well as the task.
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
 * The client gates after this call and before any part call, which preserves the property v1's server-side gate bought: a reader that cannot interpret a publication spends no part egress on it.
 */
export const resolveCloudChatHeadOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("ok"),
      /**
       * The head document, verbatim, byte for byte as the publisher committed it.
       * A STRING, not an object, and that is load-bearing twice over: the digest below is over these exact bytes, and any normalizing round trip through a JSON object would silently break the check.
       */
      head: z.string().min(1),
      /** Digest of `head`'s bytes, from the row. The client re-computes and checks. */
      headSha256: sha256HexSchema,
    }),
    /** The owning host has never published this chat. Not an error. */
    z.object({ status: z.literal("unpublished") }),
    /** The cloud holds NO ROW for this identity at all - not even metadata. */
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
   * Sent so the host can apply a staging ceiling without parsing the head - the one number it needs to bound a transfer, handed to it rather than read out of a document it must not interpret.
   */
  declaredByteLength: z.number().int().nonnegative(),
});
export type ReadCloudChatPartRequest = z.infer<
  typeof readCloudChatPartRequestSchema
>;

/**
 * One part's bytes.
 * The 4/3 expansion is the price of a channel that cannot lie about what it moved, over a localhost socket, for a 64 KiB shard.
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

/** One piece of heavy content a published chat names by digest. */
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
 * Not an existence oracle: it answers a `(task, chat)` the caller may already READ, with the refs that chat's own rows hold - never "is this digest anywhere".
 */
export const listCloudChatPayloadsOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("ok"),
      refs: z.array(cloudChatPayloadRefSchema),
    }),
    /**
     * An outcome union rather than a bare `refs` array precisely so this case cannot be reported as an empty list, which a reader would render as "no attachments" for a chat that has them.
     */
    z.object({ status: z.literal("ambiguous-identity") }),
    /**
     * The cloud holds no row for this identity (never published, or not readable - the server does not distinguish).
     * An answer, not a throw, for the same reason as the head resolve's `missing` arm: the copy surface must say "never published", not "could not reach the cloud".
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
 * `unavailable` is the ORDINARY answer here, not an error, and modelling it as data is the point.
 * A payload that was never published, whose bytes the origin host no longer holds, or whose kind this host cannot serve all resolve to the same marker a reader already draws.
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
     * Carries no resolved owner, unlike the head resolve: the reader's action is identical either way, and a value nobody acts on is a channel not worth opening.
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

/** Flip one cloud chat's visibility (`private` | `task`). */
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
 * Set this caller's per-task default visibility, optionally applying it to every chat they already own on the task.
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
