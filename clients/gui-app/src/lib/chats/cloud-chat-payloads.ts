import {
  decodeBase64,
  type Sha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import type { ReadCloudChatPayloadResponse } from "@traycer/protocol/host/epic/cloud-chat";

/**
 * One payload response as the text a block may render - after the bytes have been proved to be the ones the ref names.
 */

/** Largest payload this reader will decode. */
export const MAX_RENDERED_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Largest base64 body this reader will expand. */
export const MAX_ENCODED_PAYLOAD_CHARS =
  4 * Math.ceil(MAX_RENDERED_PAYLOAD_BYTES / 3);

/** How much of a payload reaches the DOM, measured in SOURCE BYTES. */
export const PAYLOAD_PREVIEW_BYTES = 64 * 1024;

export type CloudChatPayloadBytes =
  | {
      readonly kind: "text";
      readonly text: string;
      /** DECODED size, so a truncated preview can say what it is part of. */
      readonly byteLength: number;
      readonly isTruncated: boolean;
    }
  /** Nothing to show, and nothing a retry fixes. Renders as the marker. */
  | { readonly kind: "unavailable" }
  /** The bytes that arrived are not the ones the ref names. */
  | { readonly kind: "digest-mismatch" }
  /** Answered from a different owner's row. Surfaced, never rendered. */
  | { readonly kind: "ambiguous-identity" };

const UNAVAILABLE: CloudChatPayloadBytes = { kind: "unavailable" };

/** Decode, verify against the requested content address, and reduce to a previewable string. */
export async function decodeCloudChatPayload(
  response: ReadCloudChatPayloadResponse,
  expected: { readonly sha256: string },
  sha256Hex: Sha256Hex,
): Promise<CloudChatPayloadBytes> {
  const { outcome } = response;
  if (outcome.status === "ambiguous-identity") {
    return { kind: "ambiguous-identity" };
  }
  if (outcome.status === "unavailable") return UNAVAILABLE;
  if (outcome.byteLength > MAX_RENDERED_PAYLOAD_BYTES) return UNAVAILABLE;
  if (outcome.bytesBase64.length > MAX_ENCODED_PAYLOAD_CHARS)
    return UNAVAILABLE;

  const bytes = decodeBase64OrNull(outcome.bytesBase64);
  if (bytes === null || bytes.byteLength !== outcome.byteLength) {
    return UNAVAILABLE;
  }

  // The whole point.
  // `byteLength` above is the host's claim about its own transfer; this is the record's claim about the CONTENT, and only the second one is what the reader asked for.
  const digest = await sha256Hex(bytes);
  if (digest !== expected.sha256) return { kind: "digest-mismatch" };

  const preview = previewOf(bytes);
  return {
    kind: "text",
    text: preview.text,
    // The FULL size, never the preview's. A truncation notice that described
    // its own prefix would be telling the reader nothing.
    byteLength: outcome.byteLength,
    isTruncated: preview.isTruncated,
  };
}

/** A valid UTF-8 prefix of at most {@link PAYLOAD_PREVIEW_BYTES} source bytes. */
function previewOf(bytes: Uint8Array): {
  readonly text: string;
  readonly isTruncated: boolean;
} {
  if (bytes.byteLength <= PAYLOAD_PREVIEW_BYTES) {
    return { text: new TextDecoder().decode(bytes), isTruncated: false };
  }
  return {
    text: new TextDecoder().decode(bytes.slice(0, PAYLOAD_PREVIEW_BYTES), {
      stream: true,
    }),
    isTruncated: true,
  };
}

/** `null` for anything `atob` refuses - the same "not the named object". */
function decodeBase64OrNull(value: string): Uint8Array | null {
  try {
    return decodeBase64(value);
  } catch {
    return null;
  }
}
