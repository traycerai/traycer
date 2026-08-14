import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ReadChatAttachmentRequest,
  ReadChatAttachmentResponse,
} from "@traycer/protocol/host/epic/chat-attachment";

import {
  ChatAttachmentScopeContext,
  type ChatAttachmentReadClient,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import type { ImageBytesResult } from "@/lib/attachments/image-blob-cache";
import {
  resetChatAttachmentHostSupportForTests,
  useChatAttachmentByteReader,
  useChatImageFetcher,
} from "@/lib/attachments/use-chat-image-fetcher";

/**
 * The chat-plane byte chain: `epic.readChatAttachment` on the tile's host
 * first, the epic doc replica only as the legacy fallback.
 *
 * The load-bearing case is a chat whose doc `attachments` map is EMPTY - which
 * is every chat once bytes stop being written into the document - so most of
 * these tests hold `hasAttachmentBytes` at false and assert the image resolves
 * anyway. The second load-bearing case is the inverse: `readAttachmentBytes`
 * waits indefinitely for a hash the replica does not hold, so the chain must
 * never reach it without the presence guard passing first.
 */

const docMocks = vi.hoisted(() => ({
  hasAttachmentBytes: vi.fn((_hash: string) => false),
  readAttachmentBytes: vi.fn(
    (_hash: string, _signal: AbortSignal): Promise<Uint8Array | null> =>
      Promise.resolve(null),
  ),
  present: true,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () =>
    docMocks.present
      ? {
          epicId: "epic-1",
          store: {
            getState: () => ({
              hasAttachmentBytes: docMocks.hasAttachmentBytes,
              readAttachmentBytes: docMocks.readAttachmentBytes,
            }),
          },
        }
      : null,
}));

const HASH = "a".repeat(64);
const CHAT_ID = "chat-1";
const CHAT_PLANE_BYTES = new Uint8Array([1, 2, 3]);
const DOC_BYTES = new Uint8Array([9, 9]);
/** base64 of CHAT_PLANE_BYTES. */
const CHAT_PLANE_BASE64 = "AQID";

const request =
  vi.fn<
    (
      method: "epic.readChatAttachment",
      params: ReadChatAttachmentRequest,
      signal: AbortSignal | undefined,
    ) => Promise<ReadChatAttachmentResponse>
  >();

const stubClient: ChatAttachmentReadClient = {
  requestWithSignal: (method, params, signal) =>
    request(method, params, signal),
};

const HOST_VERSION = "1.4.0";

function scopeValue(
  hostId: string,
  withClient: boolean,
): ChatAttachmentScopeValue {
  return scopeAt(hostId, HOST_VERSION, withClient);
}

function scopeAt(
  hostId: string,
  hostVersion: string | null,
  withClient: boolean,
): ChatAttachmentScopeValue {
  return {
    epicId: "epic-1",
    chatId: CHAT_ID,
    hostId,
    hostVersion,
    client: withClient ? stubClient : null,
  };
}

function wrapperFor(scope: ChatAttachmentScopeValue | null) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <ChatAttachmentScopeContext.Provider value={scope}>
        {children}
      </ChatAttachmentScopeContext.Provider>
    );
  };
}

function rpcError(code: "E_HOST_UNSUPPORTED" | "RPC_ERROR"): HostRpcError {
  return new HostRpcError({
    code,
    message: code === "E_HOST_UNSUPPORTED" ? "unsupported" : "socket died",
    requestId: "req-1",
    method: "epic.readChatAttachment",
    fatalDetails: null,
  });
}

function fetchOnce(
  scope: ChatAttachmentScopeValue | null,
): Promise<ImageBytesResult> {
  const { result } = renderHook(() => useChatImageFetcher(), {
    wrapper: wrapperFor(scope),
  });
  return result.current(HASH, new AbortController().signal);
}

/** The bytes alone, for the many assertions that do not care about the type. */
async function bytesOnce(
  scope: ChatAttachmentScopeValue | null,
): Promise<Uint8Array> {
  return (await fetchOnce(scope)).bytes;
}

