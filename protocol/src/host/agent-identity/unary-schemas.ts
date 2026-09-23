/**
 * Request / response shapes for the unary half of `agentIdentity.*`.
 *
 * Grouped by the four jobs the family does: the identity's own lifecycle, the
 * index it owns, the history of one file, and the two importers that seed it.
 *
 * Allowed dependencies: `zod` and other protocol modules only - this file must
 * stay browser-safe.
 */
import { z } from "zod";
import {
  AGENT_IDENTITY_FILE_MAX_BYTES,
  identityFileSha256Schema,
} from "@traycer/protocol/host/agent-identity/files";
import {
  agentIdentityEvolutionSettingsSchema,
  agentIdentityIdSchema,
  agentIdentityPathSchema,
  agentIdentityRefusalFields,
  agentIdentitySummarySchema,
} from "@traycer/protocol/host/agent-identity/schemas";
import {
  artifactVersionObservationEntrySchema,
  artifactVersionProvenanceSchema,
  artifactVersionsRestoreResponseSchema,
} from "@traycer/protocol/host/epic/artifact-versions";
import {
  providerSkillInspectCandidateSchema,
  providersSkillsInspectResultSchema,
} from "@traycer/protocol/host/provider-native-schemas";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

// ─── Identity lifecycle ─────────────────────────────────────────────────────

/**
 * `agentIdentity.list@1.0` - the identities this caller may use.
 *
 * Takes no arguments and is scoped to the calling account by the host. There is
 * deliberately no filter, cursor or page: an account's identities are a handful
 * of rows the composer picker renders whole, and a paged picker would have to
 * decide what "the first page of identities" means before the user has typed
 * anything. Revisit on a real account with enough of them to hurt, not on
 * symmetry with `epic.listTasks`.
 */
export const agentIdentityListRequestSchema = lazySchema(() => z.object({}));
export type AgentIdentityListRequest = z.infer<
  typeof agentIdentityListRequestSchema
>;

export const agentIdentityListResponseSchema = lazySchema(() =>
  z.object({
    identities: z.array(agentIdentitySummarySchema),
  }),
);
export type AgentIdentityListResponse = z.infer<
  typeof agentIdentityListResponseSchema
>;

/**
 * `agentIdentity.create@1.0` - mint the cloud row and the root room.
 *
 * `title` only, plus an optional description. Everything else an identity holds
 * is seeded by the host (the stock skills copy, the empty soul and memory
 * files) or set afterwards through `update`, so a create that took the whole
 * tuple would be asking a caller to state defaults it has no opinion about.
 *
 * `clientRequestId` is what makes the call idempotent. Creating an identity
 * mints a durable cloud row, and a retried create after a dropped response must
 * not mint a second one - the host keys its `INSERT ... ON DUPLICATE KEY UPDATE`
 * on this id, so a retry returns the SAME identity rather than a twin. The
 * client generates it, exactly as it generates `clientActionId` on a send.
 */
export const agentIdentityCreateRequestSchema = lazySchema(() =>
  z.object({
    clientRequestId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable(),
  }),
);
export type AgentIdentityCreateRequest = z.infer<
  typeof agentIdentityCreateRequestSchema
>;

export const agentIdentityCreateResponseSchema = lazySchema(() =>
  z.object({
    identity: agentIdentitySummarySchema,
  }),
);
export type AgentIdentityCreateResponse = z.infer<
  typeof agentIdentityCreateResponseSchema
>;

/**
 * `agentIdentity.update@1.0` - title, description and evolution settings.
 *
 * A WHOLE-TUPLE replace, with every field required. The settings panel resolves
 * all of them before it writes one, and a partial patch would make "leave the
 * review model alone" and "clear the review model" the same request - the
 * null-clobber `chatRunSettingsStrictSchema` exists to prevent, in the identity
 * dimension. A narrow per-field method can be added later if a surface appears
 * that genuinely holds only one field; none does today.
 */
