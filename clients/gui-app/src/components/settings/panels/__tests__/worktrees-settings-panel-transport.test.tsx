// A failed read of the host's worktree list: the computer never answering
// shows the away notice, anything it answered keeps the list's own error line.
// The scope the notice names is the REAL `useHostScope`; only the host lists it
// reads, the host's reachability and the host client are stood in.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

const client = vi.hoisted(
  (): {
    current: unknown;
    byHostId: Record<string, unknown>;
    hostIds: string[];
    activeHostId: string | null;
    personalMembershipHostIds: string[];
  } => ({
    current: null,
    byHostId: {},
    hostIds: [],
    activeHostId: null,
    personalMembershipHostIds: [],
  }),
);

vi.mock("@/hooks/host/use-addressable-host-id", async () => {
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  return { useAddressableHostId: () => entry.hostId };
});
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => client.current,
}));
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: () => ({ status: "reachable", hostLabel: "Studio Mac" }),
}));
// The host lists the scope reads: one listed, reachable computer.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const { mockLocalHostEntry: entry } =
    await import("@traycer-clients/shared/host-client/mock/mock-host-directory");
  const { remoteEntry } =
    await import("@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures");
  const hostNames: Record<string, string> = {
    [entry.hostId]: "Studio Mac",
    "host-a": "Host A",
  };
  return {
    useHostOptions: () => {
      const hostIds =
        client.hostIds.length === 0 ? [entry.hostId] : client.hostIds;
      return hostOptionsFixture({
        hosts: hostIds.map((hostId) =>
          hostScopeOptionFixture({
            hostId,
            name: hostNames[hostId] ?? "Host X",
            isLocalMachine: hostId === entry.hostId,
            isActive: hostId === (client.activeHostId ?? entry.hostId),
            entry: hostId === entry.hostId ? entry : remoteEntry(hostId, null),
          }),
        ),
        activeHostId: client.activeHostId ?? entry.hostId,
      });
    },
  };
});
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (target: { readonly hostId: string } | null) =>
    target === null ? null : (client.byHostId[target.hostId] ?? null),
}));
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: client.personalMembershipHostIds.map((hostId) => ({
        hostId,
        name: hostId === "host-a" ? "Host A" : "Host X",
      })),
      state: "ready" as const,
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
    }),
    useHostsRunningConfiguration: () => ({
      hosts: client.personalMembershipHostIds.map((hostId) => ({
        hostId,
        name: hostId === "host-a" ? "Host A" : "Host X",
      })),
      state: "ready" as const,
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  () => ({
    useEnvironmentStatusModel: () => ({
      picker: { localRows: [], defaultPick: { kind: "personal" as const } },
      statuses: new Map(),
    }),
  }),
);
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: new Map(),
    ownSettingsHostIds: [],
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
vi.mock("@/components/settings/panels/worktrees-enrichment", () => ({
  useRevalidateStaleWorktreeActivity: () => {},
  useWorktreeActivityEnrichment: () => ({
    enrichedByPath: new Map(),
    erroredPaths: new Set(),
    seededPaths: new Set(),
    reportVisiblePaths: () => {},
    prepareEnrichmentRefresh: () => () => {},
    enriching: false,
  }),
}));
vi.mock("@/lib/host/use-worktree-delete-stream-transport", () => ({
  useWorktreeDeleteStreamTransportFactory: () => () => ({
    wsStreamClient: {},
    close: () => {},
  }),
}));
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ currentUserId: null, tasks: [] }),
}));

import { WorktreesSettingsPanel } from "@/components/settings/panels/worktrees-settings-panel";
import { listingQueryKeyFor } from "@/components/settings/panels/worktrees-listing-query";

const REFUSAL_LINE = "The host refused the read.";
const AWAY_TITLE = "Can't reach Studio Mac from here";

type ReadAnswer = "transport" | "refusal" | "answered";

function transportFailure(): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method: "worktree.listAllForHost",
    fatalDetails: null,
  });
}

function refusal(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: REFUSAL_LINE,
    requestId: "req-refused",
    method: "worktree.listAllForHost",
    fatalDetails: null,
  });
}

interface Page {
  readonly queryClient: QueryClient;
  readonly answer: { current: ReadAnswer };
}

