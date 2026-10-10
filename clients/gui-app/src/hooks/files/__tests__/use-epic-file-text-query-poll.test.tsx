import { afterEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { EpicReadFileResponse } from "@traycer/protocol/host/epic/files";
import {
  EpicFileRpcContext,
  type EpicFileRpc,
} from "@/lib/files/epic-file-rpc";
import { HOST_METHOD_POLL_TABLE } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { epicFileBlobQueryOptions } from "@/hooks/files/use-epic-file-blob-query";
import {
  epicFileTextQueryOptions,
  useEpicFileTextQuery,
} from "@/hooks/files/use-epic-file-text-query";

const UNAVAILABLE: EpicReadFileResponse = {
  kind: "unavailable",
  reason: "upload-pending",
};

describe("epic.readFile condition poll", () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    cleanup();
    vi.useRealTimers();
  });

  it("classifies both unavailable shapes onto one lane", () => {
    const policy = HOST_METHOD_POLL_TABLE["epic.readFile"].poll;
    const lane = policy.classify(UNAVAILABLE);
    expect(lane).not.toBe(false);
    expect(policy.classify({ result: { kind: "unavailable" } })).toBe(lane);
    expect(policy.classify({ result: { kind: "url" } })).toBe(false);
    expect(policy.classify(undefined)).toBe(false);
  });

  it("refetches an unavailable read after 15s without a policy error", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const readFile = vi.fn(() => Promise.resolve(UNAVAILABLE));
    const rpc: EpicFileRpc = {
      readFile,
      fetchFile: vi.fn(),
      cancelFetchFile: vi.fn(),
    };
    const queryClient = createAppQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <EpicFileRpcContext value={rpc}>{children}</EpicFileRpcContext>
      </QueryClientProvider>
    );
    renderHook(
      () =>
        useEpicFileTextQuery("host-1", {
          epicId: "epic-1",
          path: "a.html",
          sha256: "a".repeat(64),
          via: null,
        }),
      { wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

describe("an imperative fetch of an epic.readFile query", () => {
  const ADDRESS = {
    epicId: "epic-1",
    path: "a.html",
    sha256: "a".repeat(64),
    via: null,
  };
  const TEXT: EpicReadFileResponse = {
    kind: "text",
    text: "<p>hi</p>",
    mediaType: "text/html",
    networkPolicy: "https-only",
  };
  const BYTES: EpicReadFileResponse = {
    kind: "bytes",
    bytesBase64: btoa("pdf"),
    offset: 0,
    totalBytes: 3,
    mediaType: "application/pdf",
  };

  function rpcAnswering(...answers: readonly EpicReadFileResponse[]) {
    const readFile = vi.fn<EpicFileRpc["readFile"]>();
    for (const answer of answers) readFile.mockResolvedValueOnce(answer);
    const rpc: EpicFileRpc = {
      readFile,
      fetchFile: vi.fn(),
      cancelFetchFile: vi.fn(),
    };
    return { rpc, readFile };
  }

  it("asks again at once for a cached unavailable text answer, and keeps a served one", async () => {
    const queryClient = createAppQueryClient();
    const { rpc, readFile } = rpcAnswering(UNAVAILABLE, TEXT);
    const options = epicFileTextQueryOptions("host-1", rpc, ADDRESS);

    expect(await queryClient.fetchQuery(options)).toEqual(UNAVAILABLE);
    expect(await queryClient.fetchQuery(options)).toEqual(TEXT);
    expect(readFile).toHaveBeenCalledTimes(2);

    // Content-addressed: the served bytes never go stale.
    expect(await queryClient.fetchQuery(options)).toEqual(TEXT);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("asks again at once for a cached unavailable blob answer, and keeps a served one", async () => {
    const queryClient = createAppQueryClient();
    const { rpc, readFile } = rpcAnswering(UNAVAILABLE, BYTES);
    const options = epicFileBlobQueryOptions("host-1", rpc, ADDRESS, null);

    expect((await queryClient.fetchQuery(options)).kind).toBe("unavailable");
    expect((await queryClient.fetchQuery(options)).kind).toBe("blob");
    expect(readFile).toHaveBeenCalledTimes(2);

    expect((await queryClient.fetchQuery(options)).kind).toBe("blob");
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
