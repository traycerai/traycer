import { afterEach, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import { AuthService } from "@/lib/auth/auth-service";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { budgetCatalogue } from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import { useAuthStore } from "@/stores/auth/auth-store";

let auth: AuthService | null = null;
let unavailable: string | null = null;
vi.mock("@/lib/host", () => ({
  useHostBinding: () => (auth === null ? null : { auth }),
}));
vi.mock("@/hooks/sandboxes/use-team-environment-query", () => ({
  useTeamEnvironment: () => ({ data: undefined }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => unavailable,
}));
import { useSandboxReadiness } from "@/hooks/sandboxes/use-sandbox-readiness-query";

const originalAuth = useAuthStore.getState();
afterEach(() => {
  cleanup();
  useAuthStore.setState(originalAuth);
  auth = null;
  unavailable = null;
});

function fixture() {
  auth = new AuthService({ runnerHost: createFakeRunnerHost({}) });
  useAuthStore.setState({ status: "signed-in" });
  const [provider] = budgetCatalogue(480_000).providers;
  const catalogue = {
    providers: [
      {
        ...provider,
        readiness: {
          request: {
            os: "linux" as const,
            shape: { cpus: 2, memoryMb: 4096, diskMb: 20480 },
            region: "us-east",
            generationId: null,
          },
          result: { warm: 2 },
        },
      },
    ],
  };
  const read = vi
    .spyOn(auth, "getSandboxCatalogue")
    .mockResolvedValue({ kind: "ok", catalogue });
  const client = createAppQueryClient();
  client.setDefaultOptions({
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    () =>
      useSandboxReadiness(
        { kind: "personal" },
        {
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
        },
      ),
    { wrapper },
  );
  return { client, read, ...hook };
}

it("hides cached warm inventory after the real readiness hook's refetch fails", async () => {
  const hook = fixture();
  await waitFor(() => expect(hook.result.current).toBe("2 ready now."));
  hook.read.mockResolvedValue({ kind: "network-error", detail: "offline" });
  await act(async () => {
    await hook.client.refetchQueries();
  });
  await waitFor(() => expect(hook.result.current).toBeNull());
  hook.unmount();
  hook.client.clear();
});

it("hides cached inventory when control-plane admission becomes disabled", async () => {
  const hook = fixture();
  await waitFor(() => expect(hook.result.current).toBe("2 ready now."));
  unavailable = "unavailable";
  hook.rerender();
  expect(hook.result.current).toBeNull();
  hook.unmount();
  hook.client.clear();
});
