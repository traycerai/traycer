/**
 * Cross-host target-side capabilities: repo → path enumeration, a
 * non-persistent one-off shell, and the host directory an agent needs in
 * order to name a peer at all. Brand-new unary methods on the
 * optional-capability channel (`degrade: unsupported`).
 *
 * **There is deliberately no `host.file.read` / `host.file.write` here.**
 * Both existed briefly and were removed before release: their `content` was
 * a plain string, so every byte crossed the wire *through agent context* —
 * the model had to re-emit the whole file as a tool argument, which caps the
 * useful size at tens of KB regardless of any byte limit, and is worse for
 * binary at base64's 4/3 expansion. They also bought no capability the
 * one-off shell lacks (`cat` and a heredoc are equally context-bound). The
 * host-side plumbing they used — chunked source, `AsyncIterable` sink,
 * atomic temp+rename, path policy — is kept in the host's own file service
 * for a future copy verb that moves bytes host-to-host without the agent
 * ever holding them. Do not reintroduce a byte-carrying file RPC.
 */
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { z } from "zod";

export const hostResolveRepoPathsRequestSchema = z.object({
  epicId: z.string().min(1),
  identity: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("remote-url"),
      remoteUrl: z.string().min(1),
    }),
    z.object({
      kind: z.literal("workspace"),
      workspacePath: z.string().min(1),
    }),
  ]),
});
export type HostResolveRepoPathsRequest = z.infer<
  typeof hostResolveRepoPathsRequestSchema
>;

export const hostResolveRepoPathsResponseSchema = z.object({
  paths: z.array(z.string()),
  scratchDirectory: z.string(),
});
export type HostResolveRepoPathsResponse = z.infer<
  typeof hostResolveRepoPathsResponseSchema
>;

export const hostResolveRepoPathsV10 = defineRpcContract({
  method: "host.resolveRepoPaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostResolveRepoPathsRequestSchema,
  responseSchema: hostResolveRepoPathsResponseSchema,
});

export const hostOneOffShellRunRequestSchema = z.object({
  epicId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300_000),
});
export type HostOneOffShellRunRequest = z.infer<
  typeof hostOneOffShellRunRequestSchema
>;

export const hostOneOffShellRunResponseSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  outputLimitExceeded: z.boolean(),
  outputBytes: z.number().int().nonnegative(),
});
export type HostOneOffShellRunResponse = z.infer<
  typeof hostOneOffShellRunResponseSchema
>;

export const hostOneOffShellRunV10 = defineRpcContract({
  method: "host.oneOffShell.run",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostOneOffShellRunRequestSchema,
  responseSchema: hostOneOffShellRunResponseSchema,
});

/**
 * One machine in the caller's own fleet, as the cloud host directory
 * describes it. This is the answer to "which hosts exist?", which every
 * other cross-host verb assumes has already been answered: they all take a
 * target host id, and until this method existed an agent had no supported
 * way to obtain one for any machine but its own.
 *
 * **`relayAttached` is a FACT, not a verdict.** It reports what the cloud
 * last observed, and it is deliberately not named `reachable`: nothing in
 * the dial path gates on it. The router resolves a target and *attempts the
 * dial*, letting a genuine failure surface as `HOST_UNREACHABLE`, precisely
 * so a stale directory reading cannot refuse a machine that would in fact
 * answer. Treat this as a hint for choosing among hosts, never as a
 * precondition to check before calling — a second dialability predicate
 * living here would be a second reading of a rule the dialer already owns.
 *
 * `publicKey` is **not** projected: it is the dialer's Noise material, not
 * something an agent has any use for.
 *
 * `platform` is passed through as the cloud's free-text string (it is what
 * feeds the desktop host directory). Do not narrow it to an enum here — the
 * value's shape is authn's to define, and an enum would drift the moment it
 * writes something new. It is, incidentally, how an agent learns which shell
 * flavour a one-off command will meet on that machine.
 */
export const hostDirectoryEntrySchema = z.object({
  hostId: z.string(),
  displayName: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  relayAttached: z.boolean(),
  busy: z.boolean(),
});
export type HostDirectoryEntrySummary = z.infer<
  typeof hostDirectoryEntrySchema
>;

export const hostDirectoryListRequestSchema = z.object({});
export type HostDirectoryListRequest = z.infer<
  typeof hostDirectoryListRequestSchema
>;

export const hostDirectoryListResponseSchema = z.object({
  hosts: z.array(hostDirectoryEntrySchema),
});
export type HostDirectoryListResponse = z.infer<
  typeof hostDirectoryListResponseSchema
>;