function renderPage(first: ReadAnswer): Page {
  const answer = { current: first };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-worktrees",
    handlers: {
      "worktree.listAllForHost": () => {
        if (answer.current === "transport") {
          return Promise.reject(transportFailure());
        }
        if (answer.current === "refusal") return Promise.reject(refusal());
        return Promise.resolve({ worktrees: [], nextCursor: null });
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  client.current = spine.createRequester(mockLocalHostEntry);
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <TooltipProvider>
          <WorktreesSettingsPanel />
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient, answer };
}

beforeEach(() => {
  window.localStorage.clear();
  client.byHostId = {};
  client.hostIds = [];
  client.activeHostId = null;
  client.personalMembershipHostIds = [];
  // A Local pick lists the one computer as the scope's host without a cloud
  // membership read.
  useSettingsEnvironmentPickStore.setState({
    pick: {
      kind: "local",
      hostId: mockLocalHostEntry.hostId,
      hostName: "Studio Mac",
    },
  });
});

afterEach(() => {
  cleanup();
  client.current = null;
  client.byHostId = {};
  client.hostIds = [];
  client.activeHostId = null;
  client.personalMembershipHostIds = [];
  window.localStorage.clear();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useSettingsHostScopeStore.getState().reset();
});

describe("<WorktreesSettingsPanel /> a failed read of the host's list", () => {
  it("shows the away notice, not the list's own line, when the computer never answered", async () => {
    renderPage("transport");

    const notice = await screen.findByTestId("host-scope-unreachable");
    expect(notice.textContent).toContain(AWAY_TITLE);
    expect(screen.queryByText(REFUSAL_LINE)).toBeNull();
    expect(screen.queryByText("The relay did not answer.")).toBeNull();
  });

  it("keeps the list's own line when the computer answered with a refusal", async () => {
    renderPage("refusal");

    expect(await screen.findByText(REFUSAL_LINE)).toBeTruthy();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });

  it("shows the list and drops the notice once the computer answers again", async () => {
    const page = renderPage("transport");
    await screen.findByTestId("host-scope-unreachable");

    page.answer.current = "answered";
    await act(async () => {
      await page.queryClient.invalidateQueries({
        queryKey: listingQueryKeyFor(mockLocalHostEntry.hostId),
      });
    });

    expect(
      await screen.findByText("No worktrees created on this host."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    });
  });
});

describe("<WorktreesSettingsPanel /> shared scope actions", () => {
  it("sends refresh to X after the shared scope moves from A to X", async () => {
    const listCalls = new Map<string, number>();
    const clientFor = (hostId: string): HostClient<HostRpcRegistry> => {
      const entry = { ...mockLocalHostEntry, hostId };
      const spine = new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        invalidator: createHostQueryInvalidator(queryClient),
        messenger: new MockHostMessenger<HostRpcRegistry>({
          registry: hostRpcRegistry,
          requestId: () => `req-${hostId}`,
          handlers: {
            "worktree.listAllForHost": () => {
              listCalls.set(hostId, (listCalls.get(hostId) ?? 0) + 1);
              return { worktrees: [], nextCursor: null };
            },
          },
        }),
        findHostById: (candidate) => (candidate === hostId ? entry : null),
      });
      spine.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-1",
        }),
      );
      return spine.createRequester(entry);
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const clientA = clientFor("host-a");
    const clientX = clientFor("host-x");
    client.hostIds = ["host-a", "host-x"];
    client.activeHostId = "host-a";
    client.personalMembershipHostIds = ["host-a", "host-x"];
    client.byHostId = { "host-a": clientA, "host-x": clientX };
    client.current = clientA;
    useSettingsEnvironmentPickStore.setState({
      pick: PERSONAL_PICK,
      defaultPick: PERSONAL_PICK,
    });
    useSettingsHostScopeStore.getState().selectHost(PERSONAL_PICK, {
      hostId: "host-a",
      name: "Host A",
    });
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "https://authn.traycer.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <TooltipProvider>
            <WorktreesSettingsPanel />
          </TooltipProvider>
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(listCalls.get("host-a")).toBe(1));

    act(() =>
      useSettingsHostScopeStore.getState().selectHost(PERSONAL_PICK, {
        hostId: "host-x",
        name: "Host X",
      }),
    );
    await waitFor(() => expect(listCalls.get("host-x")).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh worktrees" }));

    await waitFor(() => expect(listCalls.get("host-x")).toBe(2));
    expect(listCalls.get("host-a")).toBe(1);
  });
});
