import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { GitGetCapabilitiesResponse } from "@traycer/protocol/host";
import { useGitCapabilitiesQuery } from "../use-git-capabilities-query";

const request = vi.fn();
const mockHostClient = {
  request,
  requestWithSignal: request,
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "test-host",
    isReady: true,
  }),
}));

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useGitCapabilitiesQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns pending state initially", () => {
    mockHostClient.request.mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves
        }),
    );

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir",
          enabled: true,
        }),
      { wrapper },
    );

    expect(result.current.isPending).toBe(true);
  });

  it("returns available: true with git version", async () => {
    const response: GitGetCapabilitiesResponse = {
      available: true,
      gitVersion: "2.42.0",
      reason: null,
    };

    mockHostClient.request.mockResolvedValue(response);

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
  });

  it("returns available: false with reason", async () => {
    const response: GitGetCapabilitiesResponse = {
      available: false,
      gitVersion: null,
      reason: "git not found in PATH",
      repoMode: undefined,
    };

    mockHostClient.request.mockResolvedValue(response);

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(false);
    expect(result.current.data?.reason).toBe("git not found in PATH");
  });

  it("disables query when hostId is null", () => {
    const wrapper = makeWrapper();
    renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: null,
          runningDir: "/test/dir",
          enabled: true,
        }),
      { wrapper },
    );

    expect(mockHostClient.request).not.toHaveBeenCalled();
  });

  it("disables query when enabled is false", () => {
    const wrapper = makeWrapper();
    renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir",
          enabled: false,
        }),
      { wrapper },
    );

    expect(mockHostClient.request).not.toHaveBeenCalled();
  });

  it("caches results on second mount with same params", async () => {
    const response: GitGetCapabilitiesResponse = {
      available: true,
      gitVersion: "2.42.0",
      reason: null,
    };

    mockHostClient.request.mockResolvedValue(response);

    const wrapper = makeWrapper();
    const { result: result1 } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result1.current.isSuccess).toBe(true));
    const callCount1 = mockHostClient.request.mock.calls.length;

    const { result: result2 } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result2.current.isSuccess).toBe(true));
    expect(mockHostClient.request.mock.calls.length).toBe(callCount1);
    expect(result2.current.data).toEqual(response);
  });

  it("refetches on different params", async () => {
    const response1: GitGetCapabilitiesResponse = {
      available: true,
      gitVersion: "2.42.0",
      reason: null,
    };
    const response2: GitGetCapabilitiesResponse = {
      available: false,
      gitVersion: null,
      reason: "repo too large",
      repoMode: "refused",
    };

    mockHostClient.request
      .mockResolvedValueOnce(response1)
      .mockResolvedValueOnce(response2);

    const wrapper = makeWrapper();
    const { result: result1 } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir1",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result1.current.isSuccess).toBe(true));

    const { result: result2 } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir2",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result2.current.isSuccess).toBe(true));
    expect(result2.current.data?.reason).toBe("repo too large");
  });

  it("handles RPC error", async () => {
    const error = new HostRpcError({
      code: "RPC_ERROR",
      message: "Internal host error",
      requestId: "req-123",
      method: "git.getCapabilities",
      fatalDetails: null,
    });

    mockHostClient.request.mockRejectedValue(error);

    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useGitCapabilitiesQuery({
          hostId: "test-host",
          runningDir: "/test/dir",
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeTruthy();
  });
});
