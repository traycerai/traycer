import { v4 as uuidv4 } from "uuid";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { MAX_FILE_ATTACHMENTS_PER_MESSAGE } from "@traycer/protocol/common/file-attachment";
import type { JsonContent } from "@traycer/protocol/common/registry";
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
  collectFileAttachmentNodes,
  countFileAttachments,
  FILE_ATTACHMENT_FALLBACK_MEDIA_TYPE,
  type ComposerFileAttachmentAttrs,
  type ComposerFileAttachmentNode,
  type FileNodeSettlement,
} from "./file-attachments";

/** The `drafts.putBlob` minor that accepts `kind: "file"`. */
export const DRAFTS_PUT_BLOB_FILE_MINOR = 2;

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
 * mutation (`useDraftsPutFileBlob`), which carries the digest key, the `@1.2`
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
 * - `stored`: the host acknowledged the bytes; the node drops its pending
 *   state and records the host.
 * - `failed`: refused or lost; the node is removed and a toast said why.
 * - `cancelled`: the person removed the node first, or the draft moved on.
 * - `reattach`: a send needed these bytes on a host that never got them, and
 *   this renderer no longer has them to upload.
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
  | "cancelled"
  | "reattach";

interface UploadEntry {
  readonly status: FileAttachmentUploadStatus;
  readonly controller: AbortController;
  /** The host the bytes were confirmed on; `null` until then. */
  readonly hostId: string | null;
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

/** The host a stored upload was confirmed on, for the node view to record. */
export function readFileAttachmentUploadHost(id: string): string | null {
  return uploads.get(id)?.hostId ?? null;
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
 * The picked files, by content hash, so a send to a host that never got them
 * can upload them there first. In memory only and never persisted: after a
 * reload a file whose host does not match the destination has to be attached
 * again. Bounded so a long session does not pin every file ever picked.
 */
const pickedFiles = new Map<string, File>();
const PICKED_FILES_RETAINED = 64;

function retainPickedFile(hash: string, file: File): void {
  pickedFiles.delete(hash);
  pickedFiles.set(hash, file);
  while (pickedFiles.size > PICKED_FILES_RETAINED) {
    const oldest = pickedFiles.keys().next();
    if (oldest.done === true) break;
    pickedFiles.delete(oldest.value);
  }
}

/**
 * Which hosts acknowledged which hashes in this renderer. Keyed by HOST, so a
 * placement change can never borrow another host's confirmation: the send
 * asks about its own destination, and a host it never asked has no entry.
 */
const confirmedHashesByHost = new Map<string, Set<string>>();

function recordConfirmed(hostId: string, hash: string): void {
  const hashes = confirmedHashesByHost.get(hostId);
  if (hashes === undefined) {
    confirmedHashesByHost.set(hostId, new Set([hash]));
    return;
  }
  hashes.add(hash);
}

/**
 * ONE file on the wire at a time, across every composer in this renderer. A
 * 16 MiB file is about 22 MB of base64 string; two at once on a phone is the
 * memory spike this exists to prevent. Attach-time uploads and send-time
 * re-uploads share it.
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
      ? `Couldn't attach ${first}.`
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

function showReattachToast(fileNames: ReadonlyArray<string>): void {
  const first = fileNames.at(0);
  if (first === undefined) return;
  reportableErrorToast(
    fileNames.length === 1
      ? `Attach ${first} again to send it.`
      : `Attach ${String(fileNames.length)} files again to send them.`,
    { description: "This host never received them." },
    {
      title: "File attachment needs to be attached again",
      message: null,
      code: null,
      source: TOAST_SOURCE,
    },
  );
}

function showTooManyFilesAtSendToast(): void {
  reportableErrorToast(
    "Too many files attached.",
    {
      description: `${TOO_MANY_FILES_DESCRIPTION} Remove some and send again.`,
    },
    {
      title: "File attachment count exceeded the limit",
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
    if (!response.ok) return "failed";
    recordConfirmed(target.hostId, identity.hash);
    return "stored";
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
 * live editor if the composer is mounted, else the persisted draft. Supplied by
 * the surface, which alone knows its draft store.
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
  /**
   * `false` keeps the bytes here and inserts the node ready, for a composer
   * whose send uploads to its destination itself once that host is awake.
   */
  readonly uploadAtAttach: boolean;
  readonly put: PutFileBlob;
  readonly insert: FileInsertion;
  readonly settle: FileNodeSettle;
}): Promise<"inserted" | "over-cap" | "dropped"> {
  const { file, target, uploadAtAttach, put, insert, settle } = input;
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
    uploadState: uploadAtAttach ? "pending" : null,
    uploadHostId: null,
  };
  if (!uploadAtAttach) {
    const placed = insert(attrs);
    if (placed === "inserted") retainPickedFile(hash, file);
    return placed;
  }
  const controller = new AbortController();
  setUploadEntry(attrs.id, { status: "uploading", controller, hostId: null });
  const placed = insert(attrs);
  if (placed !== "inserted") {
    setUploadEntry(attrs.id, { status: "cancelled", controller, hostId: null });
    return placed;
  }
  retainPickedFile(hash, file);
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
      setUploadEntry(attrs.id, {
        status: "stored",
        controller,
        hostId: target.hostId,
      });
      settle(attrs.id, { kind: "stored", hostId: target.hostId });
      return;
    }
    setUploadEntry(attrs.id, { status: "failed", controller, hostId: null });
    settle(attrs.id, { kind: "remove" });
    if (outcome === "host-outdated") showHostOutdatedForFilesToast();
    else showUploadFailedToast(attrs.fileName);
  });
  return "inserted";
}

