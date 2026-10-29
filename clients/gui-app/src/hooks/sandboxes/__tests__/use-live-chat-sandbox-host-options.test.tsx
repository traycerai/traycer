import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import type { SandboxListFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";
import { sandboxSummaryFixture } from "./sandbox-fixtures";

const HOST = "sandbox-host";
const VIEWER = "viewer";
const sources = vi.hoisted<{
  binding: FakeSandboxBinding | null;
  serving: ChatServing | null;
}>(() => ({ binding: null, serving: null }));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => sources.binding,
}));
vi.mock("@/lib/chats/chat-serving-witness", () => ({
  useChatServing: () => sources.serving,
}));
vi.mock("@/hooks/chats/use-chat-stream-sync-state", () => ({
  useChatStreamSyncState: () => ({ status: "open", hasContent: true }),
}));
vi.mock("@/hooks/epic/use-task-sandbox-end", () => ({
  useTaskSandboxHost: () => ({ kind: "other" }),
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [], isError: false, isLoading: false }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-configurations")
    >()),
    useSandboxConfigurations: () => ({
      configurations: [{ kind: "personal" }],
    }),
  }),
);

import { useLiveChatSandboxState } from "@/hooks/sandboxes/use-live-chat-sandbox-state";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { ChatSandboxFooter } from "@/components/chat/chat-sandbox-footer";
import { resolveChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEndedSandboxHostsStore } from "@/stores/sandboxes/ended-sandbox-hosts-store";
import { authQueryKeys, sandboxQueryKeys } from "@/lib/query-keys";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";

function registry(state: "awake" | "stopped"): HostListResponse {
  return {
    hosts: [
      {
        hostId: HOST,
        displayName: "test-box",
        kind: "sandbox",
        platform: "linux",
        publicKey: "test-key",
        createdAt: "2026-10-28T00:00:00Z",
        updatePolicy: "manual",
        sandboxState: state,
        sandboxFrozen: false,
        status: {
          connectivity: "connectable",
          viewerReachability: "unknown",
          clientCloud: "ok",
          updateState: "current",
          appVersion: "1.0.0",
          lastSeenAt: "2026-10-28T00:00:00Z",
        },
      },
    ],
  };
}

function listed(state: "awake" | "stopped"): SandboxListFetchResult {
  return {
    kind: "ok",
    response: {
      sandboxes: [
        sandboxSummaryFixture({ hostId: HOST, displayName: "test-box", state }),
      ],
    },
  };
}

/** Real registry/list queries, host options, picker chip, and chat footer. */
function ChatHostStatus(): ReactNode {
  const live = useLiveChatSandboxState("epic", "chat", HOST, true);
  const view = resolveChatSandbox(live.state, {
    reachable: live.reachable,
    canEdit: true,
    ownedByViewer: true,
    environmentOwned: false,
  });
  const options = useHostOptions();
  return (
    <>
      <HostSwitcher
        hosts={options.hosts}
        selected={options.hosts.find((host) => host.hostId === HOST) ?? null}
        activeHostId={HOST}
        onSelect={() => undefined}
        action={null}
        surface="inline"
        intent="pin"
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        disabled={false}
        isLoading={options.isLoading}
        listsFailed={options.listsFailed}
        onRetryLists={options.retryLists}
        updateViewForHost={null}
        composer={null}
        environmentLabelForHost={null}
      />
      <ChatSandboxFooter line={view.line} />
    </>
  );
}

function setup() {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: VIEWER, username: "Viewer" },
  });
  sources.serving = { ownerHostId: HOST, state: "live", catchingUp: null };
  const fake = createFakeSandboxBinding();
  const fetchRegisteredHosts =
    vi.fn<(era: AuthEra) => Promise<HostListResponse | null>>();
  const binding = {
    ...fake,
    auth: {
      ...fake.auth,
      currentAuthEra: (): AuthEra => ({
        identity: VIEWER,
        credentialGeneration: 1,
      }),
      fetchRegisteredHosts,
    },
    directory: { ...fake.directory, getLocalEntry: () => null },
  };
  sources.binding = binding;
  binding.auth.listSandboxes.mockResolvedValue(listed("awake"));
  const runner = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://auth.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: false,
    traycerCli: null,
    hostManagement: null,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, gcTime: 0 },
    },
  });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext value={runner}>
        <ChatHostStatus />
      </RunnerHostContext>
    </QueryClientProvider>
  );
  return { binding, fetchRegisteredHosts, queryClient, tree };
}

