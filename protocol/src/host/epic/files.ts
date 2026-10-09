import { z } from "zod";

import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { epicLaneRowRevisionFields } from "@traycer/protocol/host/epic/lane-cursor";
import {
  EPIC_FILE_SHA256_PATTERN,
  epicFileEntrySchema,
} from "@traycer/protocol/persistence/epic/files";

/**
 * Host <-> client wire shapes for the epic files plane.
 *
 * Every byte a client renders comes through these methods (or a signed https
 * URL they hand out), never through a loopback URL, so the same calls work for
 * a co-located GUI, over the relay, on mobile and with the cloud offline.
 *
 * ## Optional capability
 *
 * Every method here is registered `degrade: { kind: "unsupported" }` and is
 * NOT on the released floor: a new method name is handshake-fatal against a
 * released peer. A host that predates the files plane answers
 * `E_HOST_UNSUPPORTED`, and the client hides the surface.
 */

/** Lowercase hex sha256 - the only form a content address is written in. */
const epicFileSha256Schema = lazySchema(() =>
  z.string().regex(EPIC_FILE_SHA256_PATTERN),
);

/** Largest text answer `epic.readFile` gives. */
export const EPIC_READ_FILE_TEXT_MAX_BYTES = 25 * 1024 * 1024;
/** Largest byte span one `range` read may ask for. */
export const EPIC_READ_FILE_RANGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The transcript row a page was opened from. The host decides the page's
 * network policy from it (and from facts only the host holds), never from the
 * shared manifest. `null` for an open with no row behind it: the Files panel or
 * a tile.
 */
export const epicFileViaSchema = lazySchema(() =>
  z.object({
    chatId: z.string().min(1),
    blockId: z.string().min(1),
  }),
);
export type EpicFileVia = z.infer<typeof epicFileViaSchema>;

/**
 * What a page may reach. `open` only for the author's own page, opened from
 * the row the author's chat stamped; `https-only` for everything else. The
 * host decides it; the client passes it to the loader unchanged.
 */
export const epicFileNetworkPolicySchema = lazySchema(() =>
  z.enum(["open", "https-only"]),
);
export type EpicFileNetworkPolicy = z.infer<typeof epicFileNetworkPolicySchema>;

/**
 * Why a file's bytes cannot be served right now. DATA, not a throw: a
 * transient failure (a dropped socket, an unreadable disk) rides the RPC error
 * channel instead, so a client retries it rather than caching a miss.
 *
 * - `not-downloaded` - bigger than the eager-mirror limit and not on this host
 *   yet; `epic.fetchFile` downloads it.
 * - `upload-pending` - a signed URL was asked for before the upload landed.
 * - `local-only` - the epic has no cloud home, so the file was never uploaded.
 * - `missing` - no such path and sha in this epic.
 * - `failed` - the upload or the download failed for good.
 */
export const epicFileUnavailableReasonSchema = lazySchema(() =>
  z.enum([
    "not-downloaded",
    "upload-pending",
    "local-only",
    "missing",
    "failed",
  ]),
);
export type EpicFileUnavailableReason = z.infer<
  typeof epicFileUnavailableReasonSchema
>;

const epicFileUnavailableSchema = lazySchema(() =>
  z.object({
    kind: z.literal("unavailable"),
    reason: epicFileUnavailableReasonSchema,
  }),
);

/** The bytes addressed: a path AND the sha the caller expects to find there. */
const epicFileAddressFields = {
  epicId: lazySchema(() => z.string().min(1)),
  path: lazySchema(() => z.string().min(1)),
  sha256: epicFileSha256Schema,
};

// ─── epic.readFile ─────────────────────────────────────────────────────────

/**
 * What the caller wants back:
 *
 * - `text` - the whole file as text, for `text/html` and `text/*` up to
 *   {@link EPIC_READ_FILE_TEXT_MAX_BYTES} (pages, MCP App snapshots, text
 *   files). The only arm that carries a network policy.
 * - `range` - a byte span of at most {@link EPIC_READ_FILE_RANGE_MAX_BYTES}
 *   (images and PDFs into a Blob, unpublished video, Download).
 * - `url` - a signed https URL, once the file is published (video seek, large
 *   downloads).
 */
export const epicReadFileWantSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text") }),
    z.object({
      kind: z.literal("range"),
      offset: z.number().int().nonnegative(),
      length: z.number().int().positive().max(EPIC_READ_FILE_RANGE_MAX_BYTES),
    }),
    z.object({ kind: z.literal("url") }),
  ]),
);
export type EpicReadFileWant = z.infer<typeof epicReadFileWantSchema>;

