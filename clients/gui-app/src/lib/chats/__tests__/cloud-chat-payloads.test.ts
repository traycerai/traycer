import { describe, expect, it } from "vitest";
import {
  encodeBase64,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import type { ReadCloudChatPayloadResponse } from "@traycer/protocol/host/epic/cloud-chat";
import {
  decodeCloudChatPayload,
  MAX_ENCODED_PAYLOAD_CHARS,
  MAX_RENDERED_PAYLOAD_BYTES,
  PAYLOAD_PREVIEW_BYTES,
  type CloudChatPayloadBytes,
} from "@/lib/chats/cloud-chat-payloads";

/**
 * Driven with REAL digests throughout.
 *
 * The verification under test is "are these the bytes the ref names", so a
 * fixture that made up a digest would only ever exercise the mismatch arm. Each
 * case hashes its own content and asks for it by that address, which is what
 * the reader does.
 */

function okResponse(
  bytes: Uint8Array,
  declared: number,
): ReadCloudChatPayloadResponse {
  return {
    outcome: {
      status: "ok",
      bytesBase64: encodeBase64(bytes),
      byteLength: declared,
    },
  };
}

/** Decodes `bytes` while asking for whatever `bytes` actually hashes to. */
async function decodeHonest(
  bytes: Uint8Array,
  declared: number,
): Promise<CloudChatPayloadBytes> {
  return decodeCloudChatPayload(
    okResponse(bytes, declared),
    { sha256: await webCryptoSha256Hex(bytes) },
    webCryptoSha256Hex,
  );
}

describe("content addressing", () => {
  it("returns the text when the bytes hash to the requested ref", async () => {
    const bytes = new TextEncoder().encode("hello, file");

    expect(await decodeHonest(bytes, bytes.byteLength)).toEqual({
      kind: "text",
      text: "hello, file",
      byteLength: bytes.byteLength,
      isTruncated: false,
    });
  });

  it("REFUSES a same-length substitution", async () => {
    const asked = new TextEncoder().encode("the original file contents");
    const served = new TextEncoder().encode("the substitute file contents");
    // The whole point: an equal-length body defeats every length check there
    // is, and only the content address can tell these apart.
    const sameLength = served.subarray(0, asked.byteLength);
    expect(sameLength.byteLength).toBe(asked.byteLength);

    const result = await decodeCloudChatPayload(
      okResponse(sameLength, asked.byteLength),
      { sha256: await webCryptoSha256Hex(asked) },
      webCryptoSha256Hex,
    );

    expect(result.kind).toBe("digest-mismatch");
  });

  it("REFUSES a single flipped byte", async () => {
    const asked = new TextEncoder().encode("a file that was tampered with");
    const tampered = new Uint8Array(asked);
    tampered[0] ^= 0x01;

    const result = await decodeCloudChatPayload(
      okResponse(tampered, asked.byteLength),
      { sha256: await webCryptoSha256Hex(asked) },
      webCryptoSha256Hex,
    );

    expect(result.kind).toBe("digest-mismatch");
  });

  it("keeps digest-mismatch distinct from unavailable", async () => {
    // Same marker to a reader, different facts to a log: "the cloud does not
    // have this" versus "something returned other content under this address".
    const unavailable = await decodeCloudChatPayload(
      { outcome: { status: "unavailable" } },
      { sha256: "whatever" },
      webCryptoSha256Hex,
    );
    expect(unavailable.kind).toBe("unavailable");
  });
});

describe("bounding the work before doing it", () => {
  it("refuses an oversized DECLARED length without expanding anything", async () => {
    const result = await decodeCloudChatPayload(
      okResponse(new Uint8Array([1]), MAX_RENDERED_PAYLOAD_BYTES + 1),
      { sha256: "unused" },
      webCryptoSha256Hex,
    );

    expect(result.kind).toBe("unavailable");
  });

  it("refuses an oversized ENCODED body even when it declares a tiny length", async () => {
    // The attack the declared-length check alone does not stop: claim ten
    // bytes, carry a body far past the ceiling, and let `atob` expand all of it
    // before anyone disagrees. Bounding the string in hand is what caps the
    // work; the declared length only ever describes what SHOULD be there.
    const oversized = "A".repeat(MAX_ENCODED_PAYLOAD_CHARS + 4);

    const result = await decodeCloudChatPayload(
      { outcome: { status: "ok", bytesBase64: oversized, byteLength: 10 } },
      { sha256: "unused" },
      webCryptoSha256Hex,
    );

    expect(result.kind).toBe("unavailable");
  });

  it("refuses bytes whose length disagrees with the declared one", async () => {
    const bytes = new TextEncoder().encode("hello");

    const result = await decodeCloudChatPayload(
      okResponse(bytes, 999),
      { sha256: await webCryptoSha256Hex(bytes) },
      webCryptoSha256Hex,
    );

    expect(result.kind).toBe("unavailable");
  });

  it("refuses base64 it cannot decode", async () => {
    const result = await decodeCloudChatPayload(
      {
        outcome: {
          status: "ok",
          bytesBase64: "!!!not base64!!!",
          byteLength: 4,
        },
      },
      { sha256: "unused" },
      webCryptoSha256Hex,
    );

    expect(result.kind).toBe("unavailable");
  });
});

describe("the preview bound", () => {
  it("truncates at the bound and states the FULL size", async () => {
    const bytes = new TextEncoder().encode(
      "a".repeat(PAYLOAD_PREVIEW_BYTES + 100),
    );

    const result = await decodeHonest(bytes, bytes.byteLength);

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.isTruncated).toBe(true);
    expect(result.text).toHaveLength(PAYLOAD_PREVIEW_BYTES);
    // The full size, never the preview's - a truncation notice describing its
    // own prefix would tell the reader nothing.
    expect(result.byteLength).toBe(bytes.byteLength);
  });

  it("bounds SOURCE BYTES, not UTF-16 units", async () => {
    // Every one of these is 3 source bytes and 1 UTF-16 unit. A bound expressed
    // in `String.length` would let 3x the intended payload through.
    const bytes = new TextEncoder().encode("漢".repeat(PAYLOAD_PREVIEW_BYTES));

    const result = await decodeHonest(bytes, bytes.byteLength);

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.isTruncated).toBe(true);
    expect(
      new TextEncoder().encode(result.text).byteLength,
    ).toBeLessThanOrEqual(PAYLOAD_PREVIEW_BYTES);
  });

  it("never ends a preview on a replacement character", async () => {
    // The bound lands mid-sequence: 64 KiB is not a multiple of 3, so slicing
    // a run of 3-byte characters at it splits one.
    const bytes = new TextEncoder().encode("漢".repeat(PAYLOAD_PREVIEW_BYTES));

    const result = await decodeHonest(bytes, bytes.byteLength);

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    // A U+FFFD here would be a corruption mark on content that is perfectly
    // fine, in the one place a reader is looking for the file's real text.
    expect(result.text).not.toContain("�");
  });
});

describe("the states that are markers, not errors", () => {
  it("keeps ambiguous-identity distinct from unavailable", async () => {
    // Folding them together would tell a user their attachments are gone when
    // they are sitting in the row next to this one.
    const result = await decodeCloudChatPayload(
      { outcome: { status: "ambiguous-identity" } },
      { sha256: "unused" },
      webCryptoSha256Hex,
    );

    expect(result.kind).toBe("ambiguous-identity");
  });
});
