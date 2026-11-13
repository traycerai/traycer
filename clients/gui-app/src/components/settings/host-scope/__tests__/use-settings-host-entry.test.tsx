import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  renderHook,
  waitFor,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import {
  queryOptions,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { localPickerRow } from "@/components/settings/environment/environment-picker-model";
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
  bindingRequests: [] as string[],
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
  useHostEnvironmentBindings: (hostIds: readonly string[]) => {
    harness.bindingRequests.push(...hostIds);
    return {
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
    };
  },
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
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { HostScopeGate } from "@/components/settings/host-scope/host-scope-gate";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
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

interface EntryOutcome {
  readonly hostId: string | null;
  readonly pendingHostId: string | null;
  readonly pick: EnvironmentPick | null;
  readonly hostSelection:
    | { readonly hostId: string; readonly name: string }
    | undefined;
  readonly bindingHostIds: readonly string[];
  readonly retryAvailable: boolean;
}

function entryOutcome(scope: HostScope): EntryOutcome {
  const store = useSettingsHostScopeStore.getState();
  return {
    hostId: scope.hostId,
    pendingHostId: store.pendingHostId,
    pick: useSettingsEnvironmentPickStore.getState().pick,
    hostSelection: store.hostByEnvironment.personal,
    bindingHostIds: [...new Set(harness.bindingRequests)],
    retryAvailable: scope.retryEntryStatus !== null,
  };
}

async function neverReadOfflineOutcome(
  target: HostScopeOption,
): Promise<EntryOutcome> {
  harness.resolvedBindingHostIds = [target.hostId];
  harness.personalMembershipHostIds = [target.hostId];
  const { rendered } = requestEntry({ ...target, connectable: false });
  await waitFor(() =>
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull(),
  );
  const outcome = entryOutcome(rendered.result.current);
  rendered.unmount();
  useSettingsHostScopeStore.getState().reset();
  harness.bindingRequests = [];
  return outcome;
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
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
  harness.bindingRequests = [];
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
    expect(await neverReadOfflineOutcome(target)).toEqual({
      hostId: target.hostId,
      pendingHostId: null,
      pick: PERSONAL_PICK,
      hostSelection: { hostId: target.hostId, name: `Name ${target.hostId}` },
      bindingHostIds: [target.hostId],
      retryAvailable: false,
    });
  });

  it.each([false, true])(
    "resolves a known-absent status method through the legacy entry path (read errored: %s)",
    async (errored) => {
      entryClient = makeClient();
      const target = targetOption("legacy-computer", "remote");
      const expected = await neverReadOfflineOutcome(target);
      harness.resolvedBindingHostIds = [];
      recordNegotiatedHostManifest(target.hostId, {
        "host.status": { major: 1, minor: 0 },
      });
      const { rendered, queryClient } = requestEntry(target);
      if (errored)
        await act(async () => {
          await queryClient
            .fetchQuery(
              queryOptions({
                queryKey: queryKeys.hostMethod<
                  HostRpcRegistry,
                  "environment.status"
                >(target.hostId, "environment.status", {}),
                queryFn: () => Promise.reject(new Error("method unavailable")),
              }),
            )
            .catch(() => undefined);
        });
      expect(rendered.result.current.retryEntryStatus).toBeNull();
      harness.resolvedBindingHostIds = [target.hostId];
      act(() => rendered.rerender());
      await waitFor(() =>
        expect(entryOutcome(rendered.result.current)).toEqual(expected),
      );
      render(
        <HostScopeGate scope={rendered.result.current} skeleton={null}>
          {null}
        </HostScopeGate>,
      );
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.queryByText("Finding your hosts…")).toBeNull();
    },
  );

  it("releases an older computer to its needs-update row when its manifest answers", async () => {
    entryClient = makeClient();
    const target = targetOption("old-computer", "remote");
    const row = localPickerRow(target, null, false);
    if (row === null) throw new Error("missing legacy row");
    harness.localRows = [row];
    const expected = await neverReadOfflineOutcome(target);
    harness.localRows = [];
    const { rendered, queryClient } = requestEntry(target);
    await act(async () => {
      await queryClient
        .fetchQuery(
          queryOptions({
            queryKey: queryKeys.hostMethod<
              HostRpcRegistry,
              "environment.status"
            >(target.hostId, "environment.status", {}),
            queryFn: () => Promise.reject(new Error("method unavailable")),
          }),
        )
        .catch(() => undefined);
    });
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      target.hostId,
    );
    act(() => {
      harness.localRows = [row];
      recordNegotiatedHostManifest(target.hostId, {
        "host.status": { major: 1, minor: 0 },
      });
    });
    await waitFor(() =>
      expect(entryOutcome(rendered.result.current)).toEqual(expected),
    );
  });

  it("keeps an advertised status method pending after a failed read", async () => {
    entryClient = makeClient();
    const target = targetOption("advertised-status", "remote");
    recordNegotiatedHostManifest(target.hostId, {
      "environment.status": { major: 1, minor: 2 },
    });
    const { rendered, queryClient } = requestEntry(target);
    await act(async () => {
      await queryClient
        .fetchQuery(
          queryOptions({
            queryKey: queryKeys.hostMethod<
              HostRpcRegistry,
              "environment.status"
            >(target.hostId, "environment.status", {}),
            queryFn: () => Promise.reject(new Error("status unavailable")),
          }),
        )
        .catch(() => undefined);
    });
    expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
      target.hostId,
    );
    expect(harness.bindingRequests).toEqual([]);
    expect(rendered.result.current.retryEntryStatus).not.toBeNull();
  });

  it("holds a failed status entry in loading, retries its status, then completes Local", async () => {
    entryClient = makeClient();
    const target = targetOption("status-error-computer", "local");
    const { rendered, queryClient } = requestEntry(target);
    let statusReads = 0;
    const options = queryOptions({
      queryKey: queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        target.hostId,
        "environment.status",
        {},
      ),
      queryFn: () => {
        statusReads += 1;
        if (statusReads === 1)
          return Promise.reject(new Error("status unavailable"));
        harness.answeredStatusHostIds = [target.hostId];
        harness.localRows = [
          {
            kind: "local",
            hostId: target.hostId,
            name: target.name,
            subtitle: "",
            verb: null,
            needsUpdate: false,
            defaultsToLocal: true,
          },
        ];
        return Promise.resolve(
          environmentStatusFixture({
            principal: null,
            planes: { records: "local", broker: "local", room: "local" },
          }),
        );
      },
    });
    const view = render(
      <HostScopeGate scope={rendered.result.current} skeleton={null}>
        {null}
      </HostScopeGate>,
    );
    expect(screen.getByText("Finding your hosts…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => {
      await queryClient.fetchQuery(options).catch(() => undefined);
    });
    view.rerender(
      <HostScopeGate scope={rendered.result.current} skeleton={null}>
        {null}
      </HostScopeGate>,
    );
    expect(screen.getByText("Finding your hosts…")).toBeTruthy();
    expect(screen.queryByText("Couldn't load your hosts")).toBeNull();
    expect(harness.bindingRequests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
    });
    expect(statusReads).toBe(2);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "local",
      hostId: target.hostId,
      hostName: target.name,
    });
  });

  it.each(["local", "personal"])(
    "holds retained %s data throughout a deferred failed-status retry",
    async (kind) => {
      entryClient = makeClient();
      const target = targetOption("retained-status", "local");
      const { rendered, queryClient } = requestEntry(target);
      const retry = Promise.withResolvers<EnvironmentStatusResponseV12>();
      const oldStatus = environmentStatusFixture({});
      const queryKey = queryKeys.hostMethod<
        HostRpcRegistry,
        "environment.status"
      >(target.hostId, "environment.status", {});
      let reads = 0;
      await act(async () => {
        queryClient.setQueryData(queryKey, oldStatus);
        await queryClient
          .fetchQuery(
            queryOptions({
              queryKey,
              staleTime: 0,
              queryFn: () => {
                reads += 1;
                return reads === 1
                  ? Promise.reject(new Error("status unavailable"))
                  : retry.promise;
              },
            }),
          )
          .catch(() => undefined);
        harness.answeredStatusHostIds = [target.hostId];
        harness.localRows =
          kind === "local"
            ? [
                {
                  kind: "local",
                  hostId: target.hostId,
                  name: target.name,
                  subtitle: "",
                  verb: null,
                  needsUpdate: false,
                  defaultsToLocal: true,
                },
              ]
            : [];
      });
      expect(rendered.result.current.retryEntryStatus).not.toBeNull();
      act(() => rendered.result.current.retryEntryStatus?.());
      expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe("fetching");
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBe(
        target.hostId,
      );
      expect(harness.bindingRequests).toEqual([]);
      expect(rendered.result.current.retryEntryStatus).toBeNull();
      await act(async () => {
        retry.resolve(oldStatus);
        await retry.promise;
      });
      await waitFor(() => {
        if (kind === "local")
          expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull();
        else expect(harness.bindingRequests).toContain(target.hostId);
      });
      expect(reads).toBe(2);
    },
  );

  it.each([false, true])(
    "matches the never-read offline entry after route loss (retry active: %s)",
    async (retryActive) => {
      entryClient = makeClient();
      const target = targetOption("offline-computer", "remote");
      const expected = await neverReadOfflineOutcome(target);
      const { rendered, queryClient } = requestEntry(target);
      const retry = Promise.withResolvers<EnvironmentStatusResponseV12>();
      const queryKey = queryKeys.hostMethod<
        HostRpcRegistry,
        "environment.status"
      >(target.hostId, "environment.status", {});
      let reads = 0;
      await act(async () => {
        await queryClient
          .fetchQuery(
            queryOptions({
              queryKey,
              queryFn: () => {
                reads += 1;
                return reads === 1
                  ? Promise.reject(new Error("status unavailable"))
                  : retry.promise;
              },
            }),
          )
          .catch(() => undefined);
      });
      if (retryActive) {
        act(() => rendered.result.current.retryEntryStatus?.());
        expect(queryClient.getQueryState(queryKey)?.status).toBe("pending");
        expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe(
          "fetching",
        );
      }
      harness.hosts = [{ ...target, connectable: false }];
      act(() => rendered.rerender());
      await waitFor(() =>
        expect(entryOutcome(rendered.result.current)).toEqual(expected),
      );
      render(
        <HostScopeGate scope={rendered.result.current} skeleton={null}>
          {null}
        </HostScopeGate>,
      );
      expect(screen.queryByText("Finding your hosts…")).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      if (retryActive)
        await act(async () => {
          retry.resolve(environmentStatusFixture({}));
          await retry.promise;
        });
    },
  );

  it("drops the dead status retry while an offline entry resolves its binding", async () => {
    entryClient = makeClient();
    const target = targetOption("offline-binding", "remote");
    const expected = await neverReadOfflineOutcome(target);
    harness.resolvedBindingHostIds = [];
    const { rendered, queryClient } = requestEntry(target);
    await act(async () => {
      await queryClient
        .fetchQuery(
          queryOptions({
            queryKey: queryKeys.hostMethod<
              HostRpcRegistry,
              "environment.status"
            >(target.hostId, "environment.status", {}),
            queryFn: () => Promise.reject(new Error("status unavailable")),
          }),
        )
        .catch(() => undefined);
    });
    harness.hosts = [{ ...target, connectable: false }];
    act(() => rendered.rerender());
    const view = render(
      <HostScopeGate scope={rendered.result.current} skeleton={null}>
        {null}
      </HostScopeGate>,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(harness.bindingRequests).toContain(target.hostId);
    harness.resolvedBindingHostIds = [target.hostId];
    act(() => rendered.rerender());
    await waitFor(() =>
      expect(entryOutcome(rendered.result.current)).toEqual(expected),
    );
    view.rerender(
      <HostScopeGate scope={rendered.result.current} skeleton={null}>
        {null}
      </HostScopeGate>,
    );
    expect(screen.queryByText("Finding your hosts…")).toBeNull();
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