export const agentIdentityUpdateRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    title: z.string().min(1),
    description: z.string().nullable(),
    evolution: agentIdentityEvolutionSettingsSchema,
  }),
);
export type AgentIdentityUpdateRequest = z.infer<
  typeof agentIdentityUpdateRequestSchema
>;

export const agentIdentityUpdateResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("updated"),
      identity: agentIdentitySummarySchema,
    }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentityUpdateResponse = z.infer<
  typeof agentIdentityUpdateResponseSchema
>;

/**
 * `agentIdentity.delete@1.0` - soft-delete the row and tear the runtime down.
 *
 * Soft, because a chat that referenced the identity keeps its `identityId` and
 * has to be able to render "Removed" rather than a dangling id. The host stops
 * the runtime, drains the uploader and the mirror, then removes the directory -
 * the plane's own cascade order.
 *
 * Idempotent by construction: deleting an identity that is already gone answers
 * `deleted` rather than `identityNotFound`, so a retried delete after a dropped
 * response is not an error the user has to read.
 */
export const agentIdentityDeleteRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
  }),
);
export type AgentIdentityDeleteRequest = z.infer<
  typeof agentIdentityDeleteRequestSchema
>;

export const agentIdentityDeleteResponseSchema = lazySchema(() =>
  z.object({
    deleted: z.boolean(),
  }),
);
export type AgentIdentityDeleteResponse = z.infer<
  typeof agentIdentityDeleteResponseSchema
>;

// ─── Index mutations ────────────────────────────────────────────────────────

/**
 * The shape every index mutation answers with on success.
 *
 * It carries the path back rather than staying empty, because the host
 * normalises one (trailing separators, case on a case-insensitive volume) and a
 * client that assumed its own spelling survived would key its open-file state on
 * a path the index does not hold.
 */
const agentIdentityFileMutationOkFields = {
  kind: lazySchema(() => z.literal("ok")),
  path: agentIdentityPathSchema,
} as const;

/**
 * `agentIdentity.files.add@1.0` - mint an empty MARKDOWN document.
 *
 * The host is the only writer of `documents` and `files`, which is what keeps
 * the projection layer the single source of file metadata; the GUI edits
 * fragment BODIES directly over `agentIdentity.file.subscribe` but asks for a
 * path through here.
 *
 * Markdown only. A blob has bytes, and a path minted without them would be an
 * index entry pointing at nothing - a state the manifest has no representation
 * for, since `current` is the one field an entry cannot be missing. Blobs arrive
 * through `files.uploadBlob`, which mints the entry and the bytes in one call;
 * asking this method for a blob path answers `unsupportedBodyKind`.
 *
 * The response names the shard the new fragment was allocated in, so the caller
 * can open it immediately instead of waiting to see its own write come back down
 * the state lane.
 */
export const agentIdentityFilesAddRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    path: agentIdentityPathSchema,
  }),
);
export type AgentIdentityFilesAddRequest = z.infer<
  typeof agentIdentityFilesAddRequestSchema
>;

export const agentIdentityFilesAddResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      ...agentIdentityFileMutationOkFields,
      shardRoomId: z.string().min(1),
      fragmentName: z.string().min(1),
    }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentityFilesAddResponse = z.infer<
  typeof agentIdentityFilesAddResponseSchema
>;

/**
 * `agentIdentity.files.rename@1.0`.
 *
 * A rename is a new index entry plus a fragment copy under the new name, then
 * removal of the old - never a key edit in place, because the fragment's name is
 * derived from the path and a Y.XmlFragment cannot be re-keyed. The version log
 * therefore records it as a DELETE and a CREATE carrying the same content hash,
 * which is the pair the history view collapses back into one rename row.
 */
export const agentIdentityFilesRenameRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    fromPath: agentIdentityPathSchema,
    toPath: agentIdentityPathSchema,
  }),
);
export type AgentIdentityFilesRenameRequest = z.infer<
  typeof agentIdentityFilesRenameRequestSchema