export const epicReadFileRequestSchema = lazySchema(() =>
  z.object({
    ...epicFileAddressFields,
    via: epicFileViaSchema.nullable(),
    want: epicReadFileWantSchema,
  }),
);
export type EpicReadFileRequest = z.infer<typeof epicReadFileRequestSchema>;

export const epicReadFileResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text"),
      text: z.string(),
      mediaType: z.string(),
      networkPolicy: epicFileNetworkPolicySchema,
    }),
    z.object({
      kind: z.literal("bytes"),
      /** Base64 of the raw bytes from `offset` - see `epic.readChatAttachment`. */
      bytesBase64: z.string(),
      offset: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      mediaType: z.string(),
    }),
    z.object({
      kind: z.literal("url"),
      url: z.string().url(),
      /** Epoch ms. The client renews at 80 % of the lifetime. */
      expiresAt: z.number(),
    }),
    epicFileUnavailableSchema,
  ]),
);
export type EpicReadFileResponse = z.infer<typeof epicReadFileResponseSchema>;

export const epicReadFileV10 = defineRpcContract({
  method: "epic.readFile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicReadFileRequestSchema,
  responseSchema: epicReadFileResponseSchema,
});

// ─── epic.fetchFile / epic.cancelFetchFile ─────────────────────────────────

/**
 * The explicit "Download N MB" action for a file too big to mirror eagerly.
 * Progress shows on the files lane's `localState`, not in this answer.
 */
export const epicFetchFileRequestSchema = lazySchema(() =>
  z.object(epicFileAddressFields),
);
export type EpicFetchFileRequest = z.infer<typeof epicFetchFileRequestSchema>;

export const epicFetchFileResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /** Already on this host; nothing to do. */
    z.object({ kind: z.literal("present") }),
    /** A download is running (started now, or already running). */
    z.object({ kind: z.literal("downloading") }),
    epicFileUnavailableSchema,
  ]),
);
export type EpicFetchFileResponse = z.infer<typeof epicFetchFileResponseSchema>;

export const epicFetchFileV10 = defineRpcContract({
  method: "epic.fetchFile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicFetchFileRequestSchema,
  responseSchema: epicFetchFileResponseSchema,
});

export const epicCancelFetchFileRequestSchema = lazySchema(() =>
  z.object(epicFileAddressFields),
);
export type EpicCancelFetchFileRequest = z.infer<
  typeof epicCancelFetchFileRequestSchema
>;

export const epicCancelFetchFileResponseSchema = lazySchema(() =>
  z.object({
    /** `false` when no download of this file was running. */
    cancelled: z.boolean(),
  }),
);
export type EpicCancelFetchFileResponse = z.infer<
  typeof epicCancelFetchFileResponseSchema
>;

export const epicCancelFetchFileV10 = defineRpcContract({
  method: "epic.cancelFetchFile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicCancelFetchFileRequestSchema,
  responseSchema: epicCancelFetchFileResponseSchema,
});

// ─── epic.deleteFile / epic.restoreFile ────────────────────────────────────

/**
 * Delete only TOMBSTONES the path: it leaves the Files panel and
 * `files/.index.md`, but a transcript row still reads its bytes by sha. Restore
 * clears the tombstone.
 */
export const epicFileMutationRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    path: z.string().min(1),
  }),
);
export type EpicFileMutationRequest = z.infer<
  typeof epicFileMutationRequestSchema
>;

/**
 * - `missing` - no entry at that path (or, for restore, none tombstoned).
 * - `forbidden` - the caller may not edit this epic.
 */
const epicFileMutationRefusedSchema = lazySchema(() =>
  z.object({
    kind: z.literal("refused"),
    reason: z.enum(["missing", "forbidden"]),
  }),
);

export const epicDeleteFileResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("deleted") }),
    epicFileMutationRefusedSchema,
  ]),
);
export type EpicDeleteFileResponse = z.infer<
  typeof epicDeleteFileResponseSchema
>;

export const epicDeleteFileV10 = defineRpcContract({
  method: "epic.deleteFile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicFileMutationRequestSchema,
  responseSchema: epicDeleteFileResponseSchema,
});

