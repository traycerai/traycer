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
import { agentModeSchema } from "@traycer/protocol/common/schemas";
import { browserSessionReferenceSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  chatRunSettingsStrictSchema,
  tuiHarnessIdSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import { z } from "zod";
import {
  createAgentRequestSchemaV30,
  createAgentResponseSchema,
} from "./agent/shared";
import {
  hostCommandInterpreterSchema,
  hostConnectivitySchema,
} from "./host-status";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const hostResolveRepoPathsRequestSchema = lazySchema(() =>
  z.object({
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
  }),
);
export type HostResolveRepoPathsRequest = z.infer<
  typeof hostResolveRepoPathsRequestSchema
>;

export const hostResolveRepoPathsResponseSchema = lazySchema(() =>
  z.object({
    paths: z.array(z.string()),
    scratchDirectory: z.string(),
  }),
);
export type HostResolveRepoPathsResponse = z.infer<
  typeof hostResolveRepoPathsResponseSchema
>;

export const hostResolveRepoPathsV10 = defineRpcContract({
  method: "host.resolveRepoPaths",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostResolveRepoPathsRequestSchema,
  responseSchema: hostResolveRepoPathsResponseSchema,
});

export const hostOneOffShellRunRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    timeoutMs: z.number().int().positive().max(300_000),
  }),
);
export type HostOneOffShellRunRequest = z.infer<
  typeof hostOneOffShellRunRequestSchema
>;

export const hostOneOffShellRunResponseSchema = lazySchema(() =>
  z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    outputLimitExceeded: z.boolean(),
    outputBytes: z.number().int().nonnegative(),
  }),
);
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
 * **`connectivity` is a FACT, not a verdict.** It is the cloud's own liveness
 * word for the host — the single value `GET /api/v3/hosts` reports, typed here
 * by the same {@link hostConnectivitySchema} the GUI status mirror uses — and
 * it is deliberately not named `reachable`: nothing in the dial path gates on
 * it. The router resolves a target and *attempts the dial* whatever this says,
 * letting a genuine failure surface as `HOST_UNREACHABLE`, precisely so a stale
 * directory reading cannot refuse a machine that would in fact answer. Treat it
 * as a hint for choosing among hosts, never as a precondition to check before
 * calling — a second dialability predicate living here would be a second
 * reading of a rule the dialer already owns. `unknown` in particular is *not*
 * offline; it means the cloud could not read its liveness store.
 *
 * There is deliberately **no `busy`**. The cloud host list carries no
 * drain state at all any more (it described a "right now" a minutes-scale
 * lease cannot carry), and projecting a fabricated `false` here would tell an
 * agent a machine is idle when nothing in the system knows that.
 *
 * **`commandInterpreter` is the LAST SUCCESSFULLY REPORTED one**, and `null`
 * means unknown with no fallback. It answers "what shell dialect should I
 * write this command in for that machine?", which `platform` cannot: on
 * Windows the same command meets Git Bash, PowerShell or cmd depending on
 * what the user configured, and only that host knows which. Do NOT infer it
 * from `platform` when it is null — that inference is the defect this field
 * exists to remove. It can lag a Settings change, a shell installation, or an
 * offline period, and it describes a NEWLY resolved command only: an
 * already-persisted managed command keeps the interpreter it was created with.
 *
 * `publicKey` is **not** projected: it is the dialer's Noise material, not
 * something an agent has any use for.
 *
 * `platform` is passed through as the cloud's free-text string (it is what
 * feeds the desktop host directory). Do not narrow it to an enum here — the
 * value's shape is authn's to define, and an enum would drift the moment it
 * writes something new. It is NOT how an agent learns which shell a command
 * will meet: that is `commandInterpreter`, and the claim that `platform`
 * answers it was only ever true on POSIX.
 */
export const hostDirectoryEntrySchema = lazySchema(() =>
  z.object({
    hostId: z.string(),
    displayName: z.string().nullable(),
    platform: z.string().nullable(),
    appVersion: z.string().nullable(),
    connectivity: hostConnectivitySchema,
    commandInterpreter: hostCommandInterpreterSchema.nullable(),
  }),
);
export type HostDirectoryEntrySummary = z.infer<
  typeof hostDirectoryEntrySchema