beforeEach(() => {
  resetChatAttachmentHostSupportForTests();
  request.mockReset();
  docMocks.present = true;
  docMocks.hasAttachmentBytes.mockReset();
  docMocks.hasAttachmentBytes.mockReturnValue(false);
  docMocks.readAttachmentBytes.mockReset();
  docMocks.readAttachmentBytes.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChatImageFetcher", () => {
  it("serves a sent message's image from the host while the doc map is empty", async () => {
    request.mockResolvedValue({
      ok: true,
      bytesBase64: CHAT_PLANE_BASE64,
      mediaType: "image/png",
    });

    await expect(bytesOnce(scopeValue("host-1", true))).resolves.toEqual(
      CHAT_PLANE_BYTES,
    );

    expect(request).toHaveBeenCalledWith(
      "epic.readChatAttachment",
      { epicId: "epic-1", chatId: CHAT_ID, hash: HASH },
      expect.any(AbortSignal),
    );
    // The doc replica is not consulted at all on a chat-plane hit.
    expect(docMocks.hasAttachmentBytes).not.toHaveBeenCalled();
    expect(docMocks.readAttachmentBytes).not.toHaveBeenCalled();
  });

  it("falls back to the doc replica when the host answers missing", async () => {
    request.mockResolvedValue({ ok: false, reason: "missing" });
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(bytesOnce(scopeValue("host-1", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(docMocks.readAttachmentBytes).toHaveBeenCalledWith(
      HASH,
      expect.any(AbortSignal),
    );
  });

  it("never calls the indefinitely-waiting doc read without a presence hit", async () => {
    request.mockResolvedValue({ ok: false, reason: "missing" });
    docMocks.hasAttachmentBytes.mockReturnValue(false);

    await expect(bytesOnce(scopeValue("host-1", true))).rejects.toThrow(
      /unavailable/,
    );
    expect(docMocks.hasAttachmentBytes).toHaveBeenCalledWith(HASH);
    expect(docMocks.readAttachmentBytes).not.toHaveBeenCalled();
  });

  it("propagates a transient RPC failure so the blob cache retries it", async () => {
    request.mockRejectedValue(rpcError("RPC_ERROR"));
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(bytesOnce(scopeValue("host-1", true))).rejects.toThrow(
      "socket died",
    );
    // A dropped socket is not "these bytes moved to the doc" - the fallback
    // must not silently absorb it into a legacy read.
    expect(docMocks.readAttachmentBytes).not.toHaveBeenCalled();
  });

  it("skips the RPC leg permanently for a host that answers E_HOST_UNSUPPORTED", async () => {
    request.mockRejectedValue(rpcError("E_HOST_UNSUPPORTED"));
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(bytesOnce(scopeValue("host-1", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(1);

    // Second image, same build: the verdict is cached, not re-derived.
    await expect(bytesOnce(scopeValue("host-1", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(1);

    // A different host is a different build - it gets its own probe.
    await expect(bytesOnce(scopeValue("host-2", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("re-probes once the same host id is running a newer build", async () => {
    request.mockRejectedValue(rpcError("E_HOST_UNSUPPORTED"));
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(bytesOnce(scopeAt("host-1", "1.4.0", true))).resolves.toEqual(
      DOC_BYTES,
    );
    await expect(bytesOnce(scopeAt("host-1", "1.4.0", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(1);

    // Traycer can install and activate a newer host under the SAME id with no
    // renderer reload. Keyed on the id alone the verdict would outlive the
    // build that produced it, and chat-plane-only images - whose bytes are not
    // in the doc replica at all - would stay unavailable until a full reload.
    request.mockReset();
    request.mockResolvedValue({
      ok: true,
      bytesBase64: CHAT_PLANE_BASE64,
      mediaType: "image/png",
    });
    await expect(bytesOnce(scopeAt("host-1", "1.5.0", true))).resolves.toEqual(
      CHAT_PLANE_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never pins a verdict for a host whose build is not yet known", async () => {
    request.mockRejectedValue(rpcError("E_HOST_UNSUPPORTED"));
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(bytesOnce(scopeAt("host-1", null, true))).resolves.toEqual(
      DOC_BYTES,
    );
    await expect(bytesOnce(scopeAt("host-1", null, true))).resolves.toEqual(
      DOC_BYTES,
    );

    // An unknown version cannot name a build, so remembering under it would be
    // a verdict no upgrade could ever clear. Re-deriving is the safe answer.
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("carries the host's sniffed media type alongside the bytes", async () => {
    // The host derives this from the delivered bytes' magic bytes and never
    // echoes a client claim, so it is the only trustworthy statement about
    // what the image IS - and the SVG sanitization gate downstream keys on it.
    request.mockResolvedValue({
      ok: true,
      bytesBase64: CHAT_PLANE_BASE64,
      mediaType: "image/svg+xml",
    });

    await expect(fetchOnce(scopeValue("host-1", true))).resolves.toEqual({
      bytes: CHAT_PLANE_BYTES,
      mediaType: "image/svg+xml",
    });
  });

  it("offers no media-type verdict for a doc-replica read", async () => {
    request.mockResolvedValue({ ok: false, reason: "missing" });
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(fetchOnce(scopeValue("host-1", true))).resolves.toEqual({
      bytes: DOC_BYTES,
      mediaType: null,
    });
  });

  it("skips the RPC leg entirely with no chat scope", async () => {
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(bytesOnce(null)).resolves.toEqual(DOC_BYTES);
    expect(request).not.toHaveBeenCalled();
  });

  it("skips the RPC leg when the tile's host client is not resolved", async () => {
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(bytesOnce(scopeValue("host-1", false))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("treats an undecodable body as a retryable failure, not a miss", async () => {
    request.mockResolvedValue({
      ok: true,
      bytesBase64: "!!!not base64!!!",
      mediaType: "image/png",
    });

    await expect(bytesOnce(scopeValue("host-1", true))).rejects.toThrow(
      /undecodable/,
    );
  });
});

describe("useChatAttachmentByteReader", () => {
  it("answers bytes through the same chain", async () => {
    request.mockResolvedValue({
      ok: true,
      bytesBase64: CHAT_PLANE_BASE64,
      mediaType: "image/png",
    });
    const { result } = renderHook(() => useChatAttachmentByteReader(), {
      wrapper: wrapperFor(scopeValue("host-1", true)),
    });

    await expect(result.current(HASH)).resolves.toEqual(CHAT_PLANE_BYTES);
  });

  it("answers null instead of throwing so a copy keeps its hash-only node", async () => {
    request.mockResolvedValue({ ok: false, reason: "missing" });
    const { result } = renderHook(() => useChatAttachmentByteReader(), {
      wrapper: wrapperFor(scopeValue("host-1", true)),
    });

    await expect(result.current(HASH)).resolves.toBeNull();
  });
});
