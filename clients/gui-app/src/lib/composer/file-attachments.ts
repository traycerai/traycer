import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  fileAttachmentAttrsSchema,
  type FileAttachmentAttrs,
} from "@traycer/protocol/common/file-attachment";

import { numberValue, stringValue } from "./tiptap-json-content";

export const FILE_ATTACHMENT_NODE_TYPE = "fileAttachment";

/**
 * The most files one message may carry, counted one per `(hash, fileName)` as
 * the agent's "Attached files" block lists them. Images are not counted. The
 * host refuses a send or a queued message over it with
 * {@link TOO_MANY_FILE_ATTACHMENTS_CODE}; the composer stops at it first.
 */
export const MAX_FILE_ATTACHMENTS_PER_MESSAGE = 20;

/** The host's refusal code for a message over the per-message file cap. */
export const TOO_MANY_FILE_ATTACHMENTS_CODE = "TOO_MANY_ATTACHMENTS";

/** What a picked file with no declared type is uploaded and stored as. */
export const FILE_ATTACHMENT_FALLBACK_MEDIA_TYPE = "application/octet-stream";

/**
 * The composer's own attr on a `fileAttachment` node: `"pending"` from the
 * moment the node is inserted until the host has acknowledged the bytes, and
 * `null` once it has. Not part of the wire attrs (`FileAttachmentAttrs`); the
 * host's schema strips it, and a send never carries a pending node because the
 * composer refuses to send one.
 *
 * It lives IN the document rather than in a job counter so that a draft
 * persisted mid-upload (the app closed, the tab switched, another device
 * looking at the same draft) still says its bytes were never confirmed.
 */
export type FileAttachmentUploadState = "pending";

export interface ComposerFileAttachmentAttrs extends FileAttachmentAttrs {
  readonly uploadState: FileAttachmentUploadState | null;
}

/**
 * `size` as a number. A node that round-tripped through the HTML clipboard
 * carries it as a string, since every data attribute parses back through
 * `getAttribute`.
 */
export function fileAttachmentSizeValue(value: unknown): number | null {
  const direct = numberValue(value);
  if (direct !== null) return direct;
  const text = stringValue(value);
  if (text === null || !/^\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** A node's wire attrs, or `null` when they do not parse. */
export function fileAttachmentAttrsOf(
  attrs: Record<string, unknown> | undefined,
): FileAttachmentAttrs | null {
  if (attrs === undefined) return null;
  const parsed = fileAttachmentAttrsSchema.safeParse({
    id: attrs.id,
    hash: attrs.hash,
    fileName: attrs.fileName,
    mediaType: attrs.mediaType,
    size: fileAttachmentSizeValue(attrs.size),
  });
  return parsed.success ? parsed.data : null;
}

export function isPendingFileAttachmentAttrs(
  attrs: Record<string, unknown> | undefined,
): boolean {
  return stringValue(attrs?.uploadState) === "pending";
}

function someNode(
  node: JsonContent,
  predicate: (node: JsonContent) => boolean,
): boolean {
  if (predicate(node)) return true;
  return (node.content ?? []).some((child) => someNode(child, predicate));
}

/**
 * How many files the draft carries, by the host's count: one per distinct
 * `(hash, fileName)`, pending nodes included.
 */
export function countFileAttachments(content: JsonContent): number {
  const keys = new Set<string>();
  const visit = (node: JsonContent): void => {
    if (node.type === FILE_ATTACHMENT_NODE_TYPE) {
      const hash = stringValue(node.attrs?.hash) ?? "";
      const fileName = stringValue(node.attrs?.fileName) ?? "";
      keys.add(`${hash}\u0000${fileName}`);
      return;
    }
    node.content?.forEach(visit);
  };
  visit(content);
  return keys.size;
}

export function containsFileAttachments(content: JsonContent): boolean {
  return someNode(content, (node) => node.type === FILE_ATTACHMENT_NODE_TYPE);
}

/**
 * Whether any file in the draft is not yet confirmed on the host. Send is
 * refused while this holds: a node whose bytes the host never stored would
 * reach the agent as an unavailable file.
 */
export function containsPendingFileAttachment(content: JsonContent): boolean {
  return someNode(
    content,
    (node) =>
      node.type === FILE_ATTACHMENT_NODE_TYPE &&
      isPendingFileAttachmentAttrs(node.attrs),
  );
}

export type FileAttachmentFamily =
  | "video"
  | "audio"
  | "pdf"
  | "archive"
  | "other";

const ARCHIVE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
]);

const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  "zip",
  "gz",
  "tgz",
  "tar",
  "7z",
  "rar",
  "bz2",
  "xz",
  "zst",
]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Which icon a file chip shows. By the declared media type first; the
 * extension decides only for the families a browser commonly declares as
 * `application/octet-stream` or not at all (a PDF or an archive picked on a
 * phone).
 */
export function fileAttachmentFamily(
  mediaType: string,
  fileName: string,
): FileAttachmentFamily {
  const type = mediaType.toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (ARCHIVE_MEDIA_TYPES.has(type)) return "archive";
  const extension = extensionOf(fileName);
  if (extension === "pdf") return "pdf";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  return "other";
}