>;

export const hostDirectoryListRequestSchema = lazySchema(() => z.object({}));
export type HostDirectoryListRequest = z.infer<
  typeof hostDirectoryListRequestSchema
>;

export const hostDirectoryListResponseSchema = lazySchema(() =>
  z.object({
    hosts: z.array(hostDirectoryEntrySchema),
  }),
);
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
export const hostFileCopyOverwriteSchema = lazySchema(() =>
  z.enum(["overwrite", "skip-existing"]),
);
export type HostFileCopyOverwrite = z.infer<typeof hostFileCopyOverwriteSchema>;

export const hostFileCopyStartRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    sourceHostId: z.string().min(1).nullable(),
    sourcePath: z.string().min(1),
    destinationPath: z.string().min(1),
    exclude: z.array(z.string().min(1)),
    overwrite: hostFileCopyOverwriteSchema.default("overwrite"),
  }),
);
export type HostFileCopyStartRequest = z.infer<
  typeof hostFileCopyStartRequestSchema
>;

export const hostFileCopyStartResponseSchema = lazySchema(() =>
  z.object({
    jobId: z.string().min(1),
  }),
);
export type HostFileCopyStartResponse = z.infer<
  typeof hostFileCopyStartResponseSchema
>;

export const hostFileCopyStartV10 = defineRpcContract({
  method: "host.fileCopy.start",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileCopyStartRequestSchema,
  responseSchema: hostFileCopyStartResponseSchema,
});

export const hostFileCopyProgressSchema = lazySchema(() =>
  z.object({
    filesCompleted: z.number().int().nonnegative(),
    bytesTransferred: z.number().int().nonnegative(),
  }),
);
export type HostFileCopyProgress = z.infer<typeof hostFileCopyProgressSchema>;

export const HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH = 1024;

/**
 * Conventional PATH_MAX-style ceiling for source-authored path strings on the
 * agent-facing manifest. Relative paths and skipped-symlink targets are
 * attacker-influenced filesystem strings; bounding them is the same discipline
 * as bounding `message`.
 */
export const HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH = 4096;

export const hostFileCopyFailureOperationSchema = lazySchema(() =>
  z.enum([
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
  ]),
);
export type HostFileCopyFailureOperation = z.infer<
  typeof hostFileCopyFailureOperationSchema
>;

/**
 * Sampled failure items reach agent context through status. `message` shares
 * the unreadable/reason bound; `relativePath` uses the path ceiling.
 */
export const hostFileCopyFailureSchema = lazySchema(() =>
  z.object({
    relativePath: z.string().max(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH),
    operation: hostFileCopyFailureOperationSchema,
    message: z.string().max(HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH),
  }),
);
export type HostFileCopyFailure = z.infer<typeof hostFileCopyFailureSchema>;

export const hostFileCopySkippedUnsafeSymlinkSchema = lazySchema(() =>
  z.object({
    relativePath: z.string().max(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH),
    target: z.string().max(HOST_FILE_COPY_MANIFEST_PATH_MAX_LENGTH),
  }),
);
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

export const hostFileCopyManifestSummarySchema = lazySchema(() =>
  z.object({
    filesCopied: z.number().int().nonnegative(),
    directoriesCreated: z.number().int().nonnegative(),
    symlinksCreated: z.number().int().nonnegative(),
    bytesCopied: z.number().int().nonnegative(),
    replacements: z.number().int().nonnegative(),
    skippedExisting: z.number().int().nonnegative(),
  }),
);
export type HostFileCopyManifestSummary = z.infer<
  typeof hostFileCopyManifestSummarySchema
>;

/**
 * `failureCount` and `skippedUnsafeSymlinkCount` are exact. Their item arrays
 * are separately capped samples, with the omitted counts explicit, because
 * deriving totals from an unbounded item list would make large failures
 * impossible to report through one unary status response. The object refine
 * enforces that each count equals its sample length plus omitted remainder.
 */
