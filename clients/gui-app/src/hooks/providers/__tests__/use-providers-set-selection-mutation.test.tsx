import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

const mocks = vi.hoisted(() => ({
  client: {
    getActiveHostId: vi.fn(() => "host-a"),
    request: vi.fn(),
  },
}));

// Only the host client is faked: the mutation hook, `useHostMutation`, the
// real QueryClient and its invalidation all run for real.
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
  useHostRuntimeClient: () => mocks.client,
}));

import { useProvidersSetSelection } from "@/hooks/providers/use-providers-set-selection-mutation";

describe("useProvidersSetSelection catalog refresh", () => {
  afterEach(() => {
    cleanup();
    mocks.client.request.mockReset();
  });

  it("refetches the mounted model and command catalogs of the selecting host only", async () => {
    mocks.client.request.mockResolvedValue({
      state: { selected: { kind: "bundled", line: 1 } },
    });
    const queryClient = new QueryClient();
    const calls = new Map<string, number>();
    const observers: QueryObserver[] = [];

    // `staleTime: Infinity` is how the real catalog queries are mounted, so
    // only an explicit invalidation can make them refetch.
    const observe = (key: QueryKey, label: string): void => {
      const observer = new QueryObserver<unknown>(queryClient, {
        queryKey: key,
        queryFn: () => {
          calls.set(label, (calls.get(label) ?? 0) + 1);
          return Promise.resolve({});
        },
        staleTime: Infinity,
        retry: false,
      });
      observer.subscribe(() => undefined);
      observers.push(observer);
    };

    const models = { harnessId: "opencode", workingDirectory: null } as const;
    const commands: RequestOfMethod<HostRpcRegistry, "agent.gui.listCommands"> =
      {
        harnessId: "opencode",
        workingDirectory: null,
        workingDirectories: [],
        profileId: null,
      };
    observe(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listModels">(
        "host-a",
        "agent.gui.listModels",
        models,
      ),
      "host-a-models",
    );
    observe(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listCommands">(
        "host-a",
        "agent.gui.listCommands",
        commands,
      ),
      "host-a-commands",
    );
    observe(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listModels">(
        "host-b",
        "agent.gui.listModels",
        models,
      ),
      "host-b-models",
    );
    await Promise.all(observers.map((observer) => observer.refetch()));
    const before = new Map(calls);

    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useProvidersSetSelection(), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({
        providerId: "opencode",
        selection: { kind: "bundled", line: 1 },
      });
    });

    await waitFor(() => {
      expect(calls.get("host-a-models")).toBe(
        (before.get("host-a-models") ?? 0) + 1,
      );
      expect(calls.get("host-a-commands")).toBe(
        (before.get("host-a-commands") ?? 0) + 1,
      );
    });
    expect(calls.get("host-b-models")).toBe(before.get("host-b-models"));

    for (const observer of observers) observer.destroy();
  });
});