/**
 * Whether a send of `content` to `hostId` may go without the async file step:
 * it carries no file, or every file is within the cap, settled, and already
 * confirmed on `hostId`. The synchronous gate a surface checks before deciding
 * to await {@link ensureFileAttachmentsOnHost}, and re-checks at commit when
 * the host can have moved during that wait.
 */
export function fileAttachmentsReadyOn(
  content: JsonContent,
  hostId: string | null,
): boolean {
  const nodes = collectFileAttachmentNodes(content);
  if (nodes.length === 0) return true;
  if (hostId === null) return false;
  if (countFileAttachments(content) > MAX_FILE_ATTACHMENTS_PER_MESSAGE) {
    return false;
  }
  if (hostFileAttachmentSupport(hostId) === "outdated") return false;
  return nodes.every(
    (node) =>
      node.uploadState === null &&
      (node.uploadHostId === hostId ||
        confirmedHashesByHost.get(hostId)?.has(node.hash) === true),
  );
}

export type FileSendReadiness = "ready" | "held";

/**
 * The checks that need no upload, each saying why it refuses. A node still
 * uploading or marked for reattach is gated before submit and never reaches
 * the wire, so it holds silently.
 */
function fileSendAdmitted(
  content: JsonContent,
  nodes: ReadonlyArray<ComposerFileAttachmentNode>,
  target: FileAttachmentUploadTarget | null,
): target is FileAttachmentUploadTarget {
  if (countFileAttachments(content) > MAX_FILE_ATTACHMENTS_PER_MESSAGE) {
    showTooManyFilesAtSendToast();
    return false;
  }
  if (nodes.some((node) => node.uploadState !== null)) return false;
  if (target === null) {
    showNoHostForFilesToast();
    return false;
  }
  if (hostFileAttachmentSupport(target.hostId) === "outdated") {
    showHostOutdatedForFilesToast();
    return false;
  }
  return true;
}

function groupByHash(
  nodes: ReadonlyArray<ComposerFileAttachmentNode>,
): ReadonlyMap<string, ReadonlyArray<ComposerFileAttachmentNode>> {
  const byHash = new Map<string, ComposerFileAttachmentNode[]>();
  for (const node of nodes) {
    const group = byHash.get(node.hash);
    if (group === undefined) byHash.set(node.hash, [node]);
    else group.push(node);
  }
  return byHash;
}

/**
 * The pre-dispatch step every file-carrying send and create runs on its FINAL
 * destination: each file in `content` must be confirmed on `target`, by this
 * renderer's acknowledgement or by the node's own record of the host it was
 * stored on. A file confirmed only elsewhere - the placement moved, a staged
 * sandbox took the draft over - is uploaded to `target` first, through the
 * same serial queue and floor as an attach. One whose bytes this renderer no
 * longer has (a reload) is marked `reattach` through `settle` and holds the
 * send.
 *
 * `"held"` means the send must not go: every reason has already been shown
 * (a toast, a chip). `"ready"` means every file is on `target`.
 */
export async function ensureFileAttachmentsOnHost(input: {
  readonly content: JsonContent;
  readonly target: FileAttachmentUploadTarget | null;
  readonly put: PutFileBlob;
  readonly settle: FileNodeSettle;
}): Promise<FileSendReadiness> {
  const { content, target, put, settle } = input;
  const nodes = collectFileAttachmentNodes(content);
  if (nodes.length === 0) return "ready";
  if (!fileSendAdmitted(content, nodes, target)) return "held";
  const reattach: ComposerFileAttachmentNode[] = [];
  for (const [hash, group] of groupByHash(nodes)) {
    const confirmed =
      confirmedHashesByHost.get(target.hostId)?.has(hash) === true ||
      group.some((node) => node.uploadHostId === target.hostId);
    if (confirmed) continue;
    const file = pickedFiles.get(hash);
    if (file === undefined) {
      reattach.push(...group);
      continue;
    }
    const first = group[0];
    const outcome = await runSerially(() =>
      putFile({
        put,
        target,
        file,
        identity: first,
        signal: new AbortController().signal,
      }),
    );
    if (outcome === "host-outdated") {
      showHostOutdatedForFilesToast();
      return "held";
    }
    if (outcome === "failed") {
      showUploadFailedToast(first.fileName);
      return "held";
    }
  }
  if (reattach.length > 0) {
    for (const node of reattach) settle(node.id, { kind: "reattach" });
    showReattachToast([...new Set(reattach.map((node) => node.fileName))]);
    return "held";
  }
  return "ready";
}
