import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import {
  POOL_HOST_ID,
  poolHostDirectoryEntry,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostRead } from "@/hooks/bots/use-environment-host-read-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useTeamComputerClaim } from "@/hooks/auth/use-team-computers";
import {
  hostEnvironmentBindingQueryKey,
  useHostEnvironmentBindings,
} from "@/hooks/bots/use-host-environment-bindings-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";

const VIEWER = "user-1";
const TARGET_HOST = "host-9";
const OTHER_HOST = "host-10";
const POOL_ENTRY = poolHostDirectoryEntry("wss://pool.test/rpc");
interface DeferredStatusAnswer {
  readonly kind: "deferred_status";
  readonly promise: Promise<EnvironmentStatusResponseV12>;
  readonly resolve: (answer: EnvironmentStatusResponseV12) => void;
}
type StatusAnswer = EnvironmentStatusResponseV12 | Error | DeferredStatusAnswer;
let statusAnswer: EnvironmentStatusResponseV12 | Error =
  environmentStatusFixture({});
let statusAnswers: ReadonlyArray<StatusAnswer> = [];
let bindingAnswers: ReadonlyArray<EnvironmentHostBinding | Error> = [];
/** What OTHER_HOST's completed handshake says, or that none has completed. */
let otherManifest: "advertises_status" | "lacks_status" | "no_handshake" =
  "advertises_status";
const connectable = vi.hoisted(() => ({
  hostIds: [] as string[],
  resolved: true,
}));

vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => connectable,
}));

const bindingRef = vi.hoisted(() => ({
  current: null as {
    hostClient: HostClient<HostRpcRegistry>;
    hostId: undefined;
    auth: {
      releaseTeamComputer: (
        hostId: string,
        environmentId: string,
      ) => Promise<{ readonly kind: "ok" }>;
    };
    directory: {
      refresh: () => Promise<void>;
      list: () => Promise<ReadonlyArray<HostDirectoryEntry>>;
      onChange: () => { dispose: () => void };
    };
  } | null,
}));
const noteHostMembershipChanged = vi.hoisted(() =>
  vi.fn<(hostId: string) => void>(),
);