export const hostFileCopyManifestSchema = lazySchema(() =>
  z
    .object({
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
    })
    .superRefine((manifest, ctx) => {
      if (
        manifest.failureCount !==
        manifest.failures.length + manifest.failuresOmitted
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failureCount"],
          message: "failureCount must equal failures.length + failuresOmitted",
        });
      }
      if (
        manifest.skippedUnsafeSymlinkCount !==
        manifest.skippedUnsafeSymlinks.length +
          manifest.skippedUnsafeSymlinksOmitted
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skippedUnsafeSymlinkCount"],
          message:
            "skippedUnsafeSymlinkCount must equal skippedUnsafeSymlinks.length + skippedUnsafeSymlinksOmitted",
        });
      }
    }),
);
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
const hostFileCopyFailureReasonSchema = lazySchema(() =>
  z.object({
    operation: hostFileCopyFailureOperationSchema,
    message: z.string().max(HOST_FILE_TRANSFER_UNREADABLE_MESSAGE_MAX_LENGTH),
  }),
);

const hostFileCopyNoFailureReasonField = {
  reason: lazySchema(() => z.never().optional()),
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
export const hostFileCopyStatusResponseSchema = lazySchema(() =>
  z.discriminatedUnion("state", [
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
  ]),
);
export type HostFileCopyStatusResponse = z.infer<
  typeof hostFileCopyStatusResponseSchema
>;

export const hostFileCopyStatusRequestSchema = lazySchema(() =>
  z.object({
    jobId: z.string().min(1),
  }),
);
export type HostFileCopyStatusRequest = z.infer<
  typeof hostFileCopyStatusRequestSchema
>;

export const hostFileCopyStatusV10 = defineRpcContract({
  method: "host.fileCopy.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileCopyStatusRequestSchema,
  responseSchema: hostFileCopyStatusResponseSchema,
});

export const hostFileCopyCancelRequestSchema = lazySchema(() =>
  z.object({
    jobId: z.string().min(1),
  }),
);
export type HostFileCopyCancelRequest = z.infer<
  typeof hostFileCopyCancelRequestSchema
>;

export const hostFileCopyCancelResponseSchema = lazySchema(() =>
  z.object({
    accepted: z.boolean(),
  }),
);
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
  relativePath: lazySchema(() => z.string()),
  /** Permission and special mode bits; file-type bits are excluded. */
  mode: lazySchema(() => z.number().int().nonnegative().max(0o7777)),
  mtimeMs: lazySchema(() => z.number().finite()),
} as const;

const hostFileTransferUnreadableOperationSchema = lazySchema(() =>
  hostFileCopyFailureOperationSchema.extract(["stat", "readlink", "readdir"]),
);

/**
 * The source walk computes symlink safety against the transferred tree's
 * boundary. `safety` is therefore an authoritative fact carried to the
 * destination, not a hint for the destination to re-derive. Unsafe means an
 * absolute target or `..` resolution escaping the transferred tree (rsync
 * `--safe-links` semantics).
 */
export const hostFileTransferEntrySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
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
  ]),
);
export type HostFileTransferEntry = z.infer<typeof hostFileTransferEntrySchema>;

/**
 * Source paths are epic-scoped at enumeration and open. Once open succeeds,
 * the handle pins the authorized descriptor: read and close intentionally do
 * not re-authorize its epic scope or imply the descriptor is re-derivable.
 */
export const hostFileTransferEnumerateRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    sourcePath: z.string().min(1),
    exclude: z.array(z.string().min(1)),
    cursor: z.string().min(1).nullable(),
  }),
);
export type HostFileTransferEnumerateRequest = z.infer<
  typeof hostFileTransferEnumerateRequestSchema
>;

export const hostFileTransferEnumerateResponseSchema = lazySchema(() =>
  z.object({
    entries: z
      .array(hostFileTransferEntrySchema)
      .max(HOST_FILE_TRANSFER_ENUMERATE_PAGE_SIZE),
    nextCursor: z.string().min(1).nullable(),
  }),
);
export type HostFileTransferEnumerateResponse = z.infer<
  typeof hostFileTransferEnumerateResponseSchema
>;

export const hostFileTransferEnumerateV10 = defineRpcContract({
  method: "host.fileTransfer.enumerate",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileTransferEnumerateRequestSchema,
  responseSchema: hostFileTransferEnumerateResponseSchema,
});

