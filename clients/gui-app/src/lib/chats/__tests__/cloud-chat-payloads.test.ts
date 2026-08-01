import { describe, expect, it } from "vitest";
import { encodeBase64 } from "@traycer-clients/shared/cloud-chat/bytes";
import type { ReadCloudChatPayloadResponse } from "@traycer/protocol/host/epic/cloud-chat";
import {
  decodeCloudChatPayload,
  MAX_RENDERED_PAYLOAD_BYTES,
  PAYLOAD_PREVIEW_BYTES,
} from "@/lib/chats/cloud-chat-payloads";

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

describe("decoding", () => {
  it("returns the text and its full decoded length", () => {
    const bytes = new TextEncoder().encode("hello, file");

    const result = decodeCloudChatPayload(okResponse(bytes, bytes.byteLength));

    expect(result).toEqual({
      kind: "text",
      text: "hello, file",
      byteLength: bytes.byteLength,
      isTruncated: false,
    });
  });

  it("refuses bytes whose length disagrees with the declared one", () => {
    const bytes = new TextEncoder().encode("hello");

    // The protocol carries `byteLength` precisely so a client can check what it
    // decoded; base64 decoding to a different size is not the named object.
    expect(decodeCloudChatPayload(okResponse(bytes, 999)).kind).toBe(
      "unavailable",
    );
  });

  it("refuses base64 it cannot decode", () => {
    const response: ReadCloudChatPayloadResponse = {
      outcome: { status: "ok", bytesBase64: "!!!not base64!!!", byteLength: 4 },
    };

    expect(decodeCloudChatPayload(response).kind).toBe("unavailable");
  });

  it("refuses an oversized payload BEFORE expanding it", () => {
    // The declared length alone is the refusal, so a hostile 16 MiB+ object
    // costs no decode at all - which is why the body here is one byte.
    const response = okResponse(
      new Uint8Array([1]),
      MAX_RENDERED_PAYLOAD_BYTES + 1,
    );

    expect(decodeCloudChatPayload(response).kind).toBe("unavailable");
  });
});

describe("the preview bound", () => {
  it("truncates at the bound and states the FULL size", () => {
    const bytes = new TextEncoder().encode(
      "a".repeat(PAYLOAD_PREVIEW_BYTES + 100),
    );

    const result = decodeCloudChatPayload(okResponse(bytes, bytes.byteLength));

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.isTruncated).toBe(true);
    expect(result.text).toHaveLength(PAYLOAD_PREVIEW_BYTES);
    // The full size, never the preview's - a truncation notice describing its
    // own prefix would tell the reader nothing.
    expect(result.byteLength).toBe(bytes.byteLength);
  });

  it("bounds SOURCE BYTES, not UTF-16 units", () => {
    // Every one of these is 3 source bytes and 1 UTF-16 unit. A bound expressed
    // in `String.length` would let 3x the intended payload through.
    const character = "漢";
    const count = PAYLOAD_PREVIEW_BYTES; // 3x the bound, in bytes
    const bytes = new TextEncoder().encode(character.repeat(count));

    const result = decodeCloudChatPayload(okResponse(bytes, bytes.byteLength));

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.isTruncated).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(
      PAYLOAD_PREVIEW_BYTES,
    );
  });

  it("never ends a preview on a replacement character", () => {
    // The bound lands mid-sequence: 64 KiB is not a multiple of 3, so slicing
    // a run of 3-byte characters at it splits one.
    const bytes = new TextEncoder().encode("漢".repeat(PAYLOAD_PREVIEW_BYTES));

    const result = decodeCloudChatPayload(okResponse(bytes, bytes.byteLength));

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    // A U+FFFD here would be a corruption mark on content that is perfectly
    // fine, in the one place a reader is looking for the file's real text.
    expect(result.text).not.toContain("�");
  });
});

describe("the states that are markers, not errors", () => {
  it("passes `unavailable` through as the marker", () => {
    expect(
      decodeCloudChatPayload({ outcome: { status: "unavailable" } }).kind,
    ).toBe("unavailable");
  });

  it("keeps `ambiguous-identity` distinct from unavailable", () => {
    // Folding them together would tell a user their attachments are gone when
    // they are sitting in the row next to this one.
    expect(
      decodeCloudChatPayload({ outcome: { status: "ambiguous-identity" } }).kind,
    ).toBe("ambiguous-identity");
  });
});
