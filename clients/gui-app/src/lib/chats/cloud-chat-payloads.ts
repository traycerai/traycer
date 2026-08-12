import {
  decodeBase64,
  type Sha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import type { ReadCloudChatPayloadResponse } from "@traycer/protocol/host/epic/cloud-chat";

/**
 * One payload response as the text a block may render - after the bytes have
 * been proved to be the ones the ref names.
 *
 * The other half of the payload channel - which refs are fetchable at all -
 * lives in `@traycer-clients/shared/cloud-chat/payloads`, because the CLI needs
 * the same answer. What is here is renderer-specific: how much of a file body
 * may reach the DOM, and what a truncated preview says about itself.
 *
 * ## The client verifies, because the client is the only party that can
 *
 * A payload is content-addressed: `ref.sha256` IS its identity, and the reader
 * asked for that ref by name. Checking the host-declared length is not a
 * substitute - length cannot establish content identity, and a same-length
 * substitution would render under the original ref with nothing to notice it.
 * This is the same posture the shard path already takes, and it has to hold
 * here for the same reason: the host is a byte pipe, not an authority on what
 * it moved.
 */

/**
 * Largest payload this reader will decode.
 *
 * The same 16 MiB per-chat ceiling the publisher refuses above, so meeting it
 * here means the object is wrong rather than that someone has a big attachment.
 */
export const MAX_RENDERED_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Largest base64 body this reader will expand.
 *
 * The DECLARED length is a claim by the same party that supplied the bytes, so
 * checking it alone bounds nothing: a response can declare ten bytes and carry
 * a few hundred megabytes of base64, and `atob` will happily expand all of it -
 * plus a second `Uint8Array` copy - before the declared-length check ever gets
 * to disagree. The encoded body is the thing actually in hand, so it is what
 * has to be bounded first.
 *
 * Base64 encodes 3 bytes as 4 characters, so this is the largest encoding a
 * within-ceiling payload can have. Both checks are kept: this one bounds the
 * work, and the decoded-length check still catches a body that is small but
 * lies about itself.
 */
export const MAX_ENCODED_PAYLOAD_CHARS =
  4 * Math.ceil(MAX_RENDERED_PAYLOAD_BYTES / 3);

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
  /**
   * The bytes that arrived are not the ones the ref names.
   *
   * Its own arm rather than folded into `unavailable`, even though a reader
   * sees the same marker for both: one means "the cloud does not have this",
   * and the other means "something returned different content under this
   * address". They are the same to a user and very much not the same to whoever
   * reads the logs, and a union member is how a test can tell them apart at all.
   */
  | { readonly kind: "digest-mismatch" }
  /** Answered from a different owner's row. Surfaced, never rendered. */
  | { readonly kind: "ambiguous-identity" };

const UNAVAILABLE: CloudChatPayloadBytes = { kind: "unavailable" };

/**
 * Decode, verify against the requested content address, and reduce to a
 * previewable string.
 *
 * Async because the verification is: WebCrypto's digest is, and hashing is not
 * something to skip for the convenience of a synchronous signature. The order
 * is deliberate - cheap structural checks bound the work first, then the bytes
 * are decoded, then they are hashed, and only bytes that ARE what the ref names
 * are ever turned into text.
 *
 * Every failure lands on a marker rather than an error: a payload is one part of
 * a transcript that is otherwise fine, and an error box inside it would
 * misdescribe a chat that reads perfectly well. Transport failures never reach
 * here at all; they throw, so the query retries rather than caching a permanent
 * refusal.
 */
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

  // The whole point. `byteLength` above is the host's claim about its own
  // transfer; this is the record's claim about the CONTENT, and only the second
  // one is what the reader asked for.
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

/**
 * `null` for anything `atob` refuses - the same "not the named object".
 *
 * Wraps the shared decoder rather than repeating its charCode walk: two copies
 * of one decode step on one verification path is a correction that lands in one
 * of them. Only the FAILURE shape differs, which is the whole reason this exists
 * - the shard path treats an undecodable body as a transport failure and throws;
 * a payload is one marker inside a transcript that reads fine otherwise.
 */
function decodeBase64OrNull(value: string): Uint8Array | null {
  try {
    return decodeBase64(value);
  } catch {
    return null;
  }
}
