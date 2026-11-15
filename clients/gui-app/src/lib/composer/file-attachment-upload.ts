import { v4 as uuidv4 } from "uuid";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { MAX_FILE_ATTACHMENTS_PER_MESSAGE } from "@traycer/protocol/common/file-attachment";
import {
  FILE_ATTACHMENT_MAX_BYTES,
  type DraftsPutBlobRequestV12,
  type DraftsPutBlobResponseV12,
} from "@traycer/protocol/host/drafts/schemas";

import type { HostRpcRegistry } from "@/lib/host";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { isDraftsCapabilityMissing } from "@/lib/drafts/draft-capability";
import { sha256Hex } from "@/lib/composer/landing-image-store";
import { bytesToBase64Async } from "@/lib/composer/image-base64";
import { formatByteSize } from "@/lib/format-byte-size";
import { appLogger, describeLogError } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

import {
  FILE_ATTACHMENT_FALLBACK_MEDIA_TYPE,
  type ComposerFileAttachmentAttrs,
  type FileNodeSettlement,
} from "./file-attachments";

/** The `drafts.putBlob` minor that accepts `kind: "file"`. */
const DRAFTS_PUT_BLOB_FILE_MINOR = 2;

/**
 * A host below `@1.2` strips `kind`, `fileName` and `mediaType` and would
 * store the bytes as an IMAGE blob or refuse them by the image cap. The floor
 * refuses the frame before it is sent instead, against the handshake of the
 * connection that would carry it.
 */
export const PUT_BLOB_FILE_FLOOR = {
  method: "drafts.putBlob",
  version: { major: 1, minor: DRAFTS_PUT_BLOB_FILE_MINOR },
} as const;

export type FileAttachmentUploadClient = HostRequester<HostRpcRegistry>;

/** A host files go to, and the client that reaches it. */
export interface FileAttachmentUploadTarget {
  readonly hostId: string;
  readonly client: FileAttachmentUploadClient;
}

export type FilePutRequest = Extract<DraftsPutBlobRequestV12, { kind: "file" }>;

export interface PutFileBlobVariables {
  readonly target: FileAttachmentUploadTarget;
  readonly request: FilePutRequest;
  readonly signal: AbortSignal;
}

/**
 * One `drafts.putBlob` of a file, dispatched through the surface's host
 * mutation (`useDraftsPutFileBlob`), which carries the file identity key, the `@1.2`
 * floor and the two-minute budget.
 */
export type PutFileBlob = (
  variables: PutFileBlobVariables,
) => Promise<DraftsPutBlobResponseV12>;

/**
 * Whether `hostId` can store a file. `"unknown"` before its handshake has
 * settled: the dispatch floor is what decides then, so a picked file is not
 * refused on a guess.
 */
function hostFileAttachmentSupport(
  hostId: string,
): "supported" | "outdated" | "unknown" {
  const version = readNegotiatedMethodVersion(hostId, "drafts.putBlob");
  if (version === null) return "unknown";
  if (version === false) return "outdated";
  return version.major === 1 && version.minor >= DRAFTS_PUT_BLOB_FILE_MINOR
    ? "supported"
    : "outdated";
}

/**
 * Where one file node's upload stands in THIS renderer.
 *
 * - `uploading`: queued or on the wire.
 * - `stored`: the host acknowledged the bytes; the node drops its pending
 *   state.
 * - `failed`: refused or lost; the node is removed and a toast said why.
 * - `cancelled`: the person removed the node first, or the draft moved on.
 *
 * Kept outside the editor because an upload outlives the composer that started
 * it: a tab switch unmounts the editor, and a 16 MiB upload over a relay is
 * still running when it comes back. The outcome is written into the draft
 * (`FileNodeSettle`) and applied by the node view to whichever editor shows
 * the node, whichever happens first.
 */
export type FileAttachmentUploadStatus =
  | "uploading"
  | "stored"
  | "failed"
  | "cancelled";

interface UploadEntry {
  readonly status: FileAttachmentUploadStatus;
  readonly controller: AbortController;
}

const uploads = new Map<string, UploadEntry>();
const listeners = new Set<() => void>();

function setUploadEntry(id: string, entry: UploadEntry): void {
  uploads.set(id, entry);
  for (const listener of listeners) listener();
}

export function readFileAttachmentUploadStatus(
  id: string,
): FileAttachmentUploadStatus | null {
  return uploads.get(id)?.status ?? null;
}

