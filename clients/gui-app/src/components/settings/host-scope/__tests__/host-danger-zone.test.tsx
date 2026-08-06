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
  useHostQuery: (args: {
    readonly client: HostClient<HostRpcRegistry> | null;
  }) => {
    capturedQueryClients.push(args.client);
    return { data: undefined, isPending: false, isError: false };
  },
  useHostMutation: () => ({ mutate: mutateSpy, isPending: false }),
}));

// Mutable so a test can put this shell on the desktop branch. `RemoveTraycerRow`
// returns null without the bridge, so with a fixed `null` here the local
// half of this component could never render and its gating went unexercised.
const runnerHostMock: { hostManagement: object | null } = vi.hoisted(() => ({
  hostManagement: null,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    hostManagement: runnerHostMock.hostManagement,
    traycerCli: null,
  }),
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
const SOME_CLIENT: HostClient<HostRpcRegistry> =
  new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-danger-zone-test",
      handlers: {},
    }),
  });

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
  runnerHostMock.hostManagement = null;
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
        scope={hostScopeFixture({
          host: null,
          status: "vanished",
          vanishedHostId: "gone",
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("never reads through a client once the scoped host has vanished", () => {
    // The assertion the deleted test made, restored — and now satisfied a
    // stronger way. The snapshots row is host RPC, so an unusable scope does
    // not mount it at all rather than mounting it with a null client. Either
    // way the guarantee is the one that matters: nothing here can reach the
    // previously-active host.
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
    expect(
      screen.queryByTestId("settings-clear-file-edit-snapshots"),
    ).toBeNull();
    expect(capturedQueryClients).toHaveLength(0);
  });

  it("keeps Remove Traycer reachable while this computer's host is down", () => {
    // The regression, and the one that mattered most: `RemoveTraycerRow` calls
    // `hostManagement.uninstallTraycer()` over the LOCAL CLI bridge, not host
    // RPC. Gating the whole zone on a dialable route took the only way to
    // remove a broken install out of the app precisely when the host is
    // stopped or wedged — the sole state anyone reaches for it in.
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-local",
            name: "This Mac",
            isLocalMachine: true,
            connectable: false,
          }),
          status: "unreachable",
          client: null,
        })}
      />,
    );

    expect(screen.getByTestId("settings-remove-traycer")).not.toBeNull();
    // ...while the genuinely RPC-backed row stays gated, mounts no read, and
    // says why it is missing instead of just disappearing.
    expect(
      screen.queryByTestId("settings-clear-file-edit-snapshots"),
    ).toBeNull();
    expect(capturedQueryClients).toHaveLength(0);
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
  });

  it("explains the missing rows for an unreachable host that is not this one", () => {
    // The counterweight to loosening the gate: a host with no route and no
    // local bridge must not silently drop the region — that reads as "there is
    // nothing to do here" rather than "this host cannot be reached".
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-b"),
          status: "unreachable",
          client: null,
        })}
      />,
    );
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
    expect(
      screen.queryByTestId("settings-clear-file-edit-snapshots"),
    ).toBeNull();
    expect(screen.queryByTestId("settings-remove-traycer")).toBeNull();
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
