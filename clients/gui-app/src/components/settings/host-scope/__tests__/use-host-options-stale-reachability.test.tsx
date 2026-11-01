import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { HOST_STANDING_BOUND_MS } from "@traycer-clients/shared/host-transport/remote/config";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostHealth } from "@/components/settings/host-scope/host-health";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";

/**
 * A remote host's `connectable` reading EXPIRES, through the real
 * `useHostOptions` and on its own ticking clock.
 *
 * The pure mapping is covered in `panels/__tests__/my-hosts-model.test.ts`;
 * what only this layer can hold is the WIRING. `useHostOptions` reads
 * `useNowMs(60_000)` and hands it to `buildHostScopeOptions`, which is the one
 * path by which a clock reaches the derivation at all - so a bound that is
 * never passed a moving `nowMs` would pass the pure tests and still leave the
 * row frozen on the reading it was first rendered with. That is the shape of
 * the reported defect: a host card that read "Reported reachable · Your
 * account last heard from this host" through a real outage while another host
 * in the same list, whose cloud verdict had already flipped, read "offline".
 */

const REMOTE_HOST_ID = "remote-host";
const NOW_MS = Date.parse("2026-07-03T12:00:00.000Z");

const registry = vi.hoisted<{ hosts: readonly HostListItem[] }>(() => ({
  hosts: [],
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mockLocalHostEntry.hostId,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [mockLocalHostEntry],
    isError: false,
    isLoading: false,
    refetch: () => undefined,
  }),
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: { hosts: registry.hosts },
    isError: false,
    isLoading: false,
    refetch: () => undefined,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: { sandboxes: [] },
    isError: false,
    isLoading: false,
    refetch: () => undefined,
  }),
}));
// No session this client holds, no lease the authority published: the registry
// row is the only evidence there is, which is the window the bound governs.
vi.mock("@/hooks/host/use-remote-sessions-poll-readiness", () => ({
  useRemoteSessionsPollReadiness: () => () => false,
}));
vi.mock("@/hooks/host/use-host-lease", () => ({
  useHostLeases: () => [],
}));
vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => true,
}));
const runnerHost = vi.hoisted<{ current: MockRunnerHost | null }>(() => ({
  current: null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHost.current,
}));

/** A remote row the cloud still calls `connectable`, last seen `ageMs` ago. */
function connectableRow(ageMs: number): HostListItem {
  return {
    hostId: REMOTE_HOST_ID,
    displayName: "build-box",
    platform: "linux-x64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: new Date(NOW_MS - ageMs).toISOString(),
    },
  };
}

function renderOptions() {
  runnerHost.current = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-mock",
      pid: 1,
      systemHostName: "test-mac",
      displayName: "test-mac",
      availability: "available",
    },
    hosts: [mockLocalHostEntry],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: null,
  });
  const queryClient = new QueryClient();
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return renderHook(() => useHostOptions(), { wrapper });
}

function healthOf(hosts: readonly HostScopeOption[]): HostHealth {
  const row = hosts.find((host) => host.hostId === REMOTE_HOST_ID);
  if (row === undefined) throw new Error("the remote row is not listed");
  return row.health;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  runnerHost.current = null;
});

describe("useHostOptions — a connectable reading that has aged out", () => {
  it("reads Reported reachable while the host's check-in is inside the relay's host-leg deadline", () => {
    registry.hosts = [connectableRow(HOST_STANDING_BOUND_MS - 60_000)];
    const { result } = renderOptions();

    const health = healthOf(result.current.hosts);
    expect(health.state).toBe("reported-reachable");
    expect(health.live).toBe(false);
  });

  it("reads Offline once that check-in has aged past the deadline", () => {
    registry.hosts = [connectableRow(HOST_STANDING_BOUND_MS + 60_000)];
    const { result } = renderOptions();

    const health = healthOf(result.current.hosts);
    expect(health.state).toBe("offline");
    expect(health.label).toBe("Offline");
    expect(health.label).not.toBe("Reported reachable");
  });

  it("falls back on its own clock, without the registry answering again", () => {
    // The reading starts fresh and nothing refetches; only time passes. This
    // is the case the pure mapping cannot see: it fails whenever `nowMs` is
    // read once and never again.
    registry.hosts = [connectableRow(HOST_STANDING_BOUND_MS - 60_000)];
    const { result } = renderOptions();
    expect(healthOf(result.current.hosts).state).toBe("reported-reachable");

    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });

    expect(healthOf(result.current.hosts).state).toBe("offline");
  });
});
