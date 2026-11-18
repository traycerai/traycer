// The ruling for the Overview's notices-strip drain gate (`HostUpdateDrainGateRow`
// -> `ApplyNowControl`, `host-scope/host-registry-updates.tsx`). During a LOCAL
// foreground run the Apply now trigger is withheld and `hostForegroundUpdateLine`
// shows in `host-apply-now-foreground-<hostId>`; a dialog already open keeps its
// place but is blocked with the same line. A remote host is unaffected.
// Harness mirrors `host-overview-version-rows-foreground.test.tsx`.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
    readonly getLocalEntry: () => null;
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

const { mutateSpy } = vi.hoisted(() => ({ mutateSpy: vi.fn() }));
vi.mock("@/hooks/auth/use-update-host-version-mutation", () => ({
  useUpdateHostVersionPolicy: () => ({ mutate: mutateSpy, isPending: false }),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  HostLifecyclePending,
  HostLifecycleRunAdmission,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  LocalHostCapability,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  HOST_FOREGROUND_UPDATE_READY,
  HOST_FOREGROUND_UPDATE_READY_UNMANAGED,
} from "@/lib/host/host-lifecycle-copy";
import { buildOverviewHostFixture } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

const OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  mutateSpy.mockClear();
});

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
      getLocalEntry: () => null,
    },
  };
}

function pendingRegistryItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: "Studio Mac",
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "pending",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

function lifecycleView(overrides: {
  readonly admittedAs: HostLifecycleRunAdmission | null;
  readonly localHostCapability: LocalHostCapability;
  readonly pending: HostLifecyclePending;
}): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: overrides.localHostCapability,
      supervisor: overrides.admittedAs === null ? "not-running" : "enforcing",
      admittedAs: overrides.admittedAs,
    },
    pending: overrides.pending,
  };
}

function buildLifecycleHost(initial: HostLifecycleView): {
  readonly hostLifecycle: IHostLifecycleHost;
  readonly push: (view: HostLifecycleView) => void;
} {
  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const hostLifecycle: IHostLifecycleHost = {
    get: () => Promise.resolve(initial),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initial,
      } satisfies HostLifecycleSetResult),
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  return {
    hostLifecycle,
    push: (view) => {
      for (const handler of changeHandlers) handler(view);
    },
  };
}

function renderOverview(options: {
  readonly hostId: string;
  readonly isLocalMachine: boolean;
  readonly initialView: HostLifecycleView;
}): { readonly push: (view: HostLifecycleView) => void } {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: options.isLocalMachine,
    hostVersion: "1.5.0",
    busy: true,
    busySessionCount: 2,
  });
  recordNegotiatedHostMethods(options.hostId, OVERVIEW_METHODS);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
      item: pendingRegistryItem(options.hostId),
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);
  const { hostLifecycle, push } = buildLifecycleHost(options.initialView);
  const runnerHost = createFakeRunnerHost({
    hostLifecycle,
    hostManagement: null,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { push };
}

async function findGate(hostId: string): Promise<HTMLElement> {
  // The drain gate now lives in the notices strip between the header and the
  // tab bar, visible on every tab, so no tab selection is needed to reach it.
  return screen.findByTestId(`host-update-drain-gate-${hostId}`);
}

const FOREGROUND_MANAGED = lifecycleView({
  admittedAs: "foreground",
  localHostCapability: "managed",
  pending: "none",
});
const SERVICE_MANAGED = lifecycleView({
  admittedAs: null,
  localHostCapability: "managed",
  pending: "none",
});

describe("host-overview drain gate — Apply now during a local foreground run", () => {
  it("[RED] managed + pending none: gate present, no trigger, the foreground-update line in host-apply-now-foreground", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      initialView: FOREGROUND_MANAGED,
    });
    const gate = await findGate("host-local");
    await waitFor(() => {
      expect(
        screen.queryByTestId("host-apply-now-trigger-host-local"),
      ).toBeNull();
    });
    expect(
      within(gate).getByTestId("host-apply-now-foreground-host-local")
        .textContent,
    ).toBe(HOST_FOREGROUND_UPDATE_READY);
  });

  it("[RED] capability none: the unmanaged line", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      initialView: lifecycleView({
        admittedAs: "foreground",
        localHostCapability: "none",
        pending: "none",
      }),
    });
    const gate = await findGate("host-local");
    await waitFor(() => {
      expect(
        screen.queryByTestId("host-apply-now-trigger-host-local"),
      ).toBeNull();
    });
    expect(
      within(gate).getByTestId("host-apply-now-foreground-host-local")
        .textContent,
    ).toBe(HOST_FOREGROUND_UPDATE_READY_UNMANAGED);
  });

  it("[RED] a dialog opened before the run began: blocked with the foreground-update line, confirm dispatches nothing", async () => {
    const { push } = renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      initialView: SERVICE_MANAGED,
    });
    await findGate("host-local");
    const trigger = await screen.findByTestId(
      "host-apply-now-trigger-host-local",
    );
    await waitFor(() => {
      expect((trigger as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(trigger);
    await screen.findByTestId("confirm-action");

    act(() => {
      push(FOREGROUND_MANAGED);
    });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
        HOST_FOREGROUND_UPDATE_READY,
      );
    });
    const confirm = screen.getByTestId("confirm-action") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(mutateSpy).toHaveBeenCalledTimes(0);
  });

  it("[GREEN] local, not foreground: trigger enabled, confirming mutates once with force", async () => {
    renderOverview({
      hostId: "host-local",
      isLocalMachine: true,
      initialView: SERVICE_MANAGED,
    });
    await findGate("host-local");
    const trigger = (await screen.findByTestId(
      "host-apply-now-trigger-host-local",
    )) as HTMLButtonElement;
    await waitFor(() => {
      expect(trigger.disabled).toBe(false);
    });
    expect(
      screen.queryByTestId("host-apply-now-foreground-host-local"),
    ).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("confirm-action"));
    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(mutateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ force: true }),
    );
  });

  it("[GREEN] remote host while this machine is foreground: trigger enabled, no foreground line", async () => {
    renderOverview({
      hostId: "host-remote",
      isLocalMachine: false,
      initialView: FOREGROUND_MANAGED,
    });
    await findGate("host-remote");
    const trigger = (await screen.findByTestId(
      "host-apply-now-trigger-host-remote",
    )) as HTMLButtonElement;
    await waitFor(() => {
      expect(trigger.disabled).toBe(false);
    });
    expect(
      screen.queryByTestId("host-apply-now-foreground-host-remote"),
    ).toBeNull();
  });
});