export const hostFileTransferOpenRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    sourcePath: z.string().min(1),
    relativePath: z.string(),
  }),
);
export type HostFileTransferOpenRequest = z.infer<
  typeof hostFileTransferOpenRequestSchema
>;

export const hostFileTransferOpenResponseSchema = lazySchema(() =>
  z.object({
    handleId: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  }),
);
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
 * carries canonical base64, so this expands to
 * `HOST_FILE_TRANSFER_MAX_CHUNK_BASE64_CHARS` characters before JSON
 * framing. Raise this only against the encoded size and transport budgets,
 * never by reasoning from raw bytes alone.
 */
export const HOST_FILE_TRANSFER_MAX_CHUNK_BYTES = 512 * 1024;

/** Canonical base64 length of `HOST_FILE_TRANSFER_MAX_CHUNK_BYTES`. */
export const HOST_FILE_TRANSFER_MAX_CHUNK_BASE64_CHARS =
  Math.ceil(HOST_FILE_TRANSFER_MAX_CHUNK_BYTES / 3) * 4;

export const hostFileTransferReadChunkRequestSchema = lazySchema(() =>
  z.object({
    handleId: z.string().min(1),
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive().max(HOST_FILE_TRANSFER_MAX_CHUNK_BYTES),
  }),
);
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
export const hostFileTransferReadChunkResponseSchema = lazySchema(() =>
  z.object({
    bytesBase64: z.base64().max(HOST_FILE_TRANSFER_MAX_CHUNK_BASE64_CHARS),
    bytesRead: z
      .number()
      .int()
      .nonnegative()
      .max(HOST_FILE_TRANSFER_MAX_CHUNK_BYTES),
    eof: z.boolean(),
  }),
);
export type HostFileTransferReadChunkResponse = z.infer<
  typeof hostFileTransferReadChunkResponseSchema
>;

export const hostFileTransferReadChunkV10 = defineRpcContract({
  method: "host.fileTransfer.readChunk",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileTransferReadChunkRequestSchema,
  responseSchema: hostFileTransferReadChunkResponseSchema,
});

export const hostFileTransferCloseRequestSchema = lazySchema(() =>
  z.object({
    handleId: z.string().min(1),
  }),
);
export type HostFileTransferCloseRequest = z.infer<
  typeof hostFileTransferCloseRequestSchema
>;

export const hostFileTransferCloseResponseSchema = lazySchema(() =>
  z.object({
    closed: z.boolean(),
  }),
);
export type HostFileTransferCloseResponse = z.infer<
  typeof hostFileTransferCloseResponseSchema
>;

export const hostFileTransferCloseV10 = defineRpcContract({
  method: "host.fileTransfer.close",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostFileTransferCloseRequestSchema,
  responseSchema: hostFileTransferCloseResponseSchema,
});

/**
 * Everything the target host needs to know about a creating agent that lives
 * on ANOTHER machine — resolved on the sending host, where the sender's own
 * record is authoritative, and carried in the request.
 *
 * `agent.create`'s target-side path resolves these from its OWN storage. That
 * is correct for a local sender and unfixable for a remote one: replica
 * presence is feed-driven, so the target need not hold the sender's chat
 * record at all, and even when it does the create path refuses a sender whose
 * `hostId` is not the target's. Both failures are the sender being looked up
 * in the wrong place, so the facts travel instead.
 *
 * The arms mirror the create service's own `SenderAgent` field for field —
 * they ARE its type — so what inheritance reads locally and what crosses the
 * wire cannot drift. A GUI sender contributes its run-settings tuple
 * (harness, model, permission mode, reasoning effort, service tier, agent
 * mode, profile), `null` when the record carries none; a TUI sender
 * contributes the launch tuple `agent.create` inherits from.
 *
 * `hostId` is the ORIGIN host of the sender, and it is not taken on trust: the
 * target requires it to equal the dialing principal's `originHostId`, so a
 * dialed host may only ever speak for its own agents.
 */