>;

export const agentIdentityFilesRenameResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ ...agentIdentityFileMutationOkFields }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentityFilesRenameResponse = z.infer<
  typeof agentIdentityFilesRenameResponseSchema
>;

/**
 * `agentIdentity.files.delete@1.0`.
 *
 * A markdown file loses its `documents` entry and has its fragment cleared; a
 * blob is TOMBSTONED in the manifest and its local bytes removed. The asymmetry
 * is the plane's: a tombstone is what keeps the object's prior versions
 * addressable, and the cloud object survives until the identity does.
 */
export const agentIdentityFilesDeleteRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    path: agentIdentityPathSchema,
  }),
);
export type AgentIdentityFilesDeleteRequest = z.infer<
  typeof agentIdentityFilesDeleteRequestSchema
>;

export const agentIdentityFilesDeleteResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ ...agentIdentityFileMutationOkFields }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentityFilesDeleteResponse = z.infer<
  typeof agentIdentityFilesDeleteResponseSchema
>;

/**
 * Maximum RAW bytes carried by ONE `files.uploadBlob` call. The JSON unary
 * envelope carries canonical base64, so this expands to
 * {@link AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BASE64_CHARS} characters before
 * framing. Raise it against the encoded size and the transport budget, never by
 * reasoning from raw bytes alone.
 *
 * 512 KiB, taken from `HOST_FILE_TRANSFER_MAX_CHUNK_BYTES` rather than chosen:
 * that is this repo's one measured answer to "how much base64 fits comfortably
 * in a unary envelope", and a second, different number would be two answers to
 * one question.
 */
export const AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES = 512 * 1024;

/** Canonical base64 length of {@link AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES}. */
export const AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BASE64_CHARS =
  Math.ceil(AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES / 3) * 4;

/**
 * `agentIdentity.files.uploadBlob@1.0` - bytes from the GUI into the local blob
 * store, and onto the plane's upload outbox.
 *
 * ## One method, not three
 *
 * A 10 MiB file does not fit in one unary envelope, so this is a chunked
 * append - but it is ONE method rather than the open/write/close triple
 * `host.fileTransfer.*` uses. The difference is who owns the handle: a file
 * transfer reads a file the HOST already has, so a server-minted handle is the
 * only thing that can name it, whereas an upload is driven entirely by bytes the
 * CLIENT holds. A client-generated `uploadId` therefore carries the whole
 * session, and the sequence number is what makes a retried chunk idempotent
 * instead of a duplicate append.
 *
 * A file under the chunk cap is one call with `sequence: 0, final: true`, which
 * is the ordinary case and pays nothing for the chunking it did not need.
 *
 * ## Why `mediaType` is stated and not sniffed here
 *
 * The client states what it believes; the HOST decides. The manifest entry's
 * `mediaType` is host-authoritative and derived from the delivered bytes, on
 * `fetchArtifactAttachmentFoundSchema`'s reasoning - a media type echoed from a
 * filename is an assertion the sender cannot back. This field is a HINT for the
 * cases sniffing cannot settle (a text format with no magic bytes), and a host
 * that disagrees with it uses its own answer.
 */
export const agentIdentityFilesUploadBlobRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    path: agentIdentityPathSchema,
    /**
     * Client-generated, and the whole idempotency story. Every chunk of one
     * file carries the same id; a new upload to the same path mints a new one,
     * which is what lets the host tell a retry from a replacement.
     */
    uploadId: z.string().min(1),
    /** 0-based, strictly increasing. A repeated sequence is a retry, not an append. */
    sequence: z.number().int().nonnegative(),
    bytesBase64: z.base64().max(AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BASE64_CHARS),
    /** The last chunk. The host hashes, writes the manifest entry, and enqueues the upload. */
    final: z.boolean(),
    /** Caller's belief about the type. See the note above - the host decides. */
    mediaType: z.string().min(1).nullable(),
    /**
     * Whether the source file was executable. Carried on every chunk rather
     * than only the last so a caller cannot forget it on the one call that
     * matters; the host reads it from the `final` chunk.
     */
    executable: z.boolean(),
  }),
);
export type AgentIdentityFilesUploadBlobRequest = z.infer<
  typeof agentIdentityFilesUploadBlobRequestSchema
