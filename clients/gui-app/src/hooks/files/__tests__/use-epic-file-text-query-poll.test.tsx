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
import { useEpicFileTextQuery } from "@/hooks/files/use-epic-file-text-query";

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
