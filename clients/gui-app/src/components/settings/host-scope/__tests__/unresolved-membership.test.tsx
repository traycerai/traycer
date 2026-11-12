import {
  queryOptions,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { queryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { HostScopeGate } from "@/components/settings/host-scope/host-scope-gate";
import { useHostsRunningConfiguration } from "@/components/settings/environment/use-hosts-running-configuration";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

const facts = vi.hoisted(() => ({
  cachedReady: false,
  failedList: false,
  failedEnvironment: false,
  retryStatus: vi.fn(),
  retryLists: vi.fn(),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: { activate: () => Promise.resolve({ ok: true }) },
    hostManagement: null,
  }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("../host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: facts.cachedReady
          ? [
              hostScopeOptionFixture({
                hostId: "member",
                isLocalMachine: false,
              }),
            ]
          : [],
        activeHostId: null,
        listsFailed: facts.failedList,
        retryLists: facts.retryLists,
      }),
  };
});
vi.mock("@/components/settings/host-scope/use-settings-host-entry", () => ({
  useSettingsHostEntry: () => ({
    failed: false,
    retryStatus: facts.retryStatus,
    retry: () => undefined,
  }),
}));
vi.mock("@/lib/host", async (original) => ({
  ...(await original<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "",
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: facts.failedEnvironment
      ? undefined
      : {
          environments: facts.cachedReady
            ? [{ ownerKind: "user", environmentId: "personal-env" }]
            : [],
        },
    isError: facts.failedEnvironment,
    refetch: () => Promise.resolve(),
  }),
}));
vi.mock("@/components/settings/personal/use-personal-computers", () => ({
  usePersonalComputers: () => ({
    computers: [],
    participants: [],
    statuses: new Map(),
    versions: new Map(),
  }),
}));

afterEach(() => {
  cleanup();
  facts.cachedReady = false;
  facts.failedList = false;
  facts.failedEnvironment = false;
  facts.retryStatus.mockClear();
  facts.retryLists.mockClear();
  useSettingsHostScopeStore.getState().reset();
});

it.each([false, true])(
  "ignores unused Personal membership failure while unresolved (environment read error: %s)",
  (failedEnvironment) => {
    facts.failedEnvironment = failedEnvironment;
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: { kind: "unresolved" },
      defaultHostId: null,
    });
    useSettingsHostScopeStore.setState({ pendingHostId: "target" });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => ({
        scope: useHostScope(),
        membership: useHostsRunningConfiguration({ kind: "personal" }, false),
      }),
      { wrapper },
    );
    expect(hook.result.current.membership.state).toBe("failed");
    expect(hook.result.current.scope.listsFailed).toBe(false);
    const view = render(
      <HostScopeGate scope={hook.result.current.scope} skeleton={null}>
        {null}
      </HostScopeGate>,
    );
    expect(screen.getByText("Finding your hosts…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(facts.retryStatus).toHaveBeenCalledOnce();
    expect(facts.retryLists).not.toHaveBeenCalled();
    facts.failedList = true;
    act(() => hook.rerender());
    view.rerender(
      <HostScopeGate scope={hook.result.current.scope} skeleton={null}>
        {null}
      </HostScopeGate>,
    );
    expect(screen.getByText("Couldn't load your hosts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(facts.retryLists).toHaveBeenCalledOnce();
  },
);

it("holds cached ready Personal membership until the unresolved pick resolves", () => {
  facts.cachedReady = true;
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: { kind: "unresolved" },
    defaultHostId: null,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const membershipQuery = queryOptions({
    queryKey: [
      ...queryKeys.hostMethod<HostRpcRegistry, "environment.host.list">(
        null,
        "environment.host.list",
        { environmentId: "personal-env" },
      ),
      "",
    ],
  });
  queryClient.setQueryData(membershipQuery.queryKey, {
    hosts: [
      {
        hostId: "member",
        hostLabel: "Member",
        hostPlatform: null,
        enrolledByUserId: null,
        boundAt: 1,
        kind: "personal",
        reachable: true,
        lastReportedAt: 1,
        applied: [],
        hasLocalRow: false,
      },
    ],
  });
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => ({
      scope: useHostScope(),
      membership: useHostsRunningConfiguration({ kind: "personal" }, false),
    }),
    { wrapper },
  );
  expect(hook.result.current.membership.state).toBe("ready");
  expect(
    hook.result.current.membership.hosts.map((host) => host.hostId),
  ).toEqual(["member"]);
  expect(hook.result.current.scope.hosts).toEqual([]);
  expect(hook.result.current.scope.hostId).toBeNull();
  act(() =>
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } }),
  );
  expect(hook.result.current.scope.hosts.map((host) => host.hostId)).toEqual([
    "member",
  ]);
  expect(hook.result.current.scope.hostId).toBe("member");
});