>;

export const agentIdentityFilesUploadBlobResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /**
     * A non-final chunk landed. `receivedBytes` is the running total the host
     * holds for this `uploadId`, so a client resuming after a reconnect can
     * tell how much of its own stream the host already has instead of starting
     * over.
     */
    z.object({
      kind: z.literal("accepted"),
      uploadId: z.string().min(1),
      receivedBytes: z.number().int().nonnegative(),
    }),
    /**
     * The final chunk landed and the manifest entry is written. `status` is the
     * plane's own entry status, so the caller learns immediately whether the
     * bytes are merely local (`local-only`, the free-tier gate's answer) or
     * queued for upload (`pending`) without waiting for the state lane.
     */
    z.object({
      kind: z.literal("committed"),
      path: agentIdentityPathSchema,
      sha256: identityFileSha256Schema,
      byteLength: z
        .number()
        .int()
        .nonnegative()
        .max(AGENT_IDENTITY_FILE_MAX_BYTES),
      status: z.string(),
    }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentityFilesUploadBlobResponse = z.infer<
  typeof agentIdentityFilesUploadBlobResponseSchema
>;

/**
 * `agentIdentity.files.readBlob@1.0` - a blob's bytes back out to the GUI, for
 * preview and download. The read half of `files.uploadBlob`, chunked the same
 * way and capped by the same number.
 *
 * ## Addressed by `(path, sha256)`, not by path alone
 *
 * A multi-chunk read is several calls, and the path can be overwritten between
 * them. Naming the object makes every chunk of one read come from ONE object:
 * a client that learned `sha256` from the index lane's manifest entry gets that
 * object's bytes or a refusal, never the first half of the old file spliced to
 * the second half of the new one. The sha may name the entry's `current` object
 * or any object still in its `versions[]` - so a history view can read a prior
 * version through the same method. A sha the path holds in neither place
 * answers `pathNotFound`: from the caller's side, the thing it addressed is not
 * there.
 *
 * ## Chunking
 *
 * `offset` and `length` are in RAW bytes. `length` is capped at
 * {@link AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES} - one measured answer to "how
 * much base64 fits in a unary envelope", so a read chunk and an upload chunk are
 * the same size. The host returns at most `length` bytes; fewer means the object
 * ended. A read at or past the end is not an error: it answers `ok` with no
 * bytes and `final: true`, which is also what a zero-length blob's only chunk
 * looks like.
 *
 * ## `pending`
 *
 * The plane mirrors bytes lazily - a blob over the eager-download threshold is
 * fetched on first demand - so a host may know an object it cannot serve YET.
 * `pending` says exactly that: the entry and the sha are right, the mirror has
 * not landed the bytes, and the host has started fetching them. The client
 * retries the SAME request later; nothing about it is wrong. It is an answer
 * rather than a wait held open inside the unary, because a large download can
 * outlive any unary timeout.
 */
export const agentIdentityFilesReadBlobRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    path: agentIdentityPathSchema,
    /** The object to read: the entry's `current.sha256`, or one in `versions[]`. */
    sha256: identityFileSha256Schema,
    /** Raw-byte offset into the object. */
    offset: z.number().int().nonnegative().max(AGENT_IDENTITY_FILE_MAX_BYTES),
    /** Raw bytes wanted, at most one upload chunk. */
    length: z
      .number()
      .int()
      .positive()
      .max(AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BYTES),
  }),
);
export type AgentIdentityFilesReadBlobRequest = z.infer<
  typeof agentIdentityFilesReadBlobRequestSchema