export const hostDirectoryListV10 = defineRpcContract({
  method: "host.directory.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostDirectoryListRequestSchema,
  responseSchema: hostDirectoryListResponseSchema,
});

/**
 * Cross-host copies are destination-pull jobs: the destination accepts this
 * request, then moves bytes directly from the source without ever returning
 * file content to the invoking agent. `sourceHostId: null` is the degenerate
 * same-host case; it means "this destination host" rather than an invented
 * sentinel id. `epicId` scopes destination path authorization when the job is
 * created; status and cancel rely on that already-authorized job capability.
 */
export const hostFileCopyOverwriteSchema = z.enum([
  "overwrite",
  "skip-existing",
]);
export type HostFileCopyOverwrite = z.infer<typeof hostFileCopyOverwriteSchema>;

export const hostFileCopyStartRequestSchema = z.object({
  epicId: z.string().min(1),
  sourceHostId: z.string().min(1).nullable(),
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  exclude: z.array(z.string().min(1)),
  overwrite: hostFileCopyOverwriteSchema.default("overwrite"),
});
export type HostFileCopyStartRequest = z.infer<
  typeof hostFileCopyStartRequestSchema
>;

export const hostFileCopyStartResponseSchema = z.object({
  jobId: z.string().min(1),
});
export type HostFileCopyStartResponse = z.infer<
  typeof hostFileCopyStartResponseSchema
>;

export const hostFileCopyStartV10 = defineRpcContract({
  method: "host.fileCopy.start",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileCopyStartRequestSchema,
  responseSchema: hostFileCopyStartResponseSchema,
});

export const hostFileCopyProgressSchema = z.object({
  filesCompleted: z.number().int().nonnegative(),
  bytesTransferred: z.number().int().nonnegative(),
});
export type HostFileCopyProgress = z.infer<typeof hostFileCopyProgressSchema>;

export const HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH = 1024;

export const hostFileCopyFailureOperationSchema = z.enum([
  "enumerate",
  "stat",
  "readlink",
  "readdir",
  "open",
  "read",
  "create-directory",
  "write",
  "create-symlink",
  "preserve-metadata",
]);
export type HostFileCopyFailureOperation = z.infer<
  typeof hostFileCopyFailureOperationSchema
>;

export const hostFileCopyFailureSchema = z.object({
  relativePath: z.string(),
  operation: hostFileCopyFailureOperationSchema,
  message: z.string(),
});
export type HostFileCopyFailure = z.infer<typeof hostFileCopyFailureSchema>;

export const hostFileCopySkippedUnsafeSymlinkSchema = z.object({
  relativePath: z.string(),
  target: z.string(),
});
export type HostFileCopySkippedUnsafeSymlink = z.infer<
  typeof hostFileCopySkippedUnsafeSymlinkSchema
>;

/**
 * A terminal manifest keeps successful work aggregate-only and samples at
 * most this many failures or unsafe symlinks. A wholesale tree failure must
 * still produce a usable status response instead of recreating the unbounded
 * agent-context payload this copy surface replaces.
 */
export const HOST_FILE_COPY_MANIFEST_ITEM_LIMIT = 200;

export const hostFileCopyManifestSummarySchema = z.object({
  filesCopied: z.number().int().nonnegative(),
  directoriesCreated: z.number().int().nonnegative(),
  symlinksCreated: z.number().int().nonnegative(),
  bytesCopied: z.number().int().nonnegative(),
  replacements: z.number().int().nonnegative(),
  skippedExisting: z.number().int().nonnegative(),
});
export type HostFileCopyManifestSummary = z.infer<
  typeof hostFileCopyManifestSummarySchema
>;

/**
 * `failureCount` and `skippedUnsafeSymlinkCount` are exact. Their item arrays
 * are separately capped samples, with the omitted counts explicit, because
 * deriving totals from an unbounded item list would make large failures
 * impossible to report through one unary status response.
 */
export const hostFileCopyManifestSchema = z.object({
  summary: hostFileCopyManifestSummarySchema,
  failureCount: z.number().int().nonnegative(),
  failures: z
    .array(hostFileCopyFailureSchema)
    .max(HOST_FILE_COPY_MANIFEST_ITEM_LIMIT),
  failuresOmitted: z.number().int().nonnegative(),
  skippedUnsafeSymlinkCount: z.number().int().nonnegative(),
  skippedUnsafeSymlinks: z
    .array(hostFileCopySkippedUnsafeSymlinkSchema)
    .max(HOST_FILE_COPY_MANIFEST_ITEM_LIMIT),
  skippedUnsafeSymlinksOmitted: z.number().int().nonnegative(),
});
export type HostFileCopyManifest = z.infer<typeof hostFileCopyManifestSchema>;