export const epicRestoreFileResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("restored") }),
    epicFileMutationRefusedSchema,
  ]),
);
export type EpicRestoreFileResponse = z.infer<
  typeof epicRestoreFileResponseSchema
>;

export const epicRestoreFileV10 = defineRpcContract({
  method: "epic.restoreFile",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicFileMutationRequestSchema,
  responseSchema: epicRestoreFileResponseSchema,
});

// ─── epic.openFileInBrowser ────────────────────────────────────────────────

/**
 * A short-lived `http://127.0.0.1:<port>/page/<token>` URL for the in-app
 * browser tab. The browser runs on the host, so loopback resolves for a remote
 * GUI too. The token is bound to the file, the sha, the network policy and the
 * caller when it is minted.
 */
export const epicOpenFileInBrowserRequestSchema = lazySchema(() =>
  z.object({
    ...epicFileAddressFields,
    via: epicFileViaSchema.nullable(),
  }),
);
export type EpicOpenFileInBrowserRequest = z.infer<
  typeof epicOpenFileInBrowserRequestSchema
>;

export const epicOpenFileInBrowserResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("url"), url: z.string().url() }),
    epicFileUnavailableSchema,
  ]),
);
export type EpicOpenFileInBrowserResponse = z.infer<
  typeof epicOpenFileInBrowserResponseSchema
>;

export const epicOpenFileInBrowserV10 = defineRpcContract({
  method: "epic.openFileInBrowser",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: epicOpenFileInBrowserRequestSchema,
  responseSchema: epicOpenFileInBrowserResponseSchema,
});

// ─── The files arm of `epic.state.subscribe@1.2` ──────────────────────────

/**
 * Whether THIS host holds a file's bytes. Host-local: it describes the serving
 * host's disk, not the shared manifest, so it never syncs.
 */
export const epicFileLocalStateSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("present") }),
    z.object({ kind: z.literal("absent") }),
    z.object({
      kind: z.literal("downloading"),
      received: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  ]),
);
export type EpicFileLocalState = z.infer<typeof epicFileLocalStateSchema>;

/** One manifest entry as the lane carries it, tombstones included. */
export const epicStateFileRecordSchema = lazySchema(() =>
  z.object({
    path: z.string().min(1),
    entry: epicFileEntrySchema,
    localState: epicFileLocalStateSchema,
  }),
);
export type EpicStateFileRecord = z.infer<typeof epicStateFileRecordSchema>;

/**
 * The files projection on the records lane: a whole SET with one set revision,
 * the shape `roleClaims` uses. Apply a replacement only when its revision
 * strictly exceeds the one held.
 */
export const epicStateFilesProjectionSchema = lazySchema(() =>
  z.object({
    ...epicLaneRowRevisionFields,
    files: z.array(epicStateFileRecordSchema),
  }),
);
export type EpicStateFilesProjection = z.infer<
  typeof epicStateFilesProjectionSchema
>;

/**
 * The files arm as the `epic.state.subscribe@1.2` frames carry it: the same
 * set, but each record is read as `unknown` and decoded one at a time by
 * {@link decodeEpicStateFilesArm}. The manifest is lenient per ENTRY, so one
 * record this reader cannot parse (a bad path, a `localState` a newer host
 * added) must cost that record and not the frame - a strict array here would
 * fail the whole server frame and with it the epic's entire state lane. An
 * arm that is unreadable as a whole (a bad revision, a non-object) reads as
 * `null`, "no files arm", the way an `@1.1` frame does. Because `.catch`
 * also answers a missing key, the key is no longer required on `@1.2`.
 *
 * Decoding is a plain function and not a schema transform: protocol schemas
 * must stay representable in JSON Schema.
 */
export const epicStateFilesArmSchema = lazySchema(() =>
  z
    .object({
      ...epicLaneRowRevisionFields,
      files: z.array(z.unknown()),
    })
    .nullable()
    .catch(null),
);
export type EpicStateFilesArm = z.infer<typeof epicStateFilesArmSchema>;

/** Keeps the records of a files arm this reader can parse; `null` stays `null`. */
export function decodeEpicStateFilesArm(
  arm: EpicStateFilesArm | undefined,
): EpicStateFilesProjection | null {
  if (arm === undefined || arm === null) return null;
  const files: EpicStateFileRecord[] = [];
  for (const record of arm.files) {
    const parsed = epicStateFileRecordSchema.safeParse(record);
    if (parsed.success) files.push(parsed.data);
  }
  return { revision: arm.revision, files };
}
