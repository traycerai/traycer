import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  resetNegotiatedManifests,
  recordNegotiatedHostManifest,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useRegisteredHostEnvironmentStatuses } from "@/hooks/environment/use-registered-host-environment-statuses";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";

const binding = vi.hoisted(
  (): { client: HostClient<HostRpcRegistry> | null } => ({ client: null }),
);
vi.mock("@/lib/host", async (original) => ({
  ...(await original<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    binding.client === null ? null : { hostClient: binding.client },
}));
afterEach(() => {
  cleanup();
  binding.client = null;
  resetNegotiatedManifests();
});

it("re-enables a failed status observer when the route returns", async () => {
  const hostId = "reconnected-host";
  let reads = 0;
  const answer = environmentStatusFixture({});
  binding.client = buildEnvironmentClient({
    hostId,
    handlers: {
      "environment.status": () => {
        reads += 1;
        if (reads === 1) throw new Error("status unavailable");
        return answer;
      },
    },
  }).client;
  recordNegotiatedHostManifest(hostId, {
    "environment.status": { major: 1, minor: 2 },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
    hostId,
    "environment.status",
    {},
  );
  const hook = renderHook(
    ({ connectable }: { readonly connectable: boolean }) =>
      useRegisteredHostEnvironmentStatuses([{ hostId, connectable }]),
    {
      initialProps: { connectable: true },
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKey)?.status).toBe("error"),
  );
  hook.rerender({ connectable: false });
  await act(async () => {
    await queryClient.refetchQueries({ queryKey });
  });
  expect(reads).toBe(1);
  hook.rerender({ connectable: true });
  await waitFor(() => expect(hook.result.current.get(hostId)).toEqual(answer));
  expect(reads).toBe(2);
});
