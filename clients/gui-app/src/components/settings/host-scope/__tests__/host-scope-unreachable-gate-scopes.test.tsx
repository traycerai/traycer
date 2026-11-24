const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
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
      }),
  };
});
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningConfiguration: () => ({
      hosts: harness.hosts.map((host) => ({
        hostId: host.hostId,
        name: host.name,
      })),
      state: "ready" as const,
      collisions: [],
      retry: () => undefined,
      thisComputerUnread: false,
    }),
  }),
);
vi.mock("@/components/settings/host-scope/use-settings-host-entry", () => ({
  useSettingsHostEntry: () => ({ failed: false, retry: () => undefined }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostScopeGate,
  HostUnreachableGate,
} from "@/components/settings/host-scope/host-scope-gate";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  useHostScope,
  usePickHostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function inClient(node: ReactNode): ReactNode {
  return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
}

/** An Environment or Account page's scope: read-only, on a Local row's computer. */
function ReadOnlyScopeGate(): ReactNode {
  const scope = usePickHostScope({
    kind: "local",
    hostId: "host-away",
    hostName: "Away laptop",
  });
  return (
    <HostUnreachableGate scope={scope} renderNotice={(notice) => notice}>
      <div />
    </HostUnreachableGate>
  );
}

/** A Host page's scope, the one the Host picker re-points. */
function HostPickerScopeGate(): ReactNode {
  const scope = useHostScope();
  return (
    <HostScopeGate scope={scope} skeleton={null}>
      <div />
    </HostScopeGate>
  );
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
});

describe("The unreachable notice on a computer with no connection, beside the active one", () => {
  it("offers the way back and the account's status line on the Host picker's scope, and neither on a read-only scope", () => {
    harness.hosts = [
      hostScopeOptionFixture({
        hostId: "host-active",
        name: "Active laptop",
        isActive: true,
      }),
      hostScopeOptionFixture({
        hostId: "host-away",
        name: "Away laptop",
        isActive: false,
        isLocalMachine: false,
        connectable: false,
      }),
    ];
    harness.activeHostId = "host-active";

    render(inClient(<ReadOnlyScopeGate />));

    expect(screen.getByTestId("host-scope-unreachable")).toBeTruthy();
    expect(screen.queryByTestId("host-scope-return-to-active")).toBeNull();
    expect(
      screen.getByTestId("host-scope-unreachable").textContent,
    ).not.toContain("Its status above is from your account");

    cleanup();
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    useSettingsHostScopeStore
      .getState()
      .selectHost(PERSONAL_PICK, { hostId: "host-away", name: "Away laptop" });
    render(inClient(<HostPickerScopeGate />));

    expect(screen.getByTestId("host-scope-return-to-active")).toBeTruthy();
    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Its status above is from your account",
    );
  });
});
