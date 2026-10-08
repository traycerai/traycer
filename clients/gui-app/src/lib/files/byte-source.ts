import { EPIC_READ_FILE_RANGE_MAX_BYTES } from "@traycer/protocol/host/epic/files";
import type {
  EpicFileUnavailableReason,
  EpicReadFileRequest,
} from "@traycer/protocol/host/epic/files";
import type { EpicFileRpc } from "@/lib/files/epic-file-rpc";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";

/**
 * Where a viewer's bytes come from (§2.4).
 *
 * Every byte arrives through `epic.readFile`: a Blob built from `range` reads,
 * which works for a co-located GUI, over the relay, on a phone and with the
 * cloud offline, or - for a published video only - a signed https URL that the
 * element streams itself. No loopback URL ever reaches a client.
 */

const MIB = 1024 * 1024;

/** What a viewer can show without the file going through a Download. */
export type ByteSourceKind = "image" | "pdf" | "video";

/**
 * The most a viewer will pull into memory per kind. Past it the row offers
 * Download only (and, for video, says it plays once the upload lands).
 * Unpublished video is the only kind with a platform split: a phone holds far
 * less than a desktop.
 */
export function byteSourceCapBytes(
  kind: ByteSourceKind,
  isMobile: boolean,
): number {
  switch (kind) {
    case "image":
      return 64 * MIB;
    case "pdf":
      return 128 * MIB;
    case "video":
      return (isMobile ? 64 : 512) * MIB;
  }
}

export type ByteSourceResult =
  | { readonly kind: "blob"; readonly blob: Blob }
  | { readonly kind: "unavailable"; readonly reason: EpicFileUnavailableReason }
  /** Bigger than the cap given; nothing past the first span was read. */
  | { readonly kind: "too-large"; readonly totalBytes: number };

export interface ReadBlobOptions {
  /**
   * Refuse a file bigger than this, answering `too-large` after the first
   * span (which is what reveals the size). `null` reads whatever the file is.
   */
  readonly maxBytes: number | null;
  /** Called after each span with the bytes held so far and the file total. */
  readonly onProgress: ((received: number, total: number) => void) | null;
  readonly signal: AbortSignal;
}

function addressRequest(
  address: EpicFileAddress,
): Omit<EpicReadFileRequest, "want"> {
  return {
    epicId: address.epicId,
    path: address.path,
    sha256: address.sha256,
    via: address.via,
  };
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The one RPC the byte source needs: `epic.readFile`. */
export type ReadFile = EpicFileRpc["readFile"];

/** The longest base64 a full span can take, padding included, plus slack. */
const MAX_SPAN_BASE64_LENGTH =
  Math.ceil((EPIC_READ_FILE_RANGE_MAX_BYTES * 4) / 3) + 4;

/**
 * Decodes one span, refusing it - before decoding when the encoded length
 * already says so - if it carries more than `limit` bytes.
 */
function decodeSpan(encoded: string, limit: number): Uint8Array<ArrayBuffer> {
  if (encoded.length > MAX_SPAN_BASE64_LENGTH) {
    throw new Error("The host answered a file read with an overlong span");
  }
  const span = decodeBase64(encoded);
  if (span.length > limit) {
    throw new Error("The host answered a file read with an overlong span");
  }
  return span;
}

/**
 * Reads a whole file through `range` spans of at most 4 MiB into one Blob.
 *
 * The host verified the sha when it materialized the file, and a span carries
 * the total, so a file that changed under the reader (impossible by
 * content-addressing, but cheap to refuse) or a host that answers the wrong
 * offset fails the read instead of building a corrupt Blob. A span is bounded
 * before it is decoded, and may never carry more than was asked for, more
 * than the file has left, or more than the cap has left: a misbehaving host
 * cannot make the reader hold more than the cap.
 */
export async function readFileBlob(
  readFile: ReadFile,
  address: EpicFileAddress,
  options: ReadBlobOptions,
): Promise<ByteSourceResult> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let total = 0;
  let mediaType = "";
  do {
    const length =
      offset === 0
        ? EPIC_READ_FILE_RANGE_MAX_BYTES
        : Math.min(EPIC_READ_FILE_RANGE_MAX_BYTES, total - offset);
    const response = await readFile(
      {
        ...addressRequest(address),
        want: { kind: "range", offset, length },
      },
      options.signal,
    );
    if (response.kind === "unavailable") {
      return { kind: "unavailable", reason: response.reason };
    }
    if (response.kind !== "bytes" || response.offset !== offset) {
      throw new Error("The host answered a file read with the wrong span");
    }
    if (offset === 0) {
      total = response.totalBytes;
      mediaType = response.mediaType;
      if (options.maxBytes !== null && total > options.maxBytes) {
        return { kind: "too-large", totalBytes: total };
      }
    } else if (response.totalBytes !== total) {
      throw new Error("The file changed while it was being read");
    }
    const capLeft =
      options.maxBytes === null ? total - offset : options.maxBytes - offset;
    const span = decodeSpan(
      response.bytesBase64,
      Math.min(length, total - offset, capLeft),
    );
    // An empty span before the end would loop forever on a misbehaving host.
    if (span.length === 0 && offset < total) {
      throw new Error("The host ended a file read early");
    }
    parts.push(span);
    offset += span.length;
    options.onProgress?.(offset, total);
  } while (offset < total);
  const blob = new Blob(parts, { type: mediaType });
  if (blob.size !== total) {
    throw new Error("The file read did not add up to the size the host gave");
  }
  return { kind: "blob", blob };
}

export type SignedUrlResult =
  | {
      readonly kind: "url";
      readonly url: string;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: EpicFileUnavailableReason;
    };

/** A signed https URL for a published file (video seek, large downloads). */
export async function readSignedUrl(
  readFile: ReadFile,
  address: EpicFileAddress,
  signal: AbortSignal,
): Promise<SignedUrlResult> {
  const response = await readFile(
    { ...addressRequest(address), want: { kind: "url" } },
    signal,
  );
  if (response.kind === "unavailable") {
    return { kind: "unavailable", reason: response.reason };
  }
  if (response.kind !== "url") {
    throw new Error("The host answered a URL read with something else");
  }
  return { kind: "url", url: response.url, expiresAt: response.expiresAt };
}

/** The fraction of a URL's lifetime after which the client asks for a new one. */
const URL_RENEWAL_FRACTION = 0.8;

/**
 * How long to wait before renewing a URL received at `receivedAt`: 80 % of its
 * lifetime, measured from receipt because the answer carries only the expiry.
 * Never negative - an already-expired answer renews at once.
 */
export function urlRenewalDelayMs(
  expiresAt: number,
  receivedAt: number,
): number {
  return Math.max(0, (expiresAt - receivedAt) * URL_RENEWAL_FRACTION);
}
