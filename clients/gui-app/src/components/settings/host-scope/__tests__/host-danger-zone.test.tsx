import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";

/**
 * `general-settings-panel.test.tsx` used to carry the ONLY test that enforced
 * the no-silent-fallback invariant for this row — "must not silently fall back
 * to reading/writing through the active host", asserting the query client was
 * null once the picked host vanished. The row moved here during the host-scope
 * overhaul and that test was deleted with its old home, replacing nothing.
 *
 * These restore it, and add the guard the old row did not have: a destructive
 * action captures its target when ARMED, so a scope that moves while the
 * confirmation is open cannot re-point the wipe at another host.
 */

const mutateSpy = vi.fn();
const capturedQueryClients: Array<HostClient<HostRpcRegistry> | null> = [];

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: { readonly client: HostClient<HostRpcRegistry> | null }) => {
    capturedQueryClients.push(args.client);
    return { data: undefined, isPending: false, isError: false };
  },
  useHostMutation: () => ({ mutate: mutateSpy, isPending: false }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ hostManagement: null, traycerCli: null }),
}));

vi.mock("@/hooks/runner/use-runner-uninstall-traycer-mutation", () => ({
  useRunnerUninstallTraycer: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// A real client over a mock messenger, not a chained assertion — the repo's
// lint forbids `as unknown as` in tests too, and rightly: a cast here would
// also hide the day this component starts calling something the stub lacks.
const SOME_CLIENT: HostClient<HostRpcRegistry> = new HostClient<HostRpcRegistry>(
  {
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-danger-zone-test",
      handlers: {},
    }),
  },
);

function remoteHost(hostId: string): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: hostId,
    isLocalMachine: false,
  });
}

beforeEach(() => {
  mutateSpy.mockClear();
  capturedQueryClients.length = 0;
});

// Explicit: without it a previous test's tree stays mounted and `getByTestId`
// finds two Clear buttons, which fails as "multiple elements" rather than as
// the behaviour under test.
afterEach(cleanup);

describe("HostDangerZone", () => {
  it("renders nothing when the scope resolved to no host", () => {
    // A destructive zone with no subject is the shape that let a wipe be aimed
    // at whatever the ambient client happened to be.
    const { container } = render(
      <HostDangerZone
        scope={hostScopeFixture({ host: null, status: "vanished", vanishedHostId: "gone" })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("never reads through a client once the scoped host has vanished", () => {
    // The assertion the deleted test made, restored: no client, therefore no
    // read or write can reach the previously-active host.
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-b"),
          status: "vanished",
          vanishedHostId: "host-b",
          client: null,
        })}
      />,
    );
    expect(capturedQueryClients).not.toHaveLength(0);
    expect(capturedQueryClients.every((client) => client === null)).toBe(true);
  });

  it("refuses to clear when the scope moves to another host after arming", () => {
    const scopeB = hostScopeFixture({
      host: remoteHost("host-b"),
      status: "ready",
      client: SOME_CLIENT,
    });
    const { rerender } = render(<HostDangerZone scope={scopeB} />);

    // Arm against host-b.
    fireEvent.click(screen.getByTestId("settings-clear-file-edit-snapshots"));

    // The scope moves underneath the open dialog — another window changed the
    // active host, or the sidebar picked a different one.
    rerender(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-c"),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("confirm-action"));

    // Refused, not retargeted. Retargeting would wipe host-c's snapshots on a
    // confirmation the user gave about host-b.
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it("clears when the scoped host is still the armed one", () => {
    // The counterpart: the guard must not be so broad that it blocks the
    // ordinary path, which is how an "always safe" guard becomes dead weight.
    const scope = hostScopeFixture({
      host: remoteHost("host-b"),
      status: "ready",
      client: SOME_CLIENT,
    });
    render(<HostDangerZone scope={scope} />);

    fireEvent.click(screen.getByTestId("settings-clear-file-edit-snapshots"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(mutateSpy).toHaveBeenCalledTimes(1);
  });

  it("offers Remove Traycer only for this computer's host", () => {
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-b"),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );
    expect(screen.queryByText(/Remove Traycer/)).toBeNull();
  });
});
