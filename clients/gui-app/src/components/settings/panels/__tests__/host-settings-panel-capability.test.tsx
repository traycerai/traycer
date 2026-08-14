import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

/**
 * Overview owns three capabilities that do NOT travel over the scoped host's
 * RPC, and the redesign lost two of them by gating the whole page on
 * dialability:
 *
 *   - update policy is an account write (`PATCH /api/v3/hosts/:id`) the host
 *     applies on its next check-in. It needs no route to the machine, and
 *     `MyHostsList` — deleted by this branch — used to expose it.
 *   - the local service console runs over the CLI bridge, and is the recovery
 *     surface for a host that is DOWN.
 *   - only snapshots / Remove Traycer are host RPC.
 *
 * These cases pin the split, because the whole settings suite passed while it
 * was wrong.
 */

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

const scopeMocks: { overrides: Partial<HostScope> } = vi.hoisted(() => ({
  overrides: {},
}));

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeMocks.overrides),
  };
});

const REGISTRY_ITEM: HostListItem = {
  hostId: "host-remote",
  displayName: "Studio Linux",
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
    appVersion: "1.4.2",
    lastSeenAt: "2026-01-01T00:00:00Z",
  },
};

function renderOverview(overrides: Partial<HostScope>): void {
  scopeMocks.overrides = overrides;
  // No `hostManagement` on the mock runner host (it defaults to null), so this
  // is the web/mobile shell branch — the one that never mounted the registry
  // controls at all.
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("Overview capability split without host management", () => {
  afterEach(() => {
    cleanup();
    scopeMocks.overrides = {};
  });

  it("keeps account-backed update controls for a host it cannot reach", async () => {
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    const host = hostScopeOptionFixture({
      hostId: "host-remote",
      name: "Studio Linux",
      isLocalMachine: false,
      isActive: false,
      connectable: false,
      registered: true,
      item: REGISTRY_ITEM,
    });

    renderOverview({ host, hostId: host.hostId, status: "unreachable" });

    // The regression: the page-wide gate replaced this, so a registered host
    // with no current route had no update-policy UI anywhere in the app.
    expect(
      screen.getByRole("switch", { name: "Turn on auto-update" }),
    ).not.toBeNull();
    // ...while the genuinely RPC-dependent ROW stays gated — concealed (the
    // gate preserves it hidden through the outage) or absent — and the gate
    // says why. The zone itself still renders: its other row (Remove Traycer)
    // runs over the local CLI bridge, so the gate belongs around the
    // snapshots row, not around the region.
    const clearRow = screen.queryByTestId("settings-clear-file-edit-snapshots");
    expect(clearRow === null || isConcealed(clearRow)).toBe(true);
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
  });

  it("withholds version pinning while an update is already in flight", async () => {
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    const draining: HostListItem = {
      ...REGISTRY_ITEM,
      status: {
        ...REGISTRY_ITEM.status,
        updateState: "pending",
      },
    };
    const host = hostScopeOptionFixture({
      hostId: "host-remote",
      isLocalMachine: false,
      item: draining,
    });

    renderOverview({ host, hostId: host.hostId, status: "unreachable" });

    // `deriveUpdateAffordance` withholds the input for `pending` / `updating`,
    // and this rendered it anyway — so a second desired-version write could
    // retarget an update mid-drain. The policy toggle stays: it is a standing
    // preference, not a new target.
    expect(
      screen.queryByRole("button", { name: "Update to version…" }),
    ).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Turn on auto-update" }),
    ).not.toBeNull();
  });

  it("offers version pinning once no update is in flight", async () => {
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    const host = hostScopeOptionFixture({
      hostId: "host-remote",
      isLocalMachine: false,
      item: REGISTRY_ITEM,
    });

    renderOverview({ host, hostId: host.hostId, status: "unreachable" });

    expect(
      screen.getByRole("button", { name: "Update to version…" }),
    ).not.toBeNull();
  });

  it("says nothing at all about a vanished host", async () => {
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    const host = hostScopeOptionFixture({
      hostId: "host-remote",
      item: REGISTRY_ITEM,
    });

    // The counterweight: loosening the gate must not resurrect the original
    // defect, where an unresolved scope still rendered host controls.
    renderOverview({
      host,
      hostId: host.hostId,
      status: "vanished",
      vanishedHostId: "host-remote",
    });

    expect(screen.getByTestId("host-scope-vanished")).not.toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Turn on auto-update" }),
    ).toBeNull();
    expect(screen.queryByTestId("host-danger-zone")).toBeNull();
  });
});