>;

export const agentIdentityFilesReadBlobResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ok"),
      /** This chunk: at most `length` raw bytes starting at `offset`. */
      bytesBase64: z.base64().max(AGENT_IDENTITY_UPLOAD_MAX_CHUNK_BASE64_CHARS),
      /**
       * The WHOLE object's length, not this chunk's - the chunk's is its own
       * decoded size. Carried on every chunk so the first answer tells the
       * caller how many more to ask for.
       */
      byteLength: z
        .number()
        .int()
        .nonnegative()
        .max(AGENT_IDENTITY_FILE_MAX_BYTES),
      /** The manifest entry's host-authoritative media type for this object. */
      mediaType: z.string().min(1),
      /** Whether this chunk reaches the end of the object. */
      final: z.boolean(),
    }),
    /** Known object, bytes not local yet; the host is fetching. Retry later. */
    z.object({ kind: z.literal("pending") }),
    /**
     * `pathNotFound` (no blob at the path, or not this sha),
     * `unsupportedBodyKind` (a markdown path - its body rides
     * `agentIdentity.file.subscribe`), `identityNotFound`, or
     * `projectionUnavailable`.
     */
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentityFilesReadBlobResponse = z.infer<
  typeof agentIdentityFilesReadBlobResponseSchema
>;

// ─── History ────────────────────────────────────────────────────────────────

/**
 * WHY a version of an identity file exists.
 *
 * The artifact-history union PLUS an `evolution` arm, derived from the live
 * union rather than restated: every kind an artifact write can have, an identity
 * write can have too, and a second hand-written copy of ten variants is a seam
 * where they would drift.
 *
 * `evolution` is the one addition, and it is added HERE rather than to
 * `artifactVersionProvenanceKindSchema` on purpose. That enum is reachable from
 * the RELEASED `epic.artifactVersions.list` line, where growing an enum is a
 * breaking change that would take a new major and a bridge dropping the value.
 * Nothing about identity history needs that: this family has no released line to
 * protect, so the new vocabulary lives on the new surface and the old one is
 * untouched.
 *
 * `identity-provenance-parity.test.ts` pins the two together - the discriminants
 * here must be exactly the artifact union's plus `evolution` - so an arm added
 * upstream cannot silently fail to reach identity history.
 */
export const agentIdentityVersionProvenanceSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    ...artifactVersionProvenanceSchema.options,
    /**
     * Written by an identity's own evolution chat. It carries the chat id so
     * the history view can link the change back to the pass that made it, and
     * nothing else: the pass runs one turn with the identity's own review
     * harness, which the identity record already states.
     */
    z
      .object({
        kind: z.literal("evolution"),
        chatId: z.string().min(1),
      })
      .strict(),
  ]),
);
export type AgentIdentityVersionProvenance = z.infer<
  typeof agentIdentityVersionProvenanceSchema
>;

/**
 * One version of one identity file.
 *
 * `artifactVersionObservationEntrySchema` with its `provenance` widened to the
 * union above - derived, so every other field (the content hash, the capture
 * stream, the availability and degraded flags) keeps its upstream schema rather
 * than a lookalike.
 */
export const agentIdentityVersionEntrySchema = lazySchema(() =>
  artifactVersionObservationEntrySchema.extend({
    provenance: agentIdentityVersionProvenanceSchema,
  }),
);
export type AgentIdentityVersionEntry = z.infer<
  typeof agentIdentityVersionEntrySchema
>;

/**
 * `agentIdentity.history.list@1.0` - a thin wrapper over the artifact-version
 * resolvers with the identity id in the container slot and the relative path in
 * the artifact-id slot.
 *
 * The paging shape is the artifact reader's, field for field, because it IS that
 * reader: an opaque cursor and a bounded limit. Restating it with different
 * bounds would be two answers to one question.
 */