const hostFileCopyActiveStatusFields = {
  progress: hostFileCopyProgressSchema,
} as const;

const hostFileCopyTerminalStatusFields = {
  ...hostFileCopyActiveStatusFields,
  manifest: hostFileCopyManifestSchema,
} as const;

/**
 * A failed job's reason is job-level and distinct from per-entry manifest
 * failures. `failureCount: 0` is coherent: no entry failed, but the job stopped
 * because of this reason. The message is bounded because it reaches agent
 * context through status.
 */
const hostFileCopyFailureReasonSchema = z.object({
  operation: hostFileCopyFailureOperationSchema,
  message: z.string().max(HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH),
});

const hostFileCopyNoFailureReasonField = {
  reason: z.never().optional(),
} as const;

/**
 * `unknown-job` is the honest post-restart answer: jobs and their registry
 * are intentionally in-memory, so the host cannot distinguish a job that
 * died in flight from an expired or invalid id. Callers interpret it as
 * died-or-expired and may retry. A durable `died-in-flight` tombstone was
 * rejected because it would introduce exactly the restart persistence this
 * v1 design keeps out of scope. Unlike a known terminal state, there is no
 * progress or manifest left to return for an unknown id.
 */
export const hostFileCopyStatusResponseSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("queued"),
    ...hostFileCopyActiveStatusFields,
    ...hostFileCopyNoFailureReasonField,
  }),
  z.object({
    state: z.literal("running"),
    ...hostFileCopyActiveStatusFields,
    ...hostFileCopyNoFailureReasonField,
  }),
  z.object({
    state: z.literal("completed"),
    ...hostFileCopyTerminalStatusFields,
    ...hostFileCopyNoFailureReasonField,
  }),
  z.object({
    state: z.literal("failed"),
    ...hostFileCopyTerminalStatusFields,
    reason: hostFileCopyFailureReasonSchema,
  }),
  z.object({
    state: z.literal("cancelled"),
    ...hostFileCopyTerminalStatusFields,
    ...hostFileCopyNoFailureReasonField,
  }),
  z.object({
    state: z.literal("unknown-job"),
    ...hostFileCopyNoFailureReasonField,
  }),
]);
export type HostFileCopyStatusResponse = z.infer<
  typeof hostFileCopyStatusResponseSchema
>;

export const hostFileCopyStatusRequestSchema = z.object({
  jobId: z.string().min(1),
});
export type HostFileCopyStatusRequest = z.infer<
  typeof hostFileCopyStatusRequestSchema
>;

export const hostFileCopyStatusV10 = defineRpcContract({
  method: "host.fileCopy.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileCopyStatusRequestSchema,
  responseSchema: hostFileCopyStatusResponseSchema,
});

export const hostFileCopyCancelRequestSchema = z.object({
  jobId: z.string().min(1),
});
export type HostFileCopyCancelRequest = z.infer<
  typeof hostFileCopyCancelRequestSchema
>;

export const hostFileCopyCancelResponseSchema = z.object({
  accepted: z.boolean(),
});
export type HostFileCopyCancelResponse = z.infer<
  typeof hostFileCopyCancelResponseSchema
>;

export const hostFileCopyCancelV10 = defineRpcContract({
  method: "host.fileCopy.cancel",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileCopyCancelRequestSchema,
  responseSchema: hostFileCopyCancelResponseSchema,
});

/** Fixed source-walk page size: entry lists are bulk data too. */
export const HOST_FILE_TRANSFER_ENUMERATE_PAGE_SIZE = 256;

const hostFileTransferEntryMetadataFields = {
  /** Empty string denotes the source root itself. */
  relativePath: z.string(),
  /** Permission and special mode bits; file-type bits are excluded. */
  mode: z.number().int().nonnegative().max(0o7777),
  mtimeMs: z.number().finite(),
} as const;

const hostFileTransferUnreadableOperationSchema =
  hostFileCopyFailureOperationSchema.extract(["stat", "readlink", "readdir"]);

/**
 * The source walk computes symlink safety against the transferred tree's
 * boundary. `safety` is therefore an authoritative fact carried to the
 * destination, not a hint for the destination to re-derive. Unsafe means an
 * absolute target or `..` resolution escaping the transferred tree (rsync
 * `--safe-links` semantics).
 */