vi.mock("@/lib/host/local-admission-invalidation", () => ({
  noteHostMembershipChanged,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => bindingRef.current,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: VIEWER,
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

const BINDING: EnvironmentHostBinding = {
  hostId: TARGET_HOST,
  environment: {
    environmentId: "env-personal",
    ownerKind: "user",
    ownerId: VIEWER,
    roomId: "room",
    label: "Personal",
  },
  explicit: false,
  enrolledByUserId: null,
  canUnbind: false,
};
const TEAM_BINDING: EnvironmentHostBinding = {
  ...BINDING,
  environment: {
    environmentId: "env-team",
    ownerKind: "organization",
    ownerId: "team-1",
    roomId: "team-room",
    label: "Acme",
  },
  explicit: true,
  enrolledByUserId: VIEWER,
  canUnbind: true,
};
const OTHER_BINDING: EnvironmentHostBinding = {
  ...BINDING,
  hostId: OTHER_HOST,
};

function deferredStatusAnswer(): DeferredStatusAnswer {
  let resolveAnswer: (answer: EnvironmentStatusResponseV12) => void = () =>
    undefined;
  const promise = new Promise<EnvironmentStatusResponseV12>((resolve) => {
    resolveAnswer = resolve;
  });
  return {
    kind: "deferred_status",
    promise,
    resolve: resolveAnswer,
  };
}

function isDeferredStatusAnswer(
  answer: StatusAnswer,
): answer is DeferredStatusAnswer {
  return "kind" in answer;
}

function signInAs(status: "signed-in" | "unverified"): void {
  useAuthStore.setState({
    status,
    contextMetadata: { userId: VIEWER, username: VIEWER },
  });
}

function bindingRead(read: EnvironmentHostRead) {
  if (read.kind !== "binding") throw new Error("Expected a binding read");
  return read.query;
}

function mount(initialBinding: EnvironmentHostBinding) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const reads: string[] = [];
  const hostReads: string[] = [];
  const statusReads: StatusAnswer[] = [];
  let poolBinding = initialBinding;
  const targetEntry = { ...mockLocalHostEntry, hostId: TARGET_HOST };
  const otherEntry = { ...mockLocalHostEntry, hostId: OTHER_HOST };
  const releaseTeamComputer = vi.fn(() => {
    poolBinding = BINDING;
    return Promise.resolve({ kind: "ok" as const });
  });
  const directory = {
    refresh: vi.fn(() => Promise.resolve()),
    list: () => Promise.resolve([targetEntry, otherEntry]),
    onChange: () => ({ dispose: () => undefined }),
  };
  const runnerHost = dashboardRunnerHost();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === TARGET_HOST) return targetEntry;
      if (hostId === OTHER_HOST) return otherEntry;
      return hostId === POOL_HOST_ID ? POOL_ENTRY : null;
    },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req",
      handlers: {
        "environment.binding.read": (params) => {
          const answer =
            bindingAnswers[reads.length] ??
            (params.hostId === OTHER_HOST ? OTHER_BINDING : poolBinding);
          reads.push(params.hostId);
          return answer instanceof Error ? Promise.reject(answer) : answer;
        },
        "environment.status": () => {
          const answer = statusAnswers[statusReads.length] ?? statusAnswer;
          statusReads.push(answer);
          if (answer instanceof Error) return Promise.reject(answer);
          return isDeferredStatusAnswer(answer) ? answer.promise : answer;
        },
        "environment.host.read": () => {
          hostReads.push(TARGET_HOST);
          return { ...BINDING, sharingGeneration: null };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      identity: { userId: VIEWER, username: VIEWER, providerHandle: null },
      origin: "renderer",
    }),
  );
  recordNegotiatedHostManifest(TARGET_HOST, {
    "environment.status": { major: 1, minor: 1 },
  });
  if (otherManifest === "advertises_status") {
    recordNegotiatedHostManifest(OTHER_HOST, {
      "environment.status": { major: 1, minor: 1 },
    });
  }
  if (otherManifest === "lacks_status") {
    recordNegotiatedHostManifest(OTHER_HOST, {
      "environment.binding.read": { major: 1, minor: 0 },
    });
  }
  bindingRef.current = {
    hostClient: spine,
    hostId: undefined,
    auth: { releaseTeamComputer },
    directory,
  };
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider value={runnerHost}>
        {props.children}
      </RunnerHostContext.Provider>
    </QueryClientProvider>
  );
  return {
    queryClient,
    reads,
    hostReads,
    statusReads,
    releaseTeamComputer,
    runnerHost,
    wrapper,
    client: spine.createRequester(mockLocalHostEntry),
  };
}