export const agentIdentityHistoryListRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    path: agentIdentityPathSchema,
    cursor: z.string().min(1).nullable(),
    limit: z.number().int().min(1).max(200).nullable(),
  }),
);
export type AgentIdentityHistoryListRequest = z.infer<
  typeof agentIdentityHistoryListRequestSchema
>;

export const agentIdentityHistoryListResponseSchema = lazySchema(() =>
  z.object({
    entries: z.array(agentIdentityVersionEntrySchema),
    nextCursor: z.string().min(1).nullable(),
  }),
);
export type AgentIdentityHistoryListResponse = z.infer<
  typeof agentIdentityHistoryListResponseSchema
>;

/**
 * `agentIdentity.history.restore@1.0`.
 *
 * `mode` and the conflict guard are the artifact reader's, and so is the
 * response union - a restore either previews, lands, conflicts, or reports why
 * it cannot, and identity files gave no reason to invent a fifth outcome.
 *
 * A markdown restore is a fragment patch from the stored markdown; a blob
 * restore promotes an object out of the entry's `versions[]` back to `current`,
 * fetching the bytes by sha through the mirror if this host does not hold them.
 */
export const agentIdentityHistoryRestoreRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    path: agentIdentityPathSchema,
    targetObservationId: z.string().min(1),
    mode: z.enum(["preflight", "execute"]),
    /**
     * The hash the caller believes is current. Present means "refuse if the file
     * has moved under me", which is what turns a restore raced by an agent write
     * into a `conflict` the user can re-read rather than a silent clobber.
     */
    expectedCurrentHash: identityFileSha256Schema.nullable(),
  }),
);
export type AgentIdentityHistoryRestoreRequest = z.infer<
  typeof agentIdentityHistoryRestoreRequestSchema
>;

export const agentIdentityHistoryRestoreResponseSchema =
  artifactVersionsRestoreResponseSchema;
export type AgentIdentityHistoryRestoreResponse = z.infer<
  typeof agentIdentityHistoryRestoreResponseSchema
>;

// ─── Hermes import ──────────────────────────────────────────────────────────
//
// NOT REGISTERED YET. `agentIdentity.import.hermes.scan` and `.run` are
// registered by T12 (Hermes profile import) together with their host
// resolvers: the contract (`agent-identity/contracts.ts`), the `hostRpcRegistry`
// entry at `{1,0}` with `degrade: { kind: "unsupported" }`, the gui-app
// policy-table rows, and the family list in `agent-identity-registration.test.ts`.
// They are held back because the host's resolver-coverage gate fails any
// advertised method without a resolver. Two facts the registry entries carried
// until then: `scan` reads a profile directory on THIS host (the profile lives
// on that host's disk), and `run` is idempotent by path - re-running into the
// same identity replaces files and keeps the old versions in history. `scan` is
// a dry run, so its policy row coalesces; `run` is a mutation and is `fifo`.

/**
 * WHY one item of a Hermes profile cannot be imported.
 *
 * CLOSED, and deliberately the session importer's vocabulary rather than a new
 * one: a scan only ever READS, so the only things that can go wrong are that the
 * file will not open, that it holds nothing, or that the host broke. The wizard
 * already renders a row treatment per value.
 */
export const agentIdentityHermesUnreadableReasonSchema = lazySchema(() =>
  z.enum(["source_unreadable", "source_empty", "internal_error"]),
);
export type AgentIdentityHermesUnreadableReason = z.infer<
  typeof agentIdentityHermesUnreadableReasonSchema
>;

/**
 * One importable item found in a Hermes profile.
 *
 * `bundled` is the flag the wizard defaults to UNCHECKED: a skill whose hash
 * matches the profile's `.bundled_manifest` is one Hermes shipped, and copying
 * it into a Traycer identity would duplicate a skill the stock identity already
 * seeds. A user may still tick it - a bundled skill they then edited is a real
 * thing to bring across - which is why it is a default rather than an exclusion.
 */
export const agentIdentityHermesScanItemSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("soul"),
      /** Characters, so the wizard can warn before the markdown cap truncates. */
      characters: z.number().int().nonnegative(),
    }),
    z.object({
      kind: z.literal("memory"),
      /** `memories/MEMORY.md` or `memories/USER.md`, relative to the profile. */
      relPath: z.string().min(1),
      /** `§`-delimited entries found, which become markdown bullets on import. */
      entries: z.number().int().nonnegative(),
    }),
    z.object({
      kind: z.literal("skill"),
      name: z.string().min(1),
      relPath: z.string().min(1),
      description: z.string().nullable(),
      bundled: z.boolean(),
    }),
    /**
     * Something was there and could not be read. Carried as an ITEM rather than
     * as a scan-level error so the wizard can list what it will skip beside what
     * it will bring, which is the session importer's own vocabulary.
     */
    z.object({
      kind: z.literal("unreadable"),
      relPath: z.string().min(1),
      reason: agentIdentityHermesUnreadableReasonSchema,
      detail: z.string(),
    }),
  ]),
);
export type AgentIdentityHermesScanItem = z.infer<
  typeof agentIdentityHermesScanItemSchema
>;

/**
 * `agentIdentity.import.hermes.scan@1.0` - what a profile directory would bring.
 *
 * Runs on the chosen host, because the profile lives on THAT host's disk. It
 * accepts `~/.hermes` (the default profile) or `~/.hermes/profiles/<name>`, and
 * refuses a directory with no `SOUL.md` - the marker Hermes itself uses, so the
 * refusal is a fact about the directory rather than a guess.
 *
 * `config.yaml`, `.env`, `auth.json`, `sessions/`, `cron/`, `mcp.json` and
 * `state.db` are NEVER read. That is a property of the scanner, not of this
 * schema, and it is stated here because this is the contract a reviewer reads.
 */
export const agentIdentityHermesScanRequestSchema = lazySchema(() =>
  z.object({
    /** Absolute path to a Hermes profile directory on the serving host. */
    directory: z.string().min(1),
  }),
);
export type AgentIdentityHermesScanRequest = z.infer<
  typeof agentIdentityHermesScanRequestSchema
>;

export const agentIdentityHermesScanResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("profile"),
      /** The profile's own name where the layout carries one, else `null`. */
      profileName: z.string().min(1).nullable(),
      items: z.array(agentIdentityHermesScanItemSchema),
    }),
    /**
     * Not a Hermes profile. Separate from an empty `items` list because the two
     * mean different things to the user: "nothing to import from this profile"
     * is a profile, and "this is not a profile" is a wrong folder.
     */
    z.object({
      kind: z.literal("notAProfile"),
      detail: z.string(),
    }),
  ]),
);
export type AgentIdentityHermesScanResponse = z.infer<
  typeof agentIdentityHermesScanResponseSchema
>;

/**
 * `agentIdentity.import.hermes.run@1.0`.
 *
 * `identityId` names an EXISTING identity to import into, or `null` to create
 * one. Re-running against the same directory into the same identity replaces
 * files by path and keeps the previous versions in history, which is what makes
 * a half-finished import safe to repeat.
 *
 * The selection is by RELATIVE PATH rather than by an index into the scan's
 * item list: a second scan of a directory that changed underneath the wizard
 * would renumber the list, and an index-based selection would then import
 * something the user did not tick.
 */
export const agentIdentityHermesRunRequestSchema = lazySchema(() =>
  z.object({
    directory: z.string().min(1),
    identityId: agentIdentityIdSchema.nullable(),
    /** Used only when `identityId` is null. */
    title: z.string().min(1).nullable(),
    /** `SOUL.md`, the memory files and the skill directories the user ticked. */
    selectedRelPaths: z.array(z.string().min(1)),
  }),
);
export type AgentIdentityHermesRunRequest = z.infer<
  typeof agentIdentityHermesRunRequestSchema
