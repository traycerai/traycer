// Boundary mocks mirroring `host-overview-doctor-fixes.test.tsx`: this suite
// is about `HostLifecycleModeLine`'s presence on the Overview card
// (`host-overview-panel.tsx:1909`'s `host.isLocalMachine` guard), not host
// scope resolution or streaming, so those stay stood-in the same way.
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
} from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
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
] as const;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

function lifecycleView(
  overrides: Partial<HostLifecycleView>,
): HostLifecycleView {
  return {
    desired: { mode: "linked", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: "enforcing",
      admittedAs: null,
    },
    pending: "none",
    ...overrides,
  };
}

function buildLifecycleHost(initial: HostLifecycleView): IHostLifecycleHost {
  return {
    get: () => Promise.resolve(initial),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initial,
      } satisfies HostLifecycleSetResult),
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
}

function renderOverview(options: { readonly isLocalMachine: boolean }): {
  readonly queryClient: QueryClient;
} {
  const hostId = options.isLocalMachine ? "host-local" : "host-remote";
  const fixture = buildOverviewHostFixture({
    hostId,
    isLocalMachine: options.isLocalMachine,
  });
  recordNegotiatedHostMethods(hostId, OVERVIEW_METHODS);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: options.isLocalMachine,
      connectable: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = {
    hostClient: fixture.client,
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
      getLocalEntry: () => null,
    },
  };
  // A real `hostLifecycle` on BOTH arms - the mode line's own suite
  // (`host-lifecycle-mode-line.test.tsx`) already pins its render logic
  // against `desired.mode`. What is untested is the OVERVIEW's guard around
  // it, so this fixture always has a lifecycle bridge that WOULD render the
  // line; only `isLocalMachine` differs between the two tests below.
  const runnerHost = createFakeRunnerHost({
    hostLifecycle: buildLifecycleHost(lifecycleView({})),
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
  return { queryClient };
}

describe("Overview — the lifecycle mode line's isLocalMachine guard", () => {
  it("shows the lifecycle mode line for the local host", async () => {
    renderOverview({ isLocalMachine: true });

    await screen.findByTestId("host-identity-name-row");
    expect(
      await screen.findByTestId("host-overview-lifecycle-line"),
    ).toBeTruthy();
  });

  it("does not show the lifecycle mode line for a remote host, even with a lifecycle bridge available", async () => {
    const { queryClient } = renderOverview({ isLocalMachine: false });

    await screen.findByTestId("host-identity-name-row");
    // The lifecycle query itself resolves asynchronously (a promise, then a
    // commit), so a synchronous `queryByTestId` right after mount would pass
    // whether or not the guard exists - it just hasn't had a tick to render
    // yet either way. Wait for every query this render started to settle
    // BEFORE asserting the negative, so the absence is the guard's doing and
    // not a timing accident.
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByTestId("host-overview-lifecycle-line")).toBeNull();
  });
});