afterEach(() => {
  cleanup();
  sources.binding = null;
  sources.serving = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useEndedSandboxHostsStore.setState({ byHostId: {} });
});

describe("a live chat's host chip after another client stops its sandbox", () => {
  it("refreshes the cached awake registry so the real chip agrees with the stopped footer", async () => {
    const { binding, fetchRegisteredHosts, tree } = setup();
    fetchRegisteredHosts.mockResolvedValue(registry("awake"));
    const chat = render(tree());
    await waitFor(() =>
      expect(
        screen.getByTestId("settings-host-switcher-status").textContent,
      ).toBe("awake"),
    );
    expect(fetchRegisteredHosts).toHaveBeenCalledTimes(1);

    fetchRegisteredHosts.mockResolvedValueOnce(registry("stopped"));
    binding.auth.listSandboxes.mockResolvedValueOnce(listed("stopped"));
    sources.serving = { ownerHostId: HOST, state: "at-rest", catchingUp: null };
    act(() => chat.rerender(tree()));

    await waitFor(() => {
      expect(
        screen.getByText(/test-box is stopped · your next message starts it/),
      ).toBeTruthy();
      expect(
        screen.getByTestId("settings-host-switcher-status").textContent,
      ).toBe("stopped");
    });
    expect(fetchRegisteredHosts).toHaveBeenCalledTimes(2);
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
  });

  it("discards an initial in-flight awake registry answer after the lifecycle edge", async () => {
    const { binding, fetchRegisteredHosts, queryClient, tree } = setup();
    let finishInitial: (answer: HostListResponse) => void = () => {
      throw new Error("initial registry read has not started");
    };
    const initialAnswer = new Promise<HostListResponse>((resolve) => {
      finishInitial = resolve;
    });
    fetchRegisteredHosts
      .mockReturnValueOnce(initialAnswer)
      .mockResolvedValue(registry("stopped"));
    const chat = render(tree());
    await waitFor(() => {
      expect(fetchRegisteredHosts).toHaveBeenCalledTimes(1);
      expect(
        queryClient.getQueryData<SandboxListResponse>(
          sandboxQueryKeys.list(binding.auth, VIEWER),
        )?.sandboxes[0].state,
      ).toBe("awake");
    });
    const registryKey = authQueryKeys.registeredHosts(binding.auth, VIEWER);
    const initialRead = queryClient.getQueryCache().find({
      queryKey: registryKey,
      exact: true,
    })?.promise;
    if (initialRead === undefined) throw new Error("expected initial read");
    // A canceled query rejects; the transport's old answer can still arrive.
    const initialSettled = initialRead.catch(() => undefined);

    binding.auth.listSandboxes.mockResolvedValueOnce(listed("stopped"));
    sources.serving = { ownerHostId: HOST, state: "at-rest", catchingUp: null };
    act(() => chat.rerender(tree()));
    await screen.findByText(
      /test-box is stopped · your next message starts it/,
    );
    await act(async () => {
      finishInitial(registry("awake"));
      await initialAnswer;
      await initialSettled;
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("settings-host-switcher-status").textContent,
      ).toBe("stopped");
      // Do not pass on a chip whose registry notification is still queued.
      expect(queryClient.getQueryData(registryKey)).toEqual(
        registry("stopped"),
      );
    });
    expect(fetchRegisteredHosts).toHaveBeenCalledTimes(2);
    expect(binding.auth.listSandboxes).toHaveBeenCalledTimes(2);
  });
});
