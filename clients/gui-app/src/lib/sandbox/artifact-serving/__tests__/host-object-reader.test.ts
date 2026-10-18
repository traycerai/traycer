/**
 * `createHostObjectReader` adapts `epic.readArtifactObject` into the
 * `ArtifactReadSpan` shape `ArtifactServer` drives. The request function is
 * faked here - this suite is about the polling/error contract, not transport.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicReadArtifactObjectResponse } from "@traycer/protocol/host/epic/files";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  createHostObjectReader,
  type ArtifactObjectRequest,
} from "../host-object-reader";

const SHA = "a".repeat(64);
const EPIC_ID = "epic-1";

function unsupportedError(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "epic.readArtifactObject is not on this host",
    requestId: "req-1",
    method: "epic.readArtifactObject",
    fatalDetails: null,
  });
}

function bytesResponse(
  offset: number,
  text: string,
  totalBytes: number,
): EpicReadArtifactObjectResponse {
  return {
    kind: "bytes",
    bytesBase64: btoa(text),
    offset,
    totalBytes,
    mediaType: "text/plain",
  };
}

function downloadingResponse(
  receivedBytes: number,
  totalBytes: number,
): EpicReadArtifactObjectResponse {
  return { kind: "downloading", receivedBytes, totalBytes };
}

describe("createHostObjectReader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("decodes a direct bytes response into the span result", async () => {
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValue(bytesResponse(0, "hello", 5));
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    const result = await reader(SHA, 0, 5, new AbortController().signal);

    expect(result).toEqual({
      bytes: Uint8Array.from("hello", (character) => character.charCodeAt(0)),
      totalBytes: 5,
      mediaType: "text/plain",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "epic.readArtifactObject",
      { epicId: EPIC_ID, sha256: SHA, want: { kind: "range", offset: 0, length: 5 } },
      expect.any(AbortSignal),
    );
  });

  it("returns the shorter actual span unchanged when the request reaches past EOF", async () => {
    // offset 5, requested length 10, but only 5 bytes exist past the offset -
    // the host answers with just those 5 and the correct totalBytes; the
    // reader must not pad, truncate further, or reject the short span.
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValue(bytesResponse(5, "world", 10));
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    const result = await reader(SHA, 5, 10, new AbortController().signal);

    expect(result).toEqual({
      bytes: Uint8Array.from("world", (character) => character.charCodeAt(0)),
      totalBytes: 10,
      mediaType: "text/plain",
    });
  });

  it("throws when the bytes response's offset does not match the request", async () => {
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValue(bytesResponse(4, "hello", 5));
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    await expect(
      reader(SHA, 0, 5, new AbortController().signal),
    ).rejects.toThrow("Artifact span offset does not match the request");
  });

  it.each(["missing", "not-downloaded", "failed"] as const)(
    "passes an unavailable response's %s reason straight through",
    async (reason) => {
      const request = vi
        .fn<ArtifactObjectRequest>()
        .mockResolvedValue({ kind: "unavailable", reason });
      const reader = createHostObjectReader({ request, epicId: EPIC_ID });

      await expect(
        reader(SHA, 0, 5, new AbortController().signal),
      ).resolves.toEqual({ unavailable: reason });
    },
  );

  it("treats E_HOST_UNSUPPORTED as the object being unavailable, without retrying", async () => {
    const request = vi.fn<ArtifactObjectRequest>().mockRejectedValue(unsupportedError());
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    await expect(
      reader(SHA, 0, 5, new AbortController().signal),
    ).resolves.toEqual({ unavailable: "missing" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("propagates a HostRpcError whose code is not E_HOST_UNSUPPORTED", async () => {
    const error = new HostRpcError({
      code: "RPC_ERROR",
      message: "internal failure",
      requestId: "req-1",
      method: "epic.readArtifactObject",
      fatalDetails: null,
    });
    const request = vi.fn<ArtifactObjectRequest>().mockRejectedValue(error);
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    await expect(
      reader(SHA, 0, 5, new AbortController().signal),
    ).rejects.toBe(error);
  });

  it("propagates a plain transport failure unchanged", async () => {
    const boom = new Error("socket reset");
    const request = vi.fn<ArtifactObjectRequest>().mockRejectedValue(boom);
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    await expect(
      reader(SHA, 0, 5, new AbortController().signal),
    ).rejects.toBe(boom);
  });

  it("rejects on an unrecognized response shape instead of hanging", async () => {
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValue({ kind: "url", url: "https://example.invalid/x", expiresAt: 0 });
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    await expect(
      reader(SHA, 0, 5, new AbortController().signal),
    ).rejects.toThrow("Expected artifact object bytes");
  });

  it("polls again on 'downloading' with a doubling backoff, then resolves once bytes land", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValueOnce(downloadingResponse(0, 10))
      .mockResolvedValueOnce(downloadingResponse(5, 10))
      .mockResolvedValueOnce(bytesResponse(0, "0123456789", 10));
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    const pending = reader(SHA, 0, 10, new AbortController().signal);

    // First wait is the reader's initial 500ms; nothing has settled yet.
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);

    // The second wait doubles to 1000ms.
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);

    await expect(pending).resolves.toEqual({
      bytes: Uint8Array.from("0123456789", (character) => character.charCodeAt(0)),
      totalBytes: 10,
      mediaType: "text/plain",
    });
  });

  it("caps the backoff at 2 seconds across repeated 'downloading' answers", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValueOnce(downloadingResponse(0, 10)) // wait 500
      .mockResolvedValueOnce(downloadingResponse(0, 10)) // wait 1000
      .mockResolvedValueOnce(downloadingResponse(0, 10)) // wait 2000
      .mockResolvedValueOnce(downloadingResponse(0, 10)) // wait 2000 (capped)
      .mockResolvedValueOnce(bytesResponse(0, "x", 1));
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });

    const pending = reader(SHA, 0, 1, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(5);

    await expect(pending).resolves.toEqual({
      bytes: Uint8Array.from("x", (character) => character.charCodeAt(0)),
      totalBytes: 1,
      mediaType: "text/plain",
    });
  });

  it("stops waiting and never issues a second request once the caller aborts", async () => {
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValue(downloadingResponse(0, 10));
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });
    const controller = new AbortController();

    const pending = reader(SHA, 0, 10, controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-aborted signal before ever calling request", async () => {
    const request = vi.fn<ArtifactObjectRequest>();
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });
    const controller = new AbortController();
    controller.abort();

    await expect(
      reader(SHA, 0, 10, controller.signal),
    ).rejects.toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("aborts out of a pending download wait without a further request", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<ArtifactObjectRequest>()
      .mockResolvedValue(downloadingResponse(0, 10));
    const reader = createHostObjectReader({ request, epicId: EPIC_ID });
    const controller = new AbortController();

    const pending = reader(SHA, 0, 10, controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.runOnlyPendingTimersAsync();

    await expect(pending).rejects.toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