export const hostAgentRemoteSenderFactsSchema = lazySchema(() =>
  z.discriminatedUnion("surface", [
    z.object({
      surface: z.literal("gui"),
      hostId: z.string().min(1),
      settings: chatRunSettingsStrictSchema.nullable(),
    }),
    z.object({
      surface: z.literal("tui"),
      hostId: z.string().min(1),
      harnessId: tuiHarnessIdSchema,
      model: z.string().nullable(),
      reasoningEffort: z.string().nullable(),
      agentMode: agentModeSchema,
      profileId: z.string().nullable(),
    }),
  ]),
);
export type HostAgentRemoteSenderFacts = z.infer<
  typeof hostAgentRemoteSenderFactsSchema
>;

/**
 * Dial-only create. `agent.create@3.0` is a RELEASED client contract and
 * cannot grow a field, so the sender-facts envelope lives here, on the
 * host-agent optional channel, where it is free to change in place.
 *
 * The v3.0 request is EXTENDED rather than nested for two reasons, both
 * load-bearing:
 *
 *  - `defineEditorResolver` and the comm-graph's host-agent verb capture both
 *    read `params.epicId` at the TOP level. A nested request would have to
 *    repeat `epicId` beside it, and two copies of one id is a disagreement
 *    waiting to be authorized against the wrong one.
 *  - the extension is a new schema object; the released v3.0 shape it is
 *    derived from is untouched, exactly as v3.0 itself extends v2.0.
 *
 * `workspaceIntent` rides along for the same reason the facts do:
 * "folderless" has no encoding in the released create params (the local path
 * passes it to the service as an argument), so without a field here a
 * cross-host folderless create would silently reach the target as
 * inherit-from-parent — and the parent it would try to inherit from is the
 * record the target does not have.
 */
export const hostAgentCreateFromRemoteSenderRequestSchema = lazySchema(() =>
  createAgentRequestSchemaV30.extend({
    senderFacts: hostAgentRemoteSenderFactsSchema,
    workspaceIntent: z.literal("folderless").nullable(),
  }),
);
export type HostAgentCreateFromRemoteSenderRequest = z.infer<
  typeof hostAgentCreateFromRemoteSenderRequestSchema
>;

export const hostAgentCreateFromRemoteSenderV10 = defineRpcContract({
  method: "host.agent.createFromRemoteSender",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostAgentCreateFromRemoteSenderRequestSchema,
  // Same response as `agent.create`: the created agent's id plus resolution
  // warnings. The caller briefs it with `agent.sendMessage`, which already
  // routes cross-host.
  responseSchema: createAgentResponseSchema,
});

/**
 * Which A2A registration a routed browser cell belongs to, as claims.
 *
 * The target REBUILDS the caller's registration key from `sessionKeyTag` plus
 * `chatId` with the same tagged constructors the origin used, rather than
 * accepting a composed key on the wire: that key is the namespace deciding
 * which realm a cell enters, and a peer able to spell one directly could name
 * another registration's realm. `chatId` is the bare id both tagged
 * constructors take — a GUI chat's id, or a terminal agent's id — and the
 * origin proves that before it dials by rebuilding the key and comparing it
 * with the one it holds.
 *
 * `userId` and the origin host id are NOT here: both come from the dialed
 * session's principal, never from the request.
 */
export const browserReplCallerSchema = lazySchema(() =>
  z.object({
    sessionKeyTag: z.enum(["chat", "terminal-agent"]),
    chatId: z.string().min(1),
    agentRunId: z.string().nullable(),
  }),
);
export type BrowserReplCaller = z.infer<typeof browserReplCallerSchema>;

/**
 * One realm's identity, minted by the ORIGIN at realm birth and carried on
 * every call about that realm.
 *
 * It is the fence that lets the target tell a straggler from new work, which
 * the owner key alone cannot: a unary call issued before a release can arrive
 * after it, and re-admitting it would resurrect a realm whose credential is
 * already revoked.
 *
 * ORDERED rather than opaque, so the target can keep one "highest seen"
 * number per owner key instead of a set of tombstones with a lifetime. A
 * lifetime would be a guess about how long a straggler can live, and a call
 * parked in a role check on the origin can outlive any such guess.
 *
 * `incarnation` is a RANDOM id minted once per origin process, deliberately
 * not a boot timestamp: a wall clock that steps backwards between two
 * restarts would make every epoch of the newer process look older than the
 * dead one's, and the target would refuse the live agent forever. Ordering is
 * never compared across incarnations: the target adopts an incarnation it has
 * not seen as current for that owner, retiring whatever it held, and refuses
 * every incarnation it has moved on from - so a restarted origin is admitted
 * on its first call and the dead process's stragglers are fenced for good.
 * Whether an unseen incarnation is really the newer process is answered by
 * its carrying session, which the target checks last. `counter` orders
 * realms within one incarnation.
 */
