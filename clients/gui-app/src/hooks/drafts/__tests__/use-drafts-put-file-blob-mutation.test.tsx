import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filePutIdempotencyKey,
  useDraftsPutFileBlob,
  usePutFileBlob,
} from "@/hooks/drafts/use-drafts-put-file-blob-mutation";
import type {
  FileAttachmentUploadClient,
  FilePutRequest,
} from "@/lib/composer/file-attachment-upload";
import { UNUSED_REQUESTER } from "@/lib/composer/__tests__/file-attachment-fixtures";

type RequestWithOptions = FileAttachmentUploadClient["requestWithOptions"];

const REQUEST: FilePutRequest = {
  kind: "file",
  sha256: "a".repeat(64),
  bytesBase64: "aGk=",
  fileName: "notes.txt",
  mediaType: "text/plain",
};

function wrapper({ children }: { readonly children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("useDraftsPutFileBlob", () => {
  it("dispatches on the target's own client with the digest key, the 1.2 floor and the two-minute budget", async () => {
    const requestWithOptions = vi
      .fn<RequestWithOptions>()
      .mockResolvedValue({ ok: true });
    const controller = new AbortController();
    const { result } = renderHook(
      () => {
        const mutation = useDraftsPutFileBlob();
        return { mutation, put: usePutFileBlob(mutation) };
      },
      { wrapper },
    );

    let response: unknown = null;
    await act(async () => {
      response = await result.current.put({
        target: {
          hostId: "host-b",
          client: { ...UNUSED_REQUESTER, requestWithOptions },
        },
        request: REQUEST,
        signal: controller.signal,
      });
    });

    expect(response).toEqual({ ok: true });
    expect(requestWithOptions).toHaveBeenCalledTimes(1);
    expect(requestWithOptions).toHaveBeenCalledWith("drafts.putBlob", REQUEST, {
      idempotencyKey: filePutIdempotencyKey(REQUEST),
      requiredHostMethodVersion: {
        method: "drafts.putBlob",
        version: { major: 1, minor: 2 },
      },
      responseTimeoutMs: 120_000,
      signal: controller.signal,
    });
    // The body is up to 22 MB of base64: nothing may keep it once answered.
    await waitFor(() => {
      expect(result.current.mutation.variables).toBeUndefined();
    });
  });
});

describe("filePutIdempotencyKey", () => {
  it("is the same for a replay and apart for the same bytes under another name or type, or the image put's digest key", () => {
    const key = filePutIdempotencyKey(REQUEST);

    expect(filePutIdempotencyKey({ ...REQUEST })).toBe(key);
    expect(key).not.toBe(REQUEST.sha256);
    expect(
      filePutIdempotencyKey({ ...REQUEST, fileName: "copy.txt" }),
    ).not.toBe(key);
    expect(
      filePutIdempotencyKey({ ...REQUEST, mediaType: "text/markdown" }),
    ).not.toBe(key);
  });

  it("is null past the host's 512-character key ceiling, and within it otherwise", () => {
    expect(
      filePutIdempotencyKey({ ...REQUEST, fileName: "n".repeat(600) }),
    ).toBeNull();
    expect(filePutIdempotencyKey(REQUEST)?.length).toBeLessThanOrEqual(512);
  });
});
