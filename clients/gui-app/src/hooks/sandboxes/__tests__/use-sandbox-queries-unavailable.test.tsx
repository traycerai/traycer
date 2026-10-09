import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A build that cannot reach the sandbox control plane (staging) reads nothing:
 * the list, costs and catalogue queries stay disabled, so no surface reports a
 * failed read and `AuthService` is never even asked.
 */

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  /** `IRunnerHost.sandboxControlUnavailableReason` as the hooks read it. */
  unavailableReason: null as string | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({
    sandboxControlUnavailableReason: mocks.unavailableReason,
  }),
}));

import { useSandboxCatalogue } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.unavailableReason = null;
  useAuthStore.setState({ status: "signed-in" });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out" });
});

describe("the sandbox queries on a build that cannot reach the control plane", () => {
  it("does not fetch the list while the reason is set, and never calls AuthService", async () => {
    mocks.unavailableReason = "Sandboxes aren't available in staging builds.";
    const { result } = renderHook(() => useSandboxList(), {
      wrapper: wrapper(),
    });

    // Let any fetch that was going to start do so.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.binding?.auth.listSandboxes).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
    expect(result.current.isError).toBe(false);
  });

  it("does not fetch the costs or the catalogue while the reason is set", async () => {
    mocks.unavailableReason = "Sandboxes aren't available in staging builds.";
    const costs = renderHook(() => useSandboxCosts(), { wrapper: wrapper() });
    const catalogue = renderHook(() => useSandboxCatalogue(true), {
      wrapper: wrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(costs.result.current.fetchStatus).toBe("idle");
    expect(catalogue.result.current.fetchStatus).toBe("idle");
    expect(costs.result.current.isError).toBe(false);
    expect(catalogue.result.current.isError).toBe(false);
  });

  it("control: with no reason the signed-in list is read", async () => {
    mocks.binding?.auth.listSandboxes.mockResolvedValue({
      kind: "ok",
      response: {
        sandboxes: [sandboxSummaryFixture({ id: "sbx_1", hostId: "host-1" })],
      },
    });
    const { result } = renderHook(() => useSandboxList(), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.data?.sandboxes).toHaveLength(1);
    });
    expect(mocks.binding?.auth.listSandboxes).toHaveBeenCalledTimes(1);
  });
});
