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

function scopeValue(
  hostId: string,
  withClient: boolean,
): ChatAttachmentScopeValue {
  return {
    epicId: "epic-1",
    chatId: CHAT_ID,
    hostId,
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
): Promise<Uint8Array> {
  const { result } = renderHook(() => useChatImageFetcher(), {
    wrapper: wrapperFor(scope),
  });
  return result.current(HASH, new AbortController().signal);
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

    await expect(fetchOnce(scopeValue("host-1", true))).resolves.toEqual(
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

    await expect(fetchOnce(scopeValue("host-1", true))).resolves.toEqual(
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

    await expect(fetchOnce(scopeValue("host-1", true))).rejects.toThrow(
      /unavailable/,
    );
    expect(docMocks.hasAttachmentBytes).toHaveBeenCalledWith(HASH);
    expect(docMocks.readAttachmentBytes).not.toHaveBeenCalled();
  });

  it("propagates a transient RPC failure so the blob cache retries it", async () => {
    request.mockRejectedValue(rpcError("RPC_ERROR"));
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(fetchOnce(scopeValue("host-1", true))).rejects.toThrow(
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

    await expect(fetchOnce(scopeValue("host-1", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(1);

    // Second image, same host: the verdict is cached per host, not re-probed.
    await expect(fetchOnce(scopeValue("host-1", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(1);

    // A different host is a different build - it gets its own probe.
    await expect(fetchOnce(scopeValue("host-2", true))).resolves.toEqual(
      DOC_BYTES,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("skips the RPC leg entirely with no chat scope", async () => {
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(fetchOnce(null)).resolves.toEqual(DOC_BYTES);
    expect(request).not.toHaveBeenCalled();
  });

  it("skips the RPC leg when the tile's host client is not resolved", async () => {
    docMocks.hasAttachmentBytes.mockReturnValue(true);
    docMocks.readAttachmentBytes.mockResolvedValue(DOC_BYTES);

    await expect(fetchOnce(scopeValue("host-1", false))).resolves.toEqual(
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

    await expect(fetchOnce(scopeValue("host-1", true))).rejects.toThrow(
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