export const hostFileTransferEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    ...hostFileTransferEntryMetadataFields,
    sizeBytes: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("directory"),
    ...hostFileTransferEntryMetadataFields,
  }),
  z.object({
    kind: z.literal("symlink"),
    ...hostFileTransferEntryMetadataFields,
    target: z.string(),
    safety: z.enum(["safe", "unsafe"]),
  }),
  /**
   * A source-authored per-entry failure keeps the page and later walk entries
   * usable. `message` is bounded because it reaches the agent through the
   * manifest and follows the same output discipline as manifest failure items.
   */
  z.object({
    kind: z.literal("unreadable"),
    relativePath: z.string(),
    operation: hostFileTransferUnreadableOperationSchema,
    message: z.string().max(HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH),
  }),
]);
export type HostFileTransferEntry = z.infer<typeof hostFileTransferEntrySchema>;

/**
 * Source paths are epic-scoped at enumeration and open. Once open succeeds,
 * the handle pins the authorized descriptor: read and close intentionally do
 * not re-authorize its epic scope or imply the descriptor is re-derivable.
 */
export const hostFileTransferEnumerateRequestSchema = z.object({
  epicId: z.string().min(1),
  sourcePath: z.string().min(1),
  exclude: z.array(z.string().min(1)),
  cursor: z.string().min(1).nullable(),
});
export type HostFileTransferEnumerateRequest = z.infer<
  typeof hostFileTransferEnumerateRequestSchema
>;

export const hostFileTransferEnumerateResponseSchema = z.object({
  entries: z
    .array(hostFileTransferEntrySchema)
    .max(HOST_FILE_TRANSFER_ENUMERATE_PAGE_SIZE),
  nextCursor: z.string().min(1).nullable(),
});
export type HostFileTransferEnumerateResponse = z.infer<
  typeof hostFileTransferEnumerateResponseSchema
>;

export const hostFileTransferEnumerateV10 = defineRpcContract({
  method: "host.fileTransfer.enumerate",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileTransferEnumerateRequestSchema,
  responseSchema: hostFileTransferEnumerateResponseSchema,
});

export const hostFileTransferOpenRequestSchema = z.object({
  epicId: z.string().min(1),
  sourcePath: z.string().min(1),
  relativePath: z.string(),
});
export type HostFileTransferOpenRequest = z.infer<
  typeof hostFileTransferOpenRequestSchema
>;

export const hostFileTransferOpenResponseSchema = z.object({
  handleId: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type HostFileTransferOpenResponse = z.infer<
  typeof hostFileTransferOpenResponseSchema
>;

export const hostFileTransferOpenV10 = defineRpcContract({
  method: "host.fileTransfer.open",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileTransferOpenRequestSchema,
  responseSchema: hostFileTransferOpenResponseSchema,
});

/**
 * Maximum RAW bytes returned by one ranged read. The JSON unary envelope
 * carries canonical base64, so 512 KiB raw expands to 699,052 characters
 * (about 683 KiB) before JSON framing. Raise this only against the encoded
 * size and transport budgets, never by reasoning from raw bytes alone.
 */
export const HOST_FILE_TRANSFER_MAX_CHUNK_BYTES = 512 * 1024;

export const hostFileTransferReadChunkRequestSchema = z.object({
  handleId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive().max(HOST_FILE_TRANSFER_MAX_CHUNK_BYTES),
});
export type HostFileTransferReadChunkRequest = z.infer<
  typeof hostFileTransferReadChunkRequestSchema
>;

/**
 * This is deliberately not a reintroduction of `host.file.read`: the base64
 * payload is available only on the host-to-host pull leg, after opening a
 * bounded transfer handle, and is consumed by the destination copy engine.
 * It is never projected into the agent-facing start/status/cancel surface or
 * accepted as a tool argument, so the agent never holds or re-emits bytes.
 */
export const hostFileTransferReadChunkResponseSchema = z.object({
  bytesBase64: z.base64(),
  bytesRead: z.number().int().nonnegative(),
  eof: z.boolean(),
});
export type HostFileTransferReadChunkResponse = z.infer<
  typeof hostFileTransferReadChunkResponseSchema
>;

export const hostFileTransferReadChunkV10 = defineRpcContract({
  method: "host.fileTransfer.readChunk",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileTransferReadChunkRequestSchema,
  responseSchema: hostFileTransferReadChunkResponseSchema,
});

export const hostFileTransferCloseRequestSchema = z.object({
  handleId: z.string().min(1),
});
export type HostFileTransferCloseRequest = z.infer<
  typeof hostFileTransferCloseRequestSchema
>;

export const hostFileTransferCloseResponseSchema = z.object({
  closed: z.boolean(),
});
export type HostFileTransferCloseResponse = z.infer<
  typeof hostFileTransferCloseResponseSchema
>;

export const hostFileTransferCloseV10 = defineRpcContract({
  method: "host.fileTransfer.close",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileTransferCloseRequestSchema,
  responseSchema: hostFileTransferCloseResponseSchema,
});
