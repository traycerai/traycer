import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";
import {
  sandboxOperationFixture,
  sandboxSummaryFixture,
} from "./sandbox-fixtures";

const state = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => state.binding,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => null,
}));

import {
  sandboxListReadSentAt,
  useSandboxList,
} from "@/hooks/sandboxes/use-sandbox-list-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  endedSandboxHost,
  useEndedSandboxHostsStore,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

describe("the sandbox list query", () => {
  beforeEach(() => {
    state.binding = createFakeSandboxBinding();
    useEndedSandboxHostsStore.setState({ byHostId: {} });
    act(() => {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId: "u-me", username: "me" },
      });
    });
  });
  afterEach(() => {
    cleanup();
    act(() => {
      useAuthStore.setState({ status: "signed-out", contextMetadata: null });
    });
  });

  it("records a row a member is destroying as an ended host, before its session ends", async () => {
    state.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: {
        sandboxes: [
          sandboxSummaryFixture({
            id: "sbx-gone",
            hostId: "host-gone",
            displayName: "e2e-sbx-win2",
            operation: sandboxOperationFixture({
              state: "destroying",
              at: 7_000,
            }),
          }),
          sandboxSummaryFixture({
            id: "sbx-fine",
            hostId: "host-fine",
            operation: null,
          }),
        ],
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useSandboxList(), { wrapper });

    await waitFor(() => {
      expect(endedSandboxHost("host-gone")).toEqual({
        name: "e2e-sbx-win2",
        at: 7_000,
        cause: "verb",
        actor: { userId: "u-me", displayName: "Me" },
        idleMinutes: null,
      });
    });
    expect(endedSandboxHost("host-fine")).toBeNull();
  });

  it("stamps each answer with the time its own request was sent, not when it arrived, even for an identical list", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(1_000);
    const list = { sandboxes: [sandboxSummaryFixture({ id: "sbx-1" })] };
    let answer: (value: { kind: "ok"; response: typeof list }) => void = () =>
      undefined;
    state.binding?.auth.listSandboxes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSandboxList(), { wrapper });
    await waitFor(() => {
      expect(state.binding?.auth.listSandboxes).toHaveBeenCalledTimes(1);
    });

    // The request is on its way; the answer arrives later.
    clock.mockReturnValue(5_000);
    act(() => {
      answer({ kind: "ok", response: list });
    });
    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(sandboxListReadSentAt(result.current.data)).toBe(1_000);

    // An identical answer keeps its own send time.
    clock.mockReturnValue(9_000);
    state.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: { sandboxes: list.sandboxes },
    });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => {
      expect(sandboxListReadSentAt(result.current.data)).toBe(9_000);
    });
    clock.mockRestore();
  });
});