const browserRealmEpochSchema = lazySchema(() =>
  z.object({
    incarnation: z.string().min(1),
    counter: z.number().int().positive(),
  }),
);
export type BrowserRealmEpochWire = z.infer<typeof browserRealmEpochSchema>;

/**
 * Which cell within the epoch. A stop must name the cell it means: a stop the
 * caller gave up on stays alive in the session (the transport races a call
 * against a signal, it does not cancel it) and can arrive after the cell it
 * named has finished, where it would otherwise interrupt that cell's
 * successor.
 */
const browserReplCellSequenceSchema = lazySchema(() =>
  z.number().int().positive(),
);

export const browserReplRunCellRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    title: z.string().min(1),
    code: z.string().min(1),
    caller: browserReplCallerSchema,
    realmEpoch: browserRealmEpochSchema,
    cellSequence: browserReplCellSequenceSchema,
  }),
);
export type BrowserReplRunCellRequest = z.infer<
  typeof browserReplRunCellRequestSchema
>;

/**
 * One block of the cell's `CallToolResult`, carried verbatim so the agent's
 * host re-emits what the browser's host produced rather than re-rendering it.
 * The MCP result has exactly these two block kinds on this path: the text
 * block (cell output plus its `[hint]` / `[notice]` / `[state]` lines) and the
 * screenshot attachments.
 */
export const browserReplCellContentSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.string().min(1),
    }),
  ]),
);
export type BrowserReplCellContent = z.infer<
  typeof browserReplCellContentSchema
>;

/**
 * `sessionsUsed` exists because `onSessionUsed` cannot run on the target: it
 * writes a reference into the AGENT'S chat, which lives on the origin host.
 * The references are collected here and written there, already stamped with
 * this host's `hostId` — a session id is host-local, so the stamp is what
 * makes the reference resolvable at all.
 */
export const browserReplRunCellResponseSchema = lazySchema(() =>
  z.object({
    content: z.array(browserReplCellContentSchema),
    isError: z.boolean(),
    sessionsUsed: z.array(browserSessionReferenceSchema),
    /** How this host names itself, for the `[state]` line the agent reads. */
    machineName: z.string().min(1),
  }),
);
export type BrowserReplRunCellResponse = z.infer<
  typeof browserReplRunCellResponseSchema
>;

export const browserReplRunCellV10 = defineRpcContract({
  method: "browser.repl.runCell",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserReplRunCellRequestSchema,
  responseSchema: browserReplRunCellResponseSchema,
});

/**
 * Retires a routed realm on the browser's host: context, adapters, tab leases
 * and the cell child process. Sent when the agent's A2A registration is
 * released, which is the same deterministic signal a local realm is retired
 * on.
 *
 * Idempotent, and that is load-bearing rather than merely tidy: the origin
 * keeps owed releases until one is ANSWERED, and retries them against targets
 * that may have restarted or already released. An unknown epoch is therefore
 * a success — the obligation is discharged either way — so `released` reports
 * whether this call found a live realm, never whether the caller may stop
 * asking.
 *
 * It is also a FLOOR rather than a tombstone for one value: it retires every
 * epoch at or below `realmEpoch` for that owner key, whether or not that epoch
 * ever reached this machine, so nothing below it can execute afterwards.
 */
export const browserReplReleaseRealmRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    caller: browserReplCallerSchema,
    realmEpoch: browserRealmEpochSchema,
  }),
);
export type BrowserReplReleaseRealmRequest = z.infer<
  typeof browserReplReleaseRealmRequestSchema
>;

export const browserReplReleaseRealmResponseSchema = lazySchema(() =>
  z.object({
    released: z.boolean(),
  }),
);
export type BrowserReplReleaseRealmResponse = z.infer<
  typeof browserReplReleaseRealmResponseSchema
>;