describe("environment.binding.read in a pool build", () => {
  beforeEach(() => {
    settleProcessHostRpcTierPlan(POOL_ENTRY);
    statusAnswer = environmentStatusFixture({});
    statusAnswers = [];
    bindingAnswers = [];
    otherManifest = "advertises_status";
    connectable.hostIds = [];
    noteHostMembershipChanged.mockReset();
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    bindingRef.current = null;
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("is never dispatched by useHostEnvironmentBindings while the session lacks a verdict, and is once authorized", async () => {
    signInAs("unverified");
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useHostEnvironmentBindings([TARGET_HOST], true),
      { wrapper: fixture.wrapper },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.reads).toEqual([]);

    act(() => {
      signInAs("signed-in");
    });
    await waitFor(() => {
      expect(rendered.result.current.byHostId.get(TARGET_HOST)).toEqual(
        BINDING,
      );
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("refuses a refetch of that read once the verdict is gone, without dispatching", async () => {
    signInAs("signed-in");
    const fixture = mount(BINDING);
    renderHook(() => useHostEnvironmentBindings([TARGET_HOST], true), {
      wrapper: fixture.wrapper,
    });
    await waitFor(() => {
      expect(fixture.reads).toEqual([TARGET_HOST]);
    });

    act(() => {
      signInAs("unverified");
    });
    const query = fixture.queryClient.getQueryCache().find({
      queryKey: hostEnvironmentBindingQueryKey(TARGET_HOST, VIEWER),
    });
    const refused: unknown = await query?.fetch().then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : "").toContain(
      "no longer holds a cloud verdict",
    );
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("is never dispatched by useEnvironmentHostReadQuery while the session lacks a verdict, and is once authorized", async () => {
    signInAs("unverified");
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useEnvironmentHostReadQuery(fixture.client, TARGET_HOST, true),
      { wrapper: fixture.wrapper },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.reads).toEqual([]);

    act(() => {
      signInAs("signed-in");
    });
    await waitFor(() => {
      expect(bindingRead(rendered.result.current).data).toEqual(BINDING);
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("returns own_settings for a pooled Local host instead of the pool's Personal binding", async () => {
    signInAs("signed-in");
    statusAnswer = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useEnvironmentHostReadQuery(fixture.client, TARGET_HOST, true),
      { wrapper: fixture.wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.kind).toBe("own_settings");
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);
    expect(fixture.hostReads).toEqual([]);
  });

  it("separates Local and environment-bound hosts in the pooled fleet", async () => {
    signInAs("signed-in");
    connectable.hostIds = [TARGET_HOST, OTHER_HOST];
    statusAnswers = [
      environmentStatusFixture({
        principal: null,
        planes: { records: "local", broker: "local", room: "local" },
      }),
      environmentStatusFixture({ principal: { kind: "personal" } }),
    ];
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useHostEnvironmentBindings([TARGET_HOST, OTHER_HOST], true),
      { wrapper: fixture.wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.ownSettingsHostIds).toEqual([TARGET_HOST]);
      expect(rendered.result.current.byHostId.get(OTHER_HOST)).toEqual(
        OTHER_BINDING,
      );
    });
    expect(rendered.result.current.byHostId.has(TARGET_HOST)).toBe(false);
    expect(rendered.result.current.failedHostIds).toEqual([]);
  });

  it("fails an advertised host whose status read errors instead of using Personal", async () => {
    signInAs("signed-in");
    connectable.hostIds = [TARGET_HOST];
    statusAnswers = [new Error("status unavailable")];
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useHostEnvironmentBindings([TARGET_HOST], true),
      { wrapper: fixture.wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.failedHostIds).toEqual([TARGET_HOST]);
    });
    expect(rendered.result.current.byHostId.has(TARGET_HOST)).toBe(false);
    expect(fixture.reads).toEqual([TARGET_HOST]);
    expect(fixture.statusReads).toHaveLength(1);
  });

  it("asks a failed binding again only after the re-read status answers", async () => {
    signInAs("signed-in");
    connectable.hostIds = [TARGET_HOST];
    const localStatus = environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
    });
    const deferredStatus = deferredStatusAnswer();
    statusAnswers = [
      environmentStatusFixture({ principal: { kind: "personal" } }),
      deferredStatus,
    ];
    bindingAnswers = [new Error("binding unavailable"), BINDING];
    const fixture = mount(BINDING);
    const byHostIdHistory: boolean[] = [];
    const rendered = renderHook(
      () => {
        const bindings = useHostEnvironmentBindings([TARGET_HOST], true);
        useEffect(() => {
          byHostIdHistory.push(bindings.byHostId.has(TARGET_HOST));
        }, [bindings]);
        return bindings;
      },
      { wrapper: fixture.wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.failedHostIds).toEqual([TARGET_HOST]);
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);

    act(() => rendered.result.current.retryFailed());
    await waitFor(() => expect(fixture.statusReads).toHaveLength(2));

    expect(fixture.reads).toEqual([TARGET_HOST]);
    expect(rendered.result.current.byHostId.has(TARGET_HOST)).toBe(false);
    expect(byHostIdHistory).not.toContain(true);

    act(() => {
      deferredStatus.resolve(localStatus);
    });

    await waitFor(() => {
      expect(rendered.result.current.ownSettingsHostIds).toEqual([TARGET_HOST]);
    });
    expect(rendered.result.current.byHostId.has(TARGET_HOST)).toBe(false);
    expect(rendered.result.current.failedHostIds).toEqual([]);
    expect(fixture.reads).toEqual([TARGET_HOST, TARGET_HOST]);
    expect(byHostIdHistory).not.toContain(true);
  });

  it("uses the pool answer when a host's handshake lacks environment.status", async () => {
    signInAs("signed-in");
    connectable.hostIds = [OTHER_HOST];
    statusAnswers = [new Error("status unavailable")];
    otherManifest = "lacks_status";
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useHostEnvironmentBindings([OTHER_HOST], true),
      { wrapper: fixture.wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.byHostId.get(OTHER_HOST)).toEqual(
        OTHER_BINDING,
      );
    });
    expect(rendered.result.current.failedHostIds).toEqual([]);
    expect(fixture.reads).toEqual([OTHER_HOST]);
    expect(fixture.statusReads).toHaveLength(1);
  });

  it("fails a host with no completed handshake whose status read errors", async () => {
    signInAs("signed-in");
    connectable.hostIds = [OTHER_HOST];
    statusAnswers = [new Error("status unavailable")];
    otherManifest = "no_handshake";
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useHostEnvironmentBindings([OTHER_HOST], true),
      { wrapper: fixture.wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.failedHostIds).toEqual([OTHER_HOST]);
    });
    expect(rendered.result.current.byHostId.has(OTHER_HOST)).toBe(false);
    expect(fixture.statusReads).toHaveLength(1);
  });

  it("returns failed and retries status when the single host status read errors", async () => {
    signInAs("signed-in");
    statusAnswer = new Error("status unavailable");
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useEnvironmentHostReadQuery(fixture.client, TARGET_HOST, true),
      { wrapper: fixture.wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.kind).toBe("failed");
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);
    expect(fixture.statusReads).toHaveLength(1);

    const failed = rendered.result.current;
    if (failed.kind !== "failed") throw new Error("Expected failed status");
    act(() => failed.retry());

    await waitFor(() => {
      expect(fixture.statusReads).toHaveLength(2);
      expect(rendered.result.current.kind).toBe("failed");
    });
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("refuses a refetch of useEnvironmentHostReadQuery once the verdict is gone, without dispatching", async () => {
    signInAs("signed-in");
    const fixture = mount(BINDING);
    const rendered = renderHook(
      () => useEnvironmentHostReadQuery(fixture.client, TARGET_HOST, true),
      { wrapper: fixture.wrapper },
    );
    await waitFor(() => {
      expect(bindingRead(rendered.result.current).data).toEqual(BINDING);
    });

    act(() => {
      signInAs("unverified");
    });
    const refetched = await act(() =>
      bindingRead(rendered.result.current).refetch(),
    );

    expect(refetched.error?.message).toContain(
      "no longer holds a cloud verdict",
    );
    expect(fixture.reads).toEqual([TARGET_HOST]);
  });

  it("updates the Overview binding after a team computer is claimed", async () => {
    signInAs("signed-in");
    const fixture = mount(TEAM_BINDING);
    const binding = renderHook(
      () => useEnvironmentHostReadQuery(fixture.client, TARGET_HOST, true),
      { wrapper: fixture.wrapper },
    );
    const claim = renderHook(
      () => useTeamComputerClaim("env-team", undefined),
      {
        wrapper: fixture.wrapper,
      },
    );

    await waitFor(() => {
      expect(bindingRead(binding.result.current).data).toEqual(TEAM_BINDING);
    });

    await act(async () => {
      await claim.result.current.mutateAsync(TARGET_HOST);
    });

    await waitFor(() => {
      expect(bindingRead(binding.result.current).data).toEqual(BINDING);
    });
    expect(fixture.releaseTeamComputer).toHaveBeenCalledWith(
      TARGET_HOST,
      "env-team",
    );
    expect(noteHostMembershipChanged).toHaveBeenCalledWith(TARGET_HOST);
    expect(fixture.reads).toEqual([TARGET_HOST, TARGET_HOST]);
  });
});
