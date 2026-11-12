import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { LocalPickerRow } from "@/components/settings/environment/environment-picker-model";
import { queryKeys } from "@/lib/query-keys";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  localRows: [] as LocalPickerRow[],
  answeredStatusHostIds: [] as string[],
  bindingHostId: null as string | null,
  resolvedBindingHostIds: [] as string[],
  listLoading: false,
  listsResolved: true,
  listsFailed: false,
  personalMembershipHostIds: [] as string[],
  teamMembershipHostIds: [] as string[],
  membershipState: "ready" as "ready" | "loading" | "failed",
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    hostManagement: null,
  }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } = await import("../host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: harness.hosts,
        activeHostId: harness.activeHostId,
        isLoading: harness.listLoading,
        listsResolved: harness.listsResolved,
        listsFailed: harness.listsFailed,
      }),
  };
});
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningConfiguration: (
      target:
        | { readonly kind: "personal" }
        | { readonly kind: "team"; readonly environmentId: string },
    ) => ({
      hosts: (target.kind === "team"
        ? harness.teamMembershipHostIds
        : harness.personalMembershipHostIds
      ).map((hostId) => ({ hostId, name: `Name ${hostId}` })),
      state: harness.membershipState,
      collisions: [],
      retry: () => undefined,
      reread: () => undefined,
      thisComputerUnread: false,
    }),
  }),
);
vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  () => ({
    useEnvironmentStatusModel: () => ({
      picker: {
        localRows: harness.localRows,
        defaultPick: { kind: "personal" },
      },
      statuses: new Map(
        harness.hosts.map((host) => [
          host.hostId,
          harness.answeredStatusHostIds.includes(host.hostId) ? {} : null,
        ]),
      ),
    }),
  }),
);
vi.mock("@/hooks/bots/use-host-environment-bindings-query", () => ({
  useHostEnvironmentBindings: () => ({
    byHostId: new Map<string, EnvironmentHostBinding>([
      ...(harness.bindingHostId === null
        ? []
        : [
            [
              harness.bindingHostId,
              {
                hostId: harness.bindingHostId,
                explicit: true,
                environment: {
                  environmentId: "team-sandbox",
                  ownerKind: "organization",
                  ownerId: "fixture-team",
                  roomId: "team-room",
                  label: "Team",
                },
                enrolledByUserId: null,
                canUnbind: false,
              },
            ] as const,
          ]),
      ...harness.resolvedBindingHostIds
        .filter((hostId) => hostId !== harness.bindingHostId)
        .map(
          (hostId) =>
            [
              hostId,
              {
                hostId,
                explicit: false,
                environment: {
                  environmentId: "personal",
                  ownerKind: "user",
                  ownerId: "fixture-owner",
                  roomId: "personal-room",
                  label: "Personal",
                },
                enrolledByUserId: null,
                canUnbind: false,
              },
            ] as const,
        ),
    ]),
    ownSettingsHostIds: [],
    failedHostIds: [],
    retryFailed: () => undefined,
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => entryClient };
});
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => entryClient,
}));
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

let entryClient: HostClient<HostRpcRegistry>;

import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

function makeClient(): HostClient<HostRpcRegistry> {
  const entry: HostDirectoryEntry = {
    hostId: "ambient",
    label: "Ambient",
    kind: "remote",
    websocketUrl: "wss://mock-remote.invalid/rpc",
    version: "1.1.11",
    transportDialability: "dialable",
  };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-settings-entry",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok" }),
  );
  return client.createRequester(entry);
}

function targetOption(
  hostId: string,
  kind: "local" | "sandbox" | "remote",
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: `Option ${hostId}`,
    isLocalMachine: kind === "local",
    registered: kind !== "local",
    sandbox:
      kind === "sandbox"
        ? {
            state: "awake",
            frozen: false,
            summary: null,
            ownerKind: "unknown",
            teamOwned: false,
          }
        : null,
    isActive: hostId === "ambient",
  });
}

