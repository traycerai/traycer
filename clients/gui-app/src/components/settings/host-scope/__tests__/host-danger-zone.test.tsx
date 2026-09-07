import {
  describe,
  expect,
  it,
  vi,
  afterEach,
  beforeEach,
  type Mock,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import {
  HostDangerZone,
  LocalRecoveryDangerZone,
} from "@/components/settings/host-scope/host-danger-zone";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";

/** These restore it, and add the guard the old row did not have: a destructive action captures its target when
 * armed, so a scope that moves while the confirmation is open cannot re-point the wipe at another host. */

// `vi.hoisted` so the values exist when the hoisted `vi.mock` factory below runs; the binding is annotated
// (matching `runnerHostMock`) rather than cast, since this file deliberately carries no `as` at all.
const {
  mutateSpy,
  capturedQueryClients,
  removeFromAccountSpy,
  removeFromAccountHostIds,
}: {
  readonly mutateSpy: Mock;
  readonly capturedQueryClients: Array<HostClient<HostRpcRegistry> | null>;
  readonly removeFromAccountSpy: Mock;
  readonly removeFromAccountHostIds: string[];
} = vi.hoisted(() => ({
  mutateSpy: vi.fn(),
  capturedQueryClients: [],
  removeFromAccountSpy: vi.fn(),
  removeFromAccountHostIds: [],
}));

// "Remove from account" is an account write, not host RPC and not the local bridge - it goes out through
// `AuthService` over the host binding.
vi.mock("@/hooks/auth/use-deregister-host-mutation", () => ({
  useDeregisterHostFromAccount: (hostId: string) => {
    removeFromAccountHostIds.push(hostId);
    return { mutate: removeFromAccountSpy, isPending: false };
  },
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly client: HostClient<HostRpcRegistry> | null;
  }) => {
    capturedQueryClients.push(args.client);
    return { data: undefined, isPending: false, isError: false };
  },
  useHostMutation: () => ({ mutate: mutateSpy, isPending: false }),
}));

// `RemoveTraycerRow` returns null without the bridge, so with a fixed `null` here the local half of this
// component could never render and its gating went unexercised.
const runnerHostMock: { hostManagement: object | null } = vi.hoisted(() => ({
  hostManagement: null,
}));

const uninstallMock = vi.hoisted(() => ({
  data: undefined as
    | {
        readonly serviceRegistrationRetained: boolean | null;
      }
    | undefined,
  isSuccess: false,
  mutate: vi.fn(),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    hostManagement: runnerHostMock.hostManagement,
    traycerCli: null,
  }),
}));

