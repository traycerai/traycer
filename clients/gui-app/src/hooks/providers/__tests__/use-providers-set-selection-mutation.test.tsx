import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

const mocks = vi.hoisted(() => ({
  client: {
    getActiveHostId: vi.fn(() => "host-a"),
    request: vi.fn(),
  },
  stream: {
    emitChanged: [] as Array<(providerId: ProviderId) => void>,
  },
}));

// Only the host client and the stream transport are faked: the mutation hooks,
// `useHostMutation`, the stream mount, the real QueryClient and its
// invalidation all run for real.
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
  useHostRuntimeClient: () => mocks.client,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/providers-changed-stream-client",
  () => ({
    ProvidersChangedStreamClient: class {
      constructor(options: {
        readonly onChanged: (providerId: ProviderId) => void;
      }) {
        mocks.stream.emitChanged.push(options.onChanged);
      }

      close(): void {}
    },
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => ({ stub: true }),
  useStreamMethodSupport: () => "supported",
  useStreamHostId: () => "host-a",
}));

import { useProvidersAddCustomPath } from "@/hooks/providers/use-providers-add-custom-path-mutation";
import { useProvidersRemoveCustomPath } from "@/hooks/providers/use-providers-remove-custom-path-mutation";
import { useProvidersSetSelection } from "@/hooks/providers/use-providers-set-selection-mutation";
import { ProvidersChangedStreamMount } from "@/providers/providers-changed-stream-mount";

const MODELS: RequestOfMethod<HostRpcRegistry, "agent.gui.listModels"> = {
  harnessId: "opencode",
  workingDirectory: null,
};
const COMMANDS: RequestOfMethod<HostRpcRegistry, "agent.gui.listCommands"> = {
  harnessId: "opencode",
  workingDirectory: null,
  workingDirectories: [],
  profileId: null,
};
const CUSTOM_PATH = "/opt/opencode/bin/opencode";

type CatalogLabel =
  | "host-a-models"
  | "host-a-commands"
  | "host-b-models"
  | "host-b-commands";

// `staleTime: Infinity` is how the real catalog queries are mounted, so only
// an explicit invalidation can make them refetch.
function mountCatalogs(queryClient: QueryClient) {
  const calls = new Map<CatalogLabel, number>();
  const observers: QueryObserver[] = [];
  const observe = (key: QueryKey, label: CatalogLabel): void => {
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
  for (const host of ["host-a", "host-b"] as const) {
    observe(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listModels">(
        host,
        "agent.gui.listModels",
        MODELS,
      ),
      `${host}-models`,
    );
    observe(
      hostQueryKeys.method<HostRpcRegistry, "agent.gui.listCommands">(
        host,
        "agent.gui.listCommands",
        COMMANDS,
      ),
      `${host}-commands`,
    );
  }
  return { calls, observers };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

const SELECTION_CHANGE_PATHS: ReadonlyArray<
  readonly [string, (queryClient: QueryClient) => Promise<void>]
> = [
  [
    "providers.setSelection",
    async (queryClient) => {
      const { result } = renderHook(() => useProvidersSetSelection(), {
        wrapper: wrapperFor(queryClient),
      });
      await act(async () => {
        await result.current.mutateAsync({
          providerId: "opencode",
          selection: { kind: "bundled", line: 1 },
        });
      });
    },
  ],
  [
    "providers.addCustomPath",
    async (queryClient) => {
      const { result } = renderHook(() => useProvidersAddCustomPath(), {
        wrapper: wrapperFor(queryClient),
      });
      await act(async () => {
        await result.current.mutateAsync({
          providerId: "opencode",
          path: CUSTOM_PATH,
        });
      });
    },
  ],
  [
    "providers.removeCustomPath",
    async (queryClient) => {
      const { result } = renderHook(() => useProvidersRemoveCustomPath(), {
        wrapper: wrapperFor(queryClient),
      });
      await act(async () => {
        await result.current.mutateAsync({
          providerId: "opencode",
          path: CUSTOM_PATH,
        });
      });
    },
  ],
  [
    "the providers.changed stream event",
    (queryClient) => {
      render(<ProvidersChangedStreamMount />, {
        wrapper: wrapperFor(queryClient),
      });
      const emit = mocks.stream.emitChanged.at(-1);
      if (emit === undefined) throw new Error("no providers stream opened");
      act(() => {
        emit("opencode");
      });
      return Promise.resolve();
    },
  ],
];

describe("a provider selection change refreshes the model and command catalogs", () => {
  afterEach(() => {
    cleanup();
    resetHostConnectionRegistryForTest();
    mocks.client.request.mockReset();
    mocks.stream.emitChanged.length = 0;
  });

  it.each(SELECTION_CHANGE_PATHS)(
    "after %s, on the changed host only",
    async (_label, drive) => {
      mocks.client.request.mockResolvedValue({
        state: { selected: { kind: "bundled", line: 1 } },
      });
      const queryClient = new QueryClient();
      const { calls, observers } = mountCatalogs(queryClient);
      await Promise.all(observers.map((observer) => observer.refetch()));
      const before = new Map(calls);

      await drive(queryClient);

      await waitFor(() => {
        expect(calls.get("host-a-models")).toBe(
          (before.get("host-a-models") ?? 0) + 1,
        );
        expect(calls.get("host-a-commands")).toBe(
          (before.get("host-a-commands") ?? 0) + 1,
        );
      });
      expect(calls.get("host-b-models")).toBe(before.get("host-b-models"));
      expect(calls.get("host-b-commands")).toBe(before.get("host-b-commands"));

      for (const observer of observers) observer.destroy();
    },
  );
});
