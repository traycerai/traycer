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

import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
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
        actor: { userId: "u-me", displayName: "Me" },
      });
    });
    expect(endedSandboxHost("host-fine")).toBeNull();
  });
});
