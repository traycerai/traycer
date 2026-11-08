import { v4 as uuidv4 } from "uuid";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { FILE_ATTACHMENT_MAX_BYTES } from "@traycer/protocol/host/drafts/schemas";

import type { HostRpcRegistry } from "@/lib/host";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS } from "@/lib/drafts/draft-blob-transport-budget";
import { isDraftsCapabilityMissing } from "@/lib/drafts/draft-capability";
import { sha256Hex } from "@/lib/composer/landing-image-store";
import { bytesToBase64Async } from "@/lib/composer/image-base64";
import { formatByteSize } from "@/lib/format-byte-size";
import { appLogger, describeLogError } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

import {
  FILE_ATTACHMENT_FALLBACK_MEDIA_TYPE,
  type ComposerFileAttachmentAttrs,
} from "./file-attachments";

/** The `drafts.putBlob` minor that accepts `kind: "file"`. */
export const DRAFTS_PUT_BLOB_FILE_MINOR = 2;

const PUT_BLOB_FILE_FLOOR = {
  method: "drafts.putBlob",
  version: { major: 1, minor: DRAFTS_PUT_BLOB_FILE_MINOR },
} as const;

export type FileAttachmentUploadClient = Pick<
  HostRequester<HostRpcRegistry>,
  "requestWithOptions"
>;

/** The host a composer's files go to: the one its message will be sent on. */
export interface FileAttachmentUploadTarget {
  readonly hostId: string;
  readonly client: FileAttachmentUploadClient;
}

/**
 * Whether `hostId` can store a file. `"unknown"` before its handshake has
 * settled: the dispatch floor below is what decides then, so a picked file is
 * not refused on a guess.
 */
export function hostFileAttachmentSupport(
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
 * - `stored`: the host acknowledged the bytes; the node may drop its pending
 *   state.
 * - `failed`: refused or lost; the node is removed and a toast said why.
 * - `cancelled`: the person removed the node first.
 *
 * Kept outside the editor because an upload outlives the composer that started
 * it: a tab switch unmounts the editor, and a 16 MiB upload over a relay is
 * still running when it comes back. The node view applies the outcome to the
 * document whenever it is mounted (`file-attachment-node-view.tsx`), so the
 * result lands in whichever editor shows the node next. A node no entry
 * describes is one this renderer never uploaded: a draft restored after a
 * reload, or one another device is still uploading.
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

function setUploadStatus(
  id: string,
  status: FileAttachmentUploadStatus,
  controller: AbortController,
): void {
  uploads.set(id, { status, controller });
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
  setUploadStatus(id, "cancelled", entry.controller);
  entry.controller.abort();
}

/**
 * ONE file on the wire at a time, across every composer in this renderer. A
 * 16 MiB file is about 22 MB of base64 string; two at once on a phone is the
 * memory spike this exists to prevent.
 */
let uploadQueue: Promise<void> = Promise.resolve();

function enqueueUpload(job: () => Promise<void>): void {
  const run = uploadQueue.then(job);
  uploadQueue = run.catch((error: unknown) => {
    appLogger.warn("[file-attachments] upload job failed", {
      error: describeLogError(error),
    });
  });
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

function showUploadFailedToast(file: File): void {
  reportableErrorToast(
    `Couldn't attach ${displayName(file)}.`,
    { description: "Please try adding it again." },
    {
      title: "Could not upload file attachment",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

/**
 * Why `file` cannot go to `target` at all, decided before any byte is read.
 * `null` admits it.
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

async function putFileBlob(
  target: FileAttachmentUploadTarget,
  file: File,
  attrs: ComposerFileAttachmentAttrs,
  signal: AbortSignal,
): Promise<PutOutcome> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    const bytesBase64 = await bytesToBase64Async(bytes);
    signal.throwIfAborted();
    const response = await target.client.requestWithOptions(
      "drafts.putBlob",
      {
        kind: "file",
        sha256: attrs.hash,
        bytesBase64,
        fileName: attrs.fileName,
        mediaType: attrs.mediaType,
      },
      {
        // Content-addressed: a transport replay of this body stores the same
        // bytes under the same digest.
        idempotencyKey: attrs.hash,
        responseTimeoutMs: DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS,
        // A host below `@1.2` strips `kind`, `fileName` and `mediaType` and
        // would store the bytes as an IMAGE blob or refuse them by the image
        // cap. The floor refuses the frame before it is sent instead, against
        // the handshake of the connection that would carry it.
        requiredHostMethodVersion: PUT_BLOB_FILE_FLOOR,
        signal,
      },
    );
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
 * Attach one already-admitted file: hash it, insert its pending node, and
 * queue the upload. Resolves once the node is in the document (or could not
 * be inserted); the upload's outcome reaches the document through the status
 * registry above.
 *
 * `insert` returns `false` when the editor is gone or not ready, and then
 * nothing is uploaded.
 */
export async function attachFileAttachment(input: {
  readonly file: File;
  readonly target: FileAttachmentUploadTarget;
  readonly insert: (attrs: ComposerFileAttachmentAttrs) => boolean;
}): Promise<void> {
  const { file, target, insert } = input;
  // `crypto.subtle` digests off the JS thread; the buffer is dropped as soon
  // as the hash exists and re-read for the upload, so a queued file does not
  // hold its bytes while it waits its turn.
  const sha256 = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
  const attrs: ComposerFileAttachmentAttrs = {
    id: uuidv4(),
    hash: sha256,
    fileName: displayName(file),
    mediaType:
      file.type.length > 0 ? file.type : FILE_ATTACHMENT_FALLBACK_MEDIA_TYPE,
    size: file.size,
    uploadState: "pending",
  };
  const controller = new AbortController();
  setUploadStatus(attrs.id, "uploading", controller);
  if (!insert(attrs)) {
    setUploadStatus(attrs.id, "cancelled", controller);
    return;
  }
  enqueueUpload(async () => {
    if (readFileAttachmentUploadStatus(attrs.id) !== "uploading") return;
    const outcome = await putFileBlob(target, file, attrs, controller.signal);
    if (readFileAttachmentUploadStatus(attrs.id) !== "uploading") return;
    if (outcome === "stored") {
      setUploadStatus(attrs.id, "stored", controller);
      return;
    }
    setUploadStatus(attrs.id, "failed", controller);
    if (outcome === "host-outdated") showHostOutdatedForFilesToast();
    else showUploadFailedToast(file);
  });
}