function requestEntry(host: HostScopeOption) {
  harness.hosts = [host];
  harness.activeHostId = "ambient";
  useSettingsEnvironmentPickStore.setState({
    pick: PERSONAL_PICK,
    defaultPick: PERSONAL_PICK,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = renderHook(() => useHostScope(), {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  act(() => carryViewedHostIntoSettingsScope(host.hostId));
  rendered.rerender();
  return { rendered, queryClient };
}

afterEach(() => {
  cleanup();
  useSettingsHostScopeStore.getState().reset();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  harness.hosts = [];
  harness.activeHostId = null;
  harness.localRows = [];
  harness.answeredStatusHostIds = [];
  harness.bindingHostId = null;
  harness.resolvedBindingHostIds = [];
  harness.listLoading = false;
  harness.listsResolved = true;
  harness.listsFailed = false;
  harness.personalMembershipHostIds = [];
  harness.teamMembershipHostIds = [];
  harness.membershipState = "ready";
});

describe("Settings entry host resolution", () => {
  it("completes an entry on the target's Local row", async () => {
    entryClient = makeClient();
    const target = targetOption("local-target", "local");
    const { rendered } = requestEntry(target);
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      target.hostId,
    );
    expect(rendered.result.current.isLoading).toBe(true);

    harness.localRows = [
      {
        kind: "local",
        hostId: target.hostId,
        name: "Local target",
        subtitle: "Settings on this computer only",
        verb: null,
        needsUpdate: false,
        defaultsToLocal: false,
      },
    ];
    harness.answeredStatusHostIds = [target.hostId];
    act(() => rendered.rerender());

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "local",
      hostId: "local-target",
      hostName: "Local target",
    });
    expect(useSettingsHostScopeStore.getState().hostByEnvironment).toEqual({
      "local:local-target": { hostId: "local-target", name: "Local target" },
    });
  });

  it("completes a sandbox entry for its explicitly bound team", async () => {
    entryClient = makeClient();
    const target = targetOption("sandbox-target", "sandbox");
    harness.bindingHostId = target.hostId;
    harness.teamMembershipHostIds = [target.hostId];

    requestEntry(target);

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "team-sandbox",
    });
    expect(useSettingsHostScopeStore.getState().hostByEnvironment).toEqual({
      "team:team-sandbox": {
        hostId: "sandbox-target",
        name: "Name sandbox-target",
      },
    });
  });

  it("holds an entry pending while its environment cannot be resolved", async () => {
    entryClient = makeClient();
    const target = targetOption("unresolved-target", "remote");
    harness.membershipState = "loading";

    const { rendered } = requestEntry(target);

    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      "unresolved-target",
    );
    expect(rendered.result.current.hostId).toBeNull();
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      PERSONAL_PICK,
    );
    expect(useSettingsHostScopeStore.getState().hostByEnvironment).toEqual({});

    harness.bindingHostId = target.hostId;
    harness.teamMembershipHostIds = [target.hostId];
    harness.membershipState = "ready";
    harness.answeredStatusHostIds = [target.hostId];
    act(() => rendered.rerender());

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(rendered.result.current.hostId).toBe("unresolved-target");
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "team-sandbox",
    });
    expect(useSettingsHostScopeStore.getState().hostByEnvironment).toEqual({
      "team:team-sandbox": {
        hostId: "unresolved-target",
        name: "Name unresolved-target",
      },
    });
  });

  it("waits for a binding even when membership is ready", () => {
    entryClient = makeClient();
    const target = {
      ...targetOption("binding-in-flight", "remote"),
      isLocalMachine: false,
    };
    harness.answeredStatusHostIds = [target.hostId];
    const { rendered } = requestEntry(target);

    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      target.hostId,
    );
    expect(rendered.result.current.isLoading).toBe(true);
    expect(useSettingsHostScopeStore.getState().hostByEnvironment).toEqual({});
  });

  it("places a not-connectable computer under Personal", async () => {
    entryClient = makeClient();
    const target = targetOption("personal-computer", "remote");
    harness.hosts = [{ ...target, isLocalMachine: false, connectable: false }];
    harness.resolvedBindingHostIds = [target.hostId];
    harness.personalMembershipHostIds = [target.hostId];

    const { rendered } = requestEntry(harness.hosts[0]);

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(rendered.result.current.hostId).toBe(target.hostId);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      PERSONAL_PICK,
    );
    expect(
      useSettingsHostScopeStore.getState().hostByEnvironment.personal,
    ).toEqual({
      hostId: target.hostId,
      name: `Name ${target.hostId}`,
    });
  });

  it("places a computer under Personal when its status query errors after mount", async () => {
    entryClient = makeClient();
    const target = {
      ...targetOption("status-error-computer", "remote"),
      isLocalMachine: false,
    };
    harness.resolvedBindingHostIds = [target.hostId];
    harness.personalMembershipHostIds = [target.hostId];
    const { rendered, queryClient } = requestEntry(target);

    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      target.hostId,
    );
    await act(async () => {
      await queryClient
        .fetchQuery({
          queryKey: queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
            target.hostId,
            "environment.status",
            {},
          ),
          queryFn: () => Promise.reject(new Error("status unavailable")),
        })
        .catch(() => undefined);
    });

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(rendered.result.current.hostId).toBe(target.hostId);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      PERSONAL_PICK,
    );
  });

  it("abandons a resolved entry with no target in the ready host lists", async () => {
    entryClient = makeClient();
    const target = targetOption("missing-target", "remote");
    const { rendered } = requestEntry(target);
    harness.hosts = [];
    act(() => rendered.rerender());

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(rendered.result.current.hostId).toBeNull();
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      PERSONAL_PICK,
    );
  });

  it("abandons when a resolved binding has no membership row and stops loading", async () => {
    entryClient = makeClient();
    const target = {
      ...targetOption("not-a-member", "remote"),
      isLocalMachine: false,
    };
    harness.answeredStatusHostIds = [target.hostId];
    harness.resolvedBindingHostIds = [target.hostId];
    const { rendered } = requestEntry(target);

    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(rendered.result.current.isLoading).toBe(false);
    expect(useSettingsHostScopeStore.getState().hostByEnvironment).toEqual({});
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      PERSONAL_PICK,
    );
  });

  it.each([
    ["loading", true, false, false],
    ["failed", false, true, true],
    ["not started", false, false, false],
  ])(
    "keeps the entry pending while host lists are %s",
    (_label, loading, resolved, failed) => {
      entryClient = makeClient();
      const target = targetOption("uncertain-host-lists", "remote");
      const { rendered } = requestEntry(target);
      harness.hosts = [];
      harness.listLoading = loading;
      harness.listsResolved = resolved;
      harness.listsFailed = failed;
      act(() => rendered.rerender());

      expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
        target.hostId,
      );
      expect(rendered.result.current.hostId).toBeNull();
    },
  );
});