export const browserReplReleaseRealmV10 = defineRpcContract({
  method: "browser.repl.releaseRealm",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserReplReleaseRealmRequestSchema,
  responseSchema: browserReplReleaseRealmResponseSchema,
});

/**
 * Interrupts the cell running in a routed realm, so the Stop the user presses
 * on the agent's machine reaches the machine the cell is actually on.
 *
 * Without it Stop reports `idle` — truthfully about the agent's own host,
 * which holds no owner for a routed realm — while the cell keeps driving a
 * browser in front of the user. That is worse than not routing at all, which
 * is why this is the third verb rather than a follow-up.
 *
 * The response is the target's OWN stop status, unchanged: `idle` (nothing was
 * running), `stopped` (the cell was interrupted and nothing is still in an
 * adapter call), `outcome_unknown` (interrupted, but a raw adapter call may
 * still be in flight there). There is deliberately no fourth value here for
 * "the machine could not be reached": that is not something the target can
 * ever say about itself, so it is minted by the ORIGIN when this dial fails
 * and never travels on the wire.
 */
export const browserReplStopCellRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    caller: browserReplCallerSchema,
    realmEpoch: browserRealmEpochSchema,
    /** The cell this stop means; see {@link browserReplCellSequenceSchema}. */
    cellSequence: browserReplCellSequenceSchema,
  }),
);
export type BrowserReplStopCellRequest = z.infer<
  typeof browserReplStopCellRequestSchema
>;

export const browserReplStopCellResponseSchema = lazySchema(() =>
  z.object({
    status: z.enum(["idle", "stopped", "outcome_unknown"]),
  }),
);
export type BrowserReplStopCellResponse = z.infer<
  typeof browserReplStopCellResponseSchema
>;

export const browserReplStopCellV10 = defineRpcContract({
  method: "browser.repl.stopCell",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserReplStopCellRequestSchema,
  responseSchema: browserReplStopCellResponseSchema,
});

/**
 * The dial BACK: a cell suspended on the browser's host asks the agent's host
 * for a person's decision, because the approval card belongs in the agent's
 * chat and that chat lives on the agent's machine. The browser's host is the
 * caller here and the agent's host resolves it, the reverse of every other
 * verb in this family.
 *
 * The request names the cell asking - the same `(caller, realmEpoch,
 * cellSequence)` the cell verb carried in - and the agent's host answers only
 * for the cell it currently has in flight on the asking host. A realm it has
 * already re-homed or released cannot raise a card, however late its question
 * arrives.
 *
 * The cell stays suspended on the browser's host until this answers, bounded
 * by the cell's own deadline there rather than by anything of its own: the
 * approval wait has no deadline of its own on a local realm either.
 */
export const browserReplApprovalSchema = lazySchema(() =>
  z.object({
    approvalId: z.string().min(1),
    toolName: z.string().min(1),
    description: z.string(),
    /** The card's input, as the confirmation surface on the origin renders it. */
    input: z.record(z.string(), z.unknown()).nullable(),
  }),
);
export type BrowserReplApproval = z.infer<typeof browserReplApprovalSchema>;

export const browserReplRequestApprovalRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    caller: browserReplCallerSchema,
    realmEpoch: browserRealmEpochSchema,
    /** The cell asking; see {@link browserReplCellSequenceSchema}. */
    cellSequence: browserReplCellSequenceSchema,
    approval: browserReplApprovalSchema,
  }),
);
export type BrowserReplRequestApprovalRequest = z.infer<
  typeof browserReplRequestApprovalRequestSchema
>;

/**
 * A DELIVERED decision. `approved: false` is a person's (or the origin's
 * policy's) "no"; a question the origin will not answer at all - no such cell
 * in flight, the registration gone - is a refusal thrown on the wire, never
 * a fabricated decision.
 */
export const browserReplRequestApprovalResponseSchema = lazySchema(() =>
  z.object({
    approved: z.boolean(),
    reason: z.string().nullable(),
  }),
);
export type BrowserReplRequestApprovalResponse = z.infer<
  typeof browserReplRequestApprovalResponseSchema
>;

export const browserReplRequestApprovalV10 = defineRpcContract({
  method: "browser.repl.requestApproval",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: browserReplRequestApprovalRequestSchema,
  responseSchema: browserReplRequestApprovalResponseSchema,
});
