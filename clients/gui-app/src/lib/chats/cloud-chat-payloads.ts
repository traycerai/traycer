import type { ReadCloudChatPayloadResponse } from "@traycer/protocol/host/epic/cloud-chat";

/**
 * One payload response as the text a block can render.
 *
 * The other half of the payload channel - which refs are fetchable at all -
 * lives in `@traycer-clients/shared/cloud-chat/payloads`, because the CLI needs
 * exactly the same answer. What is here is renderer-specific and belongs
 * nowhere else: how much of a file body may reach the DOM, and what a truncated
 * preview says about itself.
 */

/**
 * Largest payload this reader will decode.
 *
 * The same 16 MiB per-chat ceiling the publisher refuses above, so meeting it
 * here means the object is wrong rather than that someone has a big attachment.
 * Checked against the response's DECLARED length before the base64 is expanded,
 * so an oversized payload costs no decode.
 */
export const MAX_RENDERED_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * How much of a payload reaches the DOM, measured in SOURCE BYTES.
 *
 * A published file body can be megabytes, and a single text node that size
 * makes a dialog unusable long before it makes it wrong. The remainder is
 * stated rather than dropped silently - the same rule the markers follow, since
 * an unexplained gap reads as content that was never there.
 *
 * Bytes and not JavaScript characters, which is not a detail. `String.length`
 * counts UTF-16 code units, so a bound expressed in it lets multi-byte content
 * through at up to three times the intended size: 64k CJK characters are 192 KiB
 * of source and would measure as exactly at the limit. The bound exists to cap
 * the DOM, and the DOM cost tracks the bytes.
 */
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
  /** Answered from a different owner's row. Surfaced, never rendered. */
  | { readonly kind: "ambiguous-identity" };

const UNAVAILABLE: CloudChatPayloadBytes = { kind: "unavailable" };

/**
 * Every failure below lands on `unavailable` - the marker - rather than on an
 * error: a payload is one part of a transcript that is otherwise fine, and an
 * error box inside it would misdescribe a chat that reads perfectly well.
 * Transport failures never reach here at all; they throw, so the query retries
 * instead of caching a permanent refusal.
 *
 * The length check is not ceremony. The protocol carries `byteLength`
 * specifically so a client can verify what it decoded, and base64 that decodes
 * to a different size than the host measured is not the object the record
 * named.
 */
export function decodeCloudChatPayload(
  response: ReadCloudChatPayloadResponse,
): CloudChatPayloadBytes {
  const { outcome } = response;
  if (outcome.status === "ambiguous-identity") {
    return { kind: "ambiguous-identity" };
  }
  if (outcome.status === "unavailable") return UNAVAILABLE;
  if (outcome.byteLength > MAX_RENDERED_PAYLOAD_BYTES) return UNAVAILABLE;

  const bytes = decodeBase64(outcome.bytesBase64);
  if (bytes === null || bytes.byteLength !== outcome.byteLength) {
    return UNAVAILABLE;
  }
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

/**
 * A valid UTF-8 prefix of at most {@link PAYLOAD_PREVIEW_BYTES} source bytes.
 *
 * The byte slice can land in the middle of a multi-byte sequence, and decoding
 * that naively would end the preview with U+FFFD - a corruption mark on content
 * that is perfectly fine, in the one place a reader is looking for the file's
 * real text. `stream: true` is what avoids it: the decoder HOLDS BACK an
 * incomplete trailing sequence instead of emitting a replacement character, so
 * the result ends on a character boundary and is never longer than the bound.
 */
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
function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
