import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  RemoteHostFetchOutcome,
  RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { usePersonalHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useWindowHostRunsPersonal } from "@/components/settings/personal/use-window-host-runs-personal";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { registerHostPickerDirectory } from "@/hooks/host/use-host-picker-list";
import type { HostRpcRegistry } from "@/lib/host";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { uiQueryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const binding = vi.hoisted(() => ({
  directory: null as HostDirectoryService | null,
  client: null as HostClient<HostRpcRegistry> | null,
  registry: [] as HostListItem[],
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    binding.directory === null ? null : { directory: binding.directory },
  useHostClient: () => {
    if (binding.client === null) throw new Error("No window client");
    return binding.client;
  },
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: { hosts: binding.registry },
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: { sandboxes: [] },
    isError: false,
    isLoading: false,
    isPending: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));

vi.mock("@/hooks/host/use-remote-sessions-poll-readiness", () => ({
  useRemoteSessionsPollReadiness: () => () => false,
}));

const WINDOW_HOST_ID = "window-computer";
const OTHER_HOST_ID = "other-computer";
const WINDOW_HOST_VERSION = "9.9.9";

const baseWindowEntry = remoteEntry(WINDOW_HOST_ID, null);
const windowEntry = {
  ...baseWindowEntry,
  version: WINDOW_HOST_VERSION,
  remoteStatus: {
    ...baseWindowEntry.remoteStatus,
    appVersion: WINDOW_HOST_VERSION,
  },
};

function makeDirectory(fetchRemote: RemoteHostFetcher) {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: false,
    traycerCli: undefined,
    hostManagement: null,
  });
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: fetchRemote,
    onRegistryPollTick: null,
    authContextId: null,
    credentialGeneration: null,
    localHostIdSeeder: null,
  });
  const readStatus = vi.fn(() => environmentStatusFixture({}));
  const { client } = buildEnvironmentClient({
    hostId: WINDOW_HOST_ID,
    handlers: { "environment.status": readStatus },
  });
  binding.directory = directory;
  binding.client = client;
  binding.registry = [
    {
      hostId: WINDOW_HOST_ID,
      displayName: "Window computer",
      platform: "linux",
      kind: "personal",
      publicKey: "fixture-public-key",
      createdAt: "2026-01-01T00:00:00Z",
      updatePolicy: "manual",
      status: windowEntry.remoteStatus,
    },
  ];
  useSelectionAuthorityStore.setState({ effectiveHostId: WINDOW_HOST_ID });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = (props: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        {props.children}
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  return {
    directory,
    queryClient,
    readStatus,
    render: () =>
      renderHook(
        () => {
          const scope = usePersonalHostScope();
          return { scope, answer: useWindowHostRunsPersonal(scope) };
        },
        { wrapper },
      ),
  };
}

afterEach(() => {
  cleanup();
  binding.directory?.dispose();
  binding.directory = null;
  binding.client = null;
  binding.registry = [];
  useSelectionAuthorityStore.getState().reset();
  resetNegotiatedManifests();
});

describe("Personal Settings host discovery", () => {
  it("waits for the first discovery before using a missing cached route", async () => {
    const fetchRemote = vi.fn<RemoteHostFetcher>();
    const initial = Promise.withResolvers<RemoteHostFetchOutcome>();
    fetchRemote.mockReturnValue(initial.promise);
    const { directory, render } = makeDirectory(fetchRemote);
    const firstDiscovery = directory.refresh();
    const { result } = render();

    await waitFor(() => expect(result.current.scope.isLoading).toBe(false));
    expect(result.current.scope.host?.hostId).toBe(WINDOW_HOST_ID);
    expect(result.current.scope.host?.entry).toBeNull();
    expect(directory.hasConcludedDiscovery()).toBe(false);
    expect.soft(result.current.answer.runs).toBeNull();

    await act(async () => {
      initial.resolve({ kind: "hosts", entries: [] });
      await firstDiscovery;
    });
    expect(directory.hasConcludedDiscovery()).toBe(true);
    await waitFor(() => expect(result.current.answer.runs).toBe(false));
  });

  it("keeps a missing cached route unsettled when the snapshot query rejects", async () => {
    const fetchRemote = vi.fn<RemoteHostFetcher>().mockResolvedValue({
      kind: "hosts",
      entries: [remoteEntry(OTHER_HOST_ID, null)],
    });
    const { directory, queryClient, render } = makeDirectory(fetchRemote);
    await directory.refresh();
    const { result } = render();
    const queryKey = uiQueryKeys.hostPicker(
      registerHostPickerDirectory(directory),
    );
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKey)?.status).toBe("success"),
    );
    expect(result.current.answer.runs).toBe(false);

    const snapshot = vi
      .spyOn(directory, "list")
      .mockRejectedValueOnce(new Error("Snapshot failed"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey });
    });

    expect(queryClient.getQueryState(queryKey)?.status).toBe("error");
    expect(queryClient.getQueryData(queryKey)).toBeDefined();
    expect(directory.hasFailedDiscovery()).toBe(false);
    expect.soft(result.current.answer.runs).toBeNull();
    expect(result.current.scope.unresolvedDirectoryRoute).toBe("failed");
    snapshot.mockRestore();
  });

  it("holds a missing cached route after failed discovery and retries the real directory", async () => {
    const fetchRemote = vi.fn<RemoteHostFetcher>();
    fetchRemote
      .mockResolvedValueOnce({
        kind: "hosts",
        entries: [remoteEntry(OTHER_HOST_ID, null)],
      })
      .mockResolvedValueOnce({ kind: "failed" })
      .mockResolvedValue({ kind: "hosts", entries: [windowEntry] });
    const { directory, readStatus, render } = makeDirectory(fetchRemote);
    await directory.refresh();
    const { result } = render();

    await waitFor(() => expect(result.current.answer.runs).toBe(false));
    expect(result.current.scope.host?.entry).toBeNull();
    expect(result.current.scope.hosts.map((host) => host.hostId)).toContain(
      OTHER_HOST_ID,
    );

    await act(async () => {
      await directory.refresh();
    });
    expect(directory.hasFailedDiscovery()).toBe(true);
    expect((await directory.list()).map(({ hostId }) => hostId)).toContain(
      OTHER_HOST_ID,
    );
    expect(result.current.scope.host?.entry).toBeNull();
    expect.soft(result.current.answer.runs).toBeNull();
    expect.soft(result.current.scope.unresolvedDirectoryRoute).toBe("failed");

    act(() => {
      recordNegotiatedHostMethods(WINDOW_HOST_ID, ["environment.status"]);
      result.current.scope.retryLists();
    });
    expect(fetchRemote).toHaveBeenCalledTimes(3);

    await waitFor(() => expect(result.current.answer.runs).toBe(true));
    expect(result.current.scope.hostId).toBe(WINDOW_HOST_ID);
    expect(readStatus).toHaveBeenCalledTimes(1);
  });
});
