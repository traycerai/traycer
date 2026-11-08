import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  fileAttachmentAttrsSchema,
  type FileAttachmentAttrs,
} from "@traycer/protocol/common/file-attachment";

import { numberValue, stringValue } from "./tiptap-json-content";

export const FILE_ATTACHMENT_NODE_TYPE = "fileAttachment";

/** What a picked file with no declared type is uploaded and stored as. */
export const FILE_ATTACHMENT_FALLBACK_MEDIA_TYPE = "application/octet-stream";

/**
 * The composer's own attrs on a `fileAttachment` node. Neither is part of the
 * wire attrs (`FileAttachmentAttrs`); the host's schema strips both.
 *
 * `uploadState` is `"pending"` from the moment the node is inserted until the
 * host acknowledges the bytes, `"reattach"` once a send needed the bytes on a
 * host that never got them and they are no longer at hand, and `null` when the
 * file is stored. Either non-null state holds send. It lives IN the document
 * rather than in a job counter so that a draft persisted mid-upload (the app
 * closed, the tab switched, another device looking at the same draft) still
 * says its bytes were never confirmed.
 *
 * `uploadHostId` is the host that acknowledged the bytes, so a send can tell,
 * even after a reload, whether its destination already holds them.
 */
export type FileAttachmentUploadState = "pending" | "reattach";

export interface ComposerFileAttachmentAttrs extends FileAttachmentAttrs {
  readonly uploadState: FileAttachmentUploadState | null;
  readonly uploadHostId: string | null;
}

/** A file node as a send reads it: its identity and where its bytes are. */
export interface ComposerFileAttachmentNode {
  readonly id: string;
  readonly hash: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly uploadState: FileAttachmentUploadState | null;
  readonly uploadHostId: string | null;
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

export function fileAttachmentUploadStateOf(
  attrs: Record<string, unknown> | undefined,
): FileAttachmentUploadState | null {
  const state = stringValue(attrs?.uploadState);
  return state === "pending" || state === "reattach" ? state : null;
}

/**
 * Every file node whose attrs parse, in document order. A node that does not
 * parse names no bytes a send could carry, so it is not a file to a send.
 */
export function collectFileAttachmentNodes(
  content: JsonContent,
): ReadonlyArray<ComposerFileAttachmentNode> {
  const out: ComposerFileAttachmentNode[] = [];
  const visit = (node: JsonContent): void => {
    if (node.type === FILE_ATTACHMENT_NODE_TYPE) {
      const attrs = fileAttachmentAttrsOf(node.attrs);
      if (attrs !== null) {
        out.push({
          id: attrs.id,
          hash: attrs.hash,
          fileName: attrs.fileName,
          mediaType: attrs.mediaType,
          uploadState: fileAttachmentUploadStateOf(node.attrs),
          uploadHostId: stringValue(node.attrs?.uploadHostId),
        });
      }
      return;
    }
    node.content?.forEach(visit);
  };
  visit(content);
  return out;
}

/** The identity the per-message cap counts: one per `(hash, fileName)`. */
export function fileAttachmentIdentity(attrs: {
  readonly hash: string;
  readonly fileName: string;
}): string {
  return `${attrs.hash}\u0000${attrs.fileName}`;
}

function someNode(
  node: JsonContent,
  predicate: (node: JsonContent) => boolean,
): boolean {
  if (predicate(node)) return true;
  return (node.content ?? []).some((child) => someNode(child, predicate));
}

/** The draft's file identities, by the host's count. */
export function fileAttachmentIdentities(
  content: JsonContent,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const visit = (node: JsonContent): void => {
    if (node.type === FILE_ATTACHMENT_NODE_TYPE) {
      keys.add(
        fileAttachmentIdentity({
          hash: stringValue(node.attrs?.hash) ?? "",
          fileName: stringValue(node.attrs?.fileName) ?? "",
        }),
      );
      return;
    }
    node.content?.forEach(visit);
  };
  visit(content);
  return keys;
}

/**
 * How many files the draft carries, by the host's count: one per distinct
 * `(hash, fileName)`, pending nodes included.
 */
export function countFileAttachments(content: JsonContent): number {
  return fileAttachmentIdentities(content).size;
}

/**
 * What an upload's outcome does to a file node: stored on a host, waiting to
 * be attached again, or gone.
 */
export type FileNodeSettlement =
  | { readonly kind: "stored"; readonly hostId: string }
  | { readonly kind: "reattach" }
  | { readonly kind: "remove" };

/**
 * `content` with the file node `id` settled, or `null` when no node has that
 * id. For a draft whose composer is not mounted: the upload finished while the
 * person was elsewhere, and the persisted draft has to say so before a restart
 * can lose the registry that knows it.
 */
export function settleFileNodeInContent(
  content: JsonContent,
  id: string,
  settlement: FileNodeSettlement,
): JsonContent | null {
  const match = { found: false };
  const visit = (node: JsonContent): JsonContent | null => {
    if (node.type === FILE_ATTACHMENT_NODE_TYPE && node.attrs?.id === id) {
      match.found = true;
      if (settlement.kind === "remove") return null;
      return {
        ...node,
        attrs:
          settlement.kind === "stored"
            ? {
                ...node.attrs,
                uploadState: null,
                uploadHostId: settlement.hostId,
              }
            : { ...node.attrs, uploadState: "reattach" },
      };
    }
    if (node.content === undefined) return node;
    return {
      ...node,
      content: node.content.flatMap((child) => {
        const next = visit(child);
        return next === null ? [] : [next];
      }),
    };
  };
  const next = visit(content);
  return match.found ? next : null;
}

export function containsFileAttachments(content: JsonContent): boolean {
  return someNode(content, (node) => node.type === FILE_ATTACHMENT_NODE_TYPE);
}

/**
 * Whether any file in the draft is not ready to send: still uploading, never
 * confirmed, or waiting to be attached again. Send is refused while this
 * holds: a node whose bytes the host never stored would reach the agent as an
 * unavailable file.
 */
export function containsPendingFileAttachment(content: JsonContent): boolean {
  return someNode(
    content,
    (node) =>
      node.type === FILE_ATTACHMENT_NODE_TYPE &&
      fileAttachmentUploadStateOf(node.attrs) !== null,
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