vi.mock("@/hooks/runner/use-runner-uninstall-traycer-mutation", () => ({
  useRunnerUninstallTraycer: () => ({
    data: uninstallMock.data,
    isSuccess: uninstallMock.isSuccess,
    mutate: uninstallMock.mutate,
    isPending: false,
  }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// A real client over a mock messenger, not a chained assertion.
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
  removeFromAccountSpy.mockClear();
  removeFromAccountHostIds.length = 0;
  runnerHostMock.hostManagement = null;
  uninstallMock.data = undefined;
  uninstallMock.isSuccess = false;
  uninstallMock.mutate.mockClear();
});

// Explicit: without it a previous test's tree stays mounted and `getByTestId` finds two Clear buttons, which
// fails as "multiple elements" rather than as the behaviour under test.
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
    // The snapshots row is host RPC, so an unusable scope does not mount it at all rather than mounting it with a
    // null client.
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
    // Gating the whole zone on a dialable route took the only way to remove a broken install out of the app
    // precisely when the host is stopped or wedged - the sole state anyone reaches for it in.
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

    const removeRow = screen.getByTestId("settings-remove-traycer");
    expect(isConcealed(removeRow)).toBe(false);
    // ...while the genuinely RPC-backed row stays behind the gate - concealed (the gate preserves it hidden
    // through the outage) or absent - and the gate says why instead of the region just disappearing.
    const clearRow = screen.queryByTestId("settings-clear-file-edit-snapshots");
    expect(clearRow === null || isConcealed(clearRow)).toBe(true);
    expect(capturedQueryClients.every((client) => client === null)).toBe(true);
    expect(screen.getByTestId("host-scope-unreachable")).not.toBeNull();
  });

  it("offers retry when the service is positively retained", () => {
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    uninstallMock.isSuccess = true;
    uninstallMock.data = { serviceRegistrationRetained: true };

    render(<LocalRecoveryDangerZone />);

    expect(screen.getByText("Traycer removal incomplete")).not.toBeNull();
    expect(
      screen.getByText("The background service is still registered", {
        exact: false,
      }),
    ).not.toBeNull();
    expect(screen.queryByText("Traycer removed")).toBeNull();
    expect(screen.queryByTestId("settings-quit-after-uninstall")).toBeNull();
    screen.getByTestId("settings-retry-uninstall").click();
    expect(uninstallMock.mutate).toHaveBeenCalledOnce();
  });

  it("reports unknown service teardown without offering a pointless retry", () => {
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    uninstallMock.isSuccess = true;
    uninstallMock.data = { serviceRegistrationRetained: null };

    render(<LocalRecoveryDangerZone />);

    expect(screen.getByText("Traycer removal unverified")).not.toBeNull();
    expect(
      screen.getByText("traycer host service status", { exact: false }),
    ).not.toBeNull();
    expect(screen.queryByText("Traycer removed")).toBeNull();
    expect(screen.queryByTestId("settings-quit-after-uninstall")).toBeNull();
    expect(screen.queryByTestId("settings-retry-uninstall")).toBeNull();
  });

  it("explains the missing rows for an unreachable host that is not this one", () => {
    // The counterweight to loosening the gate: a host with no route and no local bridge must not silently drop the
    // region - that reads as "there is nothing to do here" rather than "this host cannot be reached".
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
    const clearRow = screen.queryByTestId("settings-clear-file-edit-snapshots");
    expect(clearRow === null || isConcealed(clearRow)).toBe(true);
    expect(screen.queryByTestId("settings-remove-traycer")).toBeNull();
  });

  it("destroys the armed confirmation when the scope moves to another host", () => {
    const scopeB = hostScopeFixture({
      host: remoteHost("host-b"),
      status: "ready",
      client: SOME_CLIENT,
    });
    const { rerender } = render(<HostDangerZone scope={scopeB} />);

    // Arm against host-b.
    fireEvent.click(screen.getByRole("button", { name: "Clear snapshots" }));
    expect(screen.getByRole("dialog")).not.toBeNull();

    // The scope moves underneath the open dialog - another window changed the active host, or the sidebar picked a
    // different one.
    rerender(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-c"),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );

    // Destroyed, not retargeted: the gate keys this subtree by host, so the switch unmounts the dialog with
    // everything else. A confirmation the user gave about host-b cannot be re-aimed to wipe host-c's snapshots.
    expect(screen.queryByRole("dialog")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "Clear snapshots" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Clear snapshots",
      }),
    );

    expect(mutateSpy).toHaveBeenCalledTimes(1);
  });

  it("names the host and states what survives in the snapshots-clear confirmation", () => {
    // "Cleared snapshots cannot be restored" is the irreversibility; "conversation history and checkpoint records
    // stay visible" is the reassurance that makes the action legible.
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-b"),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear snapshots" }));
    const copy = screen.getByRole("dialog").textContent;

    expect(copy).toContain("host-b");
    expect(copy).toMatch(/cannot be restored/i);
    expect(copy).toMatch(/conversation history and checkpoint records stay/i);
    expect(copy).toMatch(/undo is disabled for past turns/i);
  });

  it("keeps uninstall reachable in the empty-account recovery state", () => {
    // "No host row" is an enrollment fact, not an installation fact: an install that completed while sign-in did
    // not leaves components on this machine with nothing in the account.
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    render(<LocalRecoveryDangerZone />);
    expect(screen.getByTestId("host-danger-zone")).not.toBeNull();
    expect(screen.getByTestId("settings-remove-traycer")).not.toBeNull();
    // No host means no RPC row - nothing to clear, and nothing that could read through an ambient client.
    expect(
      screen.queryByTestId("settings-clear-file-edit-snapshots"),
    ).toBeNull();
  });

  it("renders no recovery zone at all without the local bridge", () => {
    // Web / remote shells have no uninstall verb; an empty danger group
    // would be a heading with nothing under it.
    runnerHostMock.hostManagement = null;
    const { container } = render(<LocalRecoveryDangerZone />);
    expect(container.firstChild).toBeNull();
  });

  it("offers Remove Traycer only for this computer's host", () => {
    // The bridge must be present: without it the row is withheld for a reason
    // unrelated to locality, and this absence assertion would pass vacuously.
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
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

  it("offers Remove from account for a remote host, and never the word deregister", () => {
    // The copy rule is not a style preference.
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-b"),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );

    const row = screen.getByTestId("settings-remove-host-from-account");
    expect(isConcealed(row)).toBe(false);
    expect(screen.getByTestId("host-danger-zone").textContent).not.toMatch(
      /deregister/i,
    );
    // Bound to the host it is rendered for - the hook, the button and the dialog all close over the same id, so a
    // scope change cannot retarget it.
    expect(removeFromAccountHostIds).toContain("host-b");
  });

  it("does not offer account removal for this computer's host", () => {
    // Offering both would present two destructive buttons whose difference is invisible until afterwards.
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-local",
            name: "This Mac",
            isLocalMachine: true,
          }),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );
    expect(
      screen.queryByTestId("settings-remove-host-from-account"),
    ).toBeNull();
    expect(screen.getByTestId("settings-remove-traycer")).not.toBeNull();
  });

  it("withholds account removal for a host that has no registry row", () => {
    // A directory-only host has no account membership to end, so the row would
    // be a destructive control with nothing behind it.
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-b",
            isLocalMachine: false,
            registered: false,
          }),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );
    expect(
      screen.queryByTestId("settings-remove-host-from-account"),
    ).toBeNull();
  });

  it("tells the truth in the confirmation: nothing is uninstalled, and the host does NOT come back on its own", () => {
    // So it loops instead of recovering, and the interactive login path sits below that same early return, which
    // is why the copy must not offer "sign in again" as the remedy either.
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-b"),
          status: "ready",
          client: SOME_CLIENT,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("settings-remove-host-from-account"));
    const dialog = screen.getByRole("dialog");
    const copy = dialog.textContent;
    expect(copy).toMatch(/nothing on that machine changes/i);
    // The two negatives, stated rather than implied.
    expect(copy).toMatch(/won't rejoin on its own/i);
    expect(copy).toMatch(
      /signing in on that machine again won't bring it back/i,
    );
    // ...and the one positive that IS true: the row is deregistered, not
    // revoked, so the id survives and a re-setup restores name and settings.
    expect(copy).toMatch(/host ID is kept/i);
    expect(copy).not.toMatch(/deregister/i);
    // The refuted claim, pinned as absent. Without this the copy could drift back to promising self-recovery and
    // every assertion above would still pass.
    expect(copy).not.toMatch(/re-enrols on its own|re-enrolls on its own/i);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from account" }),
    );
    expect(removeFromAccountSpy).toHaveBeenCalledTimes(1);
  });
});