export function subscribeFileAttachmentUploads(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The person removed the node. An upload not yet started is skipped, and one
 * on the wire is abandoned; neither raises a toast.
 */
export function cancelFileAttachmentUpload(id: string): void {
  const entry = uploads.get(id);
  if (entry === undefined || entry.status !== "uploading") return;
  setUploadEntry(id, { ...entry, status: "cancelled" });
  entry.controller.abort();
}

/**
 * ONE file on the wire at a time, across every composer in this renderer. A
 * 16 MiB file is about 22 MB of base64 string; two at once on a phone is the
 * memory spike this exists to prevent.
 */
let uploadQueue: Promise<unknown> = Promise.resolve();

function runSerially<T>(job: () => Promise<T>): Promise<T> {
  const run = uploadQueue.then(job);
  uploadQueue = run.catch((error: unknown) => {
    appLogger.warn("[file-attachments] upload job failed", {
      error: describeLogError(error),
    });
  });
  return run;
}

function displayName(file: File): string {
  return file.name.length > 0 ? file.name : "file";
}

const TOAST_SOURCE = "Chat composer";

export function showFileTooLargeToast(file: File): void {
  reportableErrorToast(
    `${displayName(file)} is ${formatByteSize(file.size)}`,
    {
      description: `Files can be up to ${formatByteSize(FILE_ATTACHMENT_MAX_BYTES)}.`,
    },
    {
      title: "File exceeded the size limit",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

const TOO_MANY_FILES_DESCRIPTION = `A message can carry up to ${String(MAX_FILE_ATTACHMENTS_PER_MESSAGE)} files.`;

/** One toast for every file a pick or a paste had to leave out. */
export function showTooManyFilesToast(
  refusedNames: ReadonlyArray<string>,
): void {
  const first = refusedNames.at(0);
  if (first === undefined) return;
  reportableErrorToast(
    refusedNames.length === 1
      ? `Couldn't attach ${first.length > 0 ? first : "file"}.`
      : `Couldn't attach ${String(refusedNames.length)} files.`,
    { description: TOO_MANY_FILES_DESCRIPTION },
    {
      title: "File attachment count exceeded the limit",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

export function showHostOutdatedForFilesToast(): void {
  reportableErrorToast(
    "Couldn't attach the file.",
    { description: "Update this host to attach files." },
    {
      title: "Host does not accept file attachments",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

export function showNoHostForFilesToast(): void {
  reportableErrorToast(
    "Couldn't attach the file.",
    { description: "Connect to a host, then try again." },
    {
      title: "No host to attach files to",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

function showUploadFailedToast(fileName: string): void {
  reportableErrorToast(
    `Couldn't attach ${fileName}.`,
    { description: "Please try adding it again." },
    {
      title: "Could not upload file attachment",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

/** The toast's line for what a gesture left out; `null` when it left out nothing. */
function couldNotAttachMessage(names: ReadonlyArray<string>): string | null {
  const first = names.at(0);
  if (first === undefined) return null;
  return names.length === 1
    ? `Couldn't attach ${first}.`
    : `Couldn't attach ${String(names.length)} items.`;
}

/**
 * What a drop or paste left out of a chat whose agent runs on another
 * computer, where a typed path would name nothing: a folder, or an entry with
 * no bytes to send.
 */
export function showRemoteAttachRefusedToast(
  names: ReadonlyArray<string>,
): void {
  const message = couldNotAttachMessage(names);
  if (message === null) return;
  reportableErrorToast(
    message,
    {
      description: "This chat runs on another computer. Use the attach button.",
    },
    {
      title: "Could not attach to a chat on another computer",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

/** The same for an inline message edit on such a chat, which attaches nothing. */
export function showEditAttachRefusedToast(names: ReadonlyArray<string>): void {
  const message = couldNotAttachMessage(names);
  if (message === null) return;
  reportableErrorToast(
    message,
    {
      description:
        "Files can't be added while editing. Send them in a new message.",
    },
    {
      title: "Could not add files while editing",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

/**
 * Why `file` cannot go to `target` at all, decided before any byte is read.
 * `null` admits it. The per-message count is decided after hashing, by the
 * insertion, because only the hash says whether a file is a new one.
 */
export function refuseFileAttachment(
  file: File,
  target: FileAttachmentUploadTarget | null,
): "too-large" | "no-host" | "host-outdated" | null {
  if (file.size > FILE_ATTACHMENT_MAX_BYTES) return "too-large";
  if (target === null) return "no-host";
  if (hostFileAttachmentSupport(target.hostId) === "outdated") {
    return "host-outdated";
  }
  return null;
}

type PutOutcome = "stored" | "host-outdated" | "failed";

async function putFile(input: {
  readonly put: PutFileBlob;
  readonly target: FileAttachmentUploadTarget;
  readonly file: File;
  readonly identity: {
    readonly hash: string;
    readonly fileName: string;
    readonly mediaType: string;
  };
  readonly signal: AbortSignal;
}): Promise<PutOutcome> {
  const { put, target, file, identity, signal } = input;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    // Re-read, so a file whose bytes changed on disk since the pick is not
    // sent under the old digest; the host would refuse it anyway.
    if ((await sha256Hex(bytes)) !== identity.hash) return "failed";
    const bytesBase64 = await bytesToBase64Async(bytes);
    signal.throwIfAborted();
    const response = await put({
      target,
      request: {
        kind: "file",
        sha256: identity.hash,
        bytesBase64,
        fileName: identity.fileName,
        mediaType: identity.mediaType,
      },
      signal,
    });
    return response.ok ? "stored" : "failed";
  } catch (error: unknown) {
    if (signal.aborted) return "failed";
    if (
      error instanceof HostMethodVersionUnsatisfiedError ||
      isDraftsCapabilityMissing(error) ||
      (error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED")
    ) {
      return "host-outdated";
    }
    appLogger.warn("[file-attachments] putBlob failed", {
      error: describeLogError(error),
    });
    return "failed";
  }
}

/**
 * What an upload's outcome does to its node, wherever the node now lives: the
 * live editor if the composer is mounted, else the persisted draft, so a
 * restart cannot leave a finished upload looking unconfirmed. Supplied by the
 * surface, which alone knows its draft store.
 */
export type FileNodeSettle = (
  nodeId: string,
  settlement: FileNodeSettlement,
) => void;

/**
 * Puts a hashed file's node into the draft, or says why not:
 *
 * - `"over-cap"`: a NEW `(hash, fileName)` and the draft already carries the
 *   most files a message may. A file already in the draft adds no line to the
 *   agent's list, so it is never over the cap.
 * - `"dropped"`: the draft this pick was made in is gone - the editor was
 *   recreated, or a send or replacement moved it on - so the file is not put
 *   into whatever draft holds the editor now.
 */
export type FileInsertion = (
  attrs: ComposerFileAttachmentAttrs,
) => "inserted" | "over-cap" | "dropped";

/**
 * Attach one already-admitted file: hash it, insert its pending node, and
 * queue the upload. Resolves with the insertion's answer once the node is in
 * the draft (or is not going to be); the upload's outcome reaches the draft
 * through `settle` and the status registry above.
 */
export async function attachFileAttachment(input: {
  readonly file: File;
  readonly target: FileAttachmentUploadTarget;
  readonly put: PutFileBlob;
  readonly insert: FileInsertion;
  readonly settle: FileNodeSettle;
}): Promise<"inserted" | "over-cap" | "dropped"> {
  const { file, target, put, insert, settle } = input;
  // `crypto.subtle` digests off the JS thread; the buffer is dropped as soon
  // as the hash exists and re-read for the upload, so a queued file does not
  // hold its bytes while it waits its turn.
  const hash = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
  const attrs: ComposerFileAttachmentAttrs = {
    id: uuidv4(),
    hash,
    fileName: displayName(file),
    mediaType:
      file.type.length > 0 ? file.type : FILE_ATTACHMENT_FALLBACK_MEDIA_TYPE,
    size: file.size,
    uploadState: "pending",
  };
  const controller = new AbortController();
  setUploadEntry(attrs.id, { status: "uploading", controller });
  const placed = insert(attrs);
  if (placed !== "inserted") {
    setUploadEntry(attrs.id, { status: "cancelled", controller });
    return placed;
  }
  void runSerially(async () => {
    if (readFileAttachmentUploadStatus(attrs.id) !== "uploading") return;
    const outcome = await putFile({
      put,
      target,
      file,
      identity: attrs,
      signal: controller.signal,
    });
    if (readFileAttachmentUploadStatus(attrs.id) !== "uploading") return;
    if (outcome === "stored") {
      setUploadEntry(attrs.id, { status: "stored", controller });
      settle(attrs.id, { kind: "stored" });
      return;
    }
    // Removed, not left pending: no bytes are kept for a retry, so a pending
    // node could only ever be removed by hand.
    setUploadEntry(attrs.id, { status: "failed", controller });
    settle(attrs.id, { kind: "remove" });
    if (outcome === "host-outdated") showHostOutdatedForFilesToast();
    else showUploadFailedToast(attrs.fileName);
  });
  return "inserted";
}