>;

/**
 * What one selected item became.
 *
 * `truncated` is carried per item rather than as one scan-level flag because the
 * markdown cap bites per FILE - a soul that fit and a memory file that did not
 * is the ordinary case, and one boolean would make the user hunt for which.
 */
export const agentIdentityHermesRunItemResultSchema = lazySchema(() =>
  z.object({
    relPath: z.string().min(1),
    outcome: z.enum(["imported", "skipped", "failed"]),
    truncated: z.boolean(),
    detail: z.string().nullable(),
  }),
);
export type AgentIdentityHermesRunItemResult = z.infer<
  typeof agentIdentityHermesRunItemResultSchema
>;

export const agentIdentityHermesRunResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("imported"),
      identity: agentIdentitySummarySchema,
      items: z.array(agentIdentityHermesRunItemResultSchema),
    }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentityHermesRunResponse = z.infer<
  typeof agentIdentityHermesRunResponseSchema
>;

// ─── Skill installer ────────────────────────────────────────────────────────

/**
 * `agentIdentity.skills.inspect@1.0` - clone, scan and validate a skill source
 * against an IDENTITY's `skills/` root.
 *
 * The provider installer's own two-step, pointed at a different destination:
 * `inspect` mints a session token over a fetched tree and lists what is in it,
 * `import` names the token and the candidates the user ticked. The destination
 * is the only thing that differs, which is why `installSelectedSkills` and the
 * clone-scan-validate half of `inspectProviderSkills` factor into a
 * destination-free module rather than being copied.
 *
 * The result shape is `providersSkillsInspectResultSchema` verbatim - the same
 * token, commit sha and candidate rows - so the GUI can reuse
 * `provider-skill-composer-dialog` with a target selector instead of growing a
 * second picker that renders the same list.
 */
export const agentIdentitySkillsInspectRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    /** File, URL, `owner/repo`, tree URL, or an `npx skills add …` wrapper. */
    source: z.string().min(1),
  }),
);
export type AgentIdentitySkillsInspectRequest = z.infer<
  typeof agentIdentitySkillsInspectRequestSchema
>;

export const agentIdentitySkillsInspectResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("inspected"),
      ...providersSkillsInspectResultSchema.shape,
    }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentitySkillsInspectResponse = z.infer<
  typeof agentIdentitySkillsInspectResponseSchema
>;

/**
 * `agentIdentity.skills.import@1.0` - install the ticked candidates under
 * `<identityRoot>/skills`.
 *
 * `token` and `names` travel together or not at all, exactly as they do on the
 * provider installer's `import` action: a token without names is an install of
 * nothing, and names without a token name candidates from no session.
 *
 * The call returns only once the projection's ingest has SETTLED for the files
 * it wrote. A skill installer that returned at `cp` time would leave the GUI
 * rendering an identity whose new files are not in the index yet, and the user's
 * next action - opening the SKILL.md it just told them about - would miss.
 */
export const agentIdentitySkillsImportRequestSchema = lazySchema(() =>
  z.object({
    identityId: agentIdentityIdSchema,
    token: z.string().min(1),
    names: z.array(z.string().min(1)).min(1),
  }),
);
export type AgentIdentitySkillsImportRequest = z.infer<
  typeof agentIdentitySkillsImportRequestSchema
>;

export const agentIdentitySkillsImportResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("imported"),
      /**
       * The candidates that landed, in the inspect result's own row shape so
       * the dialog can diff what it asked for against what it got without a
       * second vocabulary.
       */
      installed: z.array(providerSkillInspectCandidateSchema),
      /** Paths written under the identity root, for the caller to open. */
      paths: z.array(agentIdentityPathSchema),
    }),
    z.object({ ...agentIdentityRefusalFields }),
  ]),
);
export type AgentIdentitySkillsImportResponse = z.infer<
  typeof agentIdentitySkillsImportResponseSchema
>;
