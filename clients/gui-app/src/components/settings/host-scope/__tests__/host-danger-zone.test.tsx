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

/**
 * Installation's Danger zone holds only host removal actions: removing this
 * computer's install locally, or removing a remote host from the account.
 * File edit snapshots live on Data and their host-bound clear behavior is
 * covered by `host-overview-data-tab.test.tsx`.
 */

// `vi.hoisted` so the values exist when the hoisted `vi.mock` factory below
// runs; the binding is annotated (matching `runnerHostMock`) rather than cast,
// since this file deliberately carries no `as` at all.
const {
  removeFromAccountSpy,
  removeFromAccountHostIds,
}: {
  readonly removeFromAccountSpy: Mock;
  /** Which host id the account-removal hook was BOUND to, per render. */
  readonly removeFromAccountHostIds: string[];
} = vi.hoisted(() => ({
  removeFromAccountSpy: vi.fn(),
  removeFromAccountHostIds: [],
}));

// "Remove from account" is an ACCOUNT write, not host RPC and not the local
// bridge — it goes out through `AuthService` over the host binding. Mocked at
// the hook the way this suite already mocks the uninstall hook, so the row's
// gating and copy can be tested without standing up an auth boundary.
vi.mock("@/hooks/auth/use-deregister-host-mutation", () => ({
  useDeregisterHostFromAccount: (hostId: string) => {
    removeFromAccountHostIds.push(hostId);
    return { mutate: removeFromAccountSpy, isPending: false };
  },
}));

// Mutable so a test can put this shell on the desktop branch. `RemoveTraycerRow`
// returns null without the bridge, so with a fixed `null` here the local
// half of this component could never render and its gating went unexercised.
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
  removeFromAccountSpy.mockClear();
  removeFromAccountHostIds.length = 0;
  runnerHostMock.hostManagement = null;
  uninstallMock.data = undefined;
  uninstallMock.isSuccess = false;
  uninstallMock.mutate.mockClear();
});

// Explicit so a previous test's dialog cannot leave its portal mounted while
// the next test asks about a removal action.
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

  it("renders no empty Danger zone for an unregistered remote host", () => {
    const { container } = render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: hostScopeOptionFixture({
            hostId: "host-b",
            name: "host-b",
            isLocalMachine: false,
            registered: false,
          }),
          status: "unreachable",
          client: null,
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders no empty Danger zone for this computer without its uninstall bridge", () => {
    const { container } = render(
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
    expect(container.firstChild).toBeNull();
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

    const removeRow = screen.getByTestId("settings-remove-traycer");
    expect(isConcealed(removeRow)).toBe(false);
    expect(screen.getByTestId("host-danger-zone")).not.toBeNull();
    expect(
      screen.queryByTestId("settings-clear-file-edit-snapshots"),
    ).toBeNull();
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

  it("keeps remote account removal available while the host is unreachable", () => {
    render(
      <HostDangerZone
        scope={hostScopeFixture({
          host: remoteHost("host-b"),
          status: "unreachable",
          client: null,
        })}
      />,
    );
    expect(
      screen.getByTestId("settings-remove-host-from-account"),
    ).not.toBeNull();
    expect(screen.queryByTestId("settings-remove-traycer")).toBeNull();
    expect(
      screen.queryByTestId("settings-clear-file-edit-snapshots"),
    ).toBeNull();
  });

  it("keeps uninstall reachable in the empty-account recovery state", () => {
    // "No host row" is an enrollment fact, not an installation fact: an
    // install that completed while sign-in did not leaves components on this
    // machine with nothing in the account — and this page is the only
    // uninstall surface. The recovery variant renders the local-bridge row
    // without any host in hand.
    runnerHostMock.hostManagement = { uninstallTraycer: vi.fn() };
    render(<LocalRecoveryDangerZone />);
    expect(screen.getByTestId("host-danger-zone")).not.toBeNull();
    expect(screen.getByTestId("settings-remove-traycer")).not.toBeNull();
    // Recovery contains only the local uninstall row; snapshots now live on
    // the Data tab for a host that can answer their RPCs.
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
    // The remote counterpart to Remove Traycer, on a THIRD capability plane:
    // an account write that needs no route to the machine.
    //
    // The copy rule is not a style preference. This app already says
    // "Deregister" in the Installation group on the same tab, for OS-SERVICE
    // deregistration — a machine-local repair with nothing in common with
    // ending a host's membership of an account. Two destructive controls
    // sharing a verb is how someone reaches for the wrong one.
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
    // Bound to the host it is rendered for — the hook, the button and the
    // dialog all close over the same id, so a scope change cannot retarget it.
    expect(removeFromAccountHostIds).toContain("host-b");
  });

  it("does not offer account removal for this computer's host", () => {
    // This computer gets Remove Traycer, which actually removes something.
    // Offering both would present two destructive buttons whose difference is
    // invisible until afterwards.
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
    // Pinned because the copy is a claim about behaviour two repos away, and
    // the first version of it was WRONG in the reassuring direction — it said a
    // running host "re-enrols on its own and comes back".
    //
    // It does not. `POST /api/v3/hosts/:id/deregister` stamps `deregisteredAt`
    // and clears the presence lease (no revoke, nothing touched on the box).
    // The host's next heartbeat 404s and it reads that as `not-registered`, but
    // `reconcile()` then finds the on-box device credential still present and
    // still matching, takes `adoptActiveCredential()` and RETURNS — before
    // either enrollment source, and `registerHost()` is the only caller that
    // clears `deregisteredAt`. So it loops instead of recovering, and the
    // interactive login path sits below that same early return, which is why
    // the copy must not offer "sign in again" as the remedy either.
    //
    // This asserts the NEGATIVE claims explicitly. A dialog that quietly
    // promises self-recovery is worse than one that says nothing: it is the
    // reason someone would leave a host removed and expect it back.
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
    // The refuted claim, pinned as ABSENT. Without this the copy could drift
    // back to promising self-recovery and every assertion above would still
    // pass.
    expect(copy).not.toMatch(/re-enrols on its own|re-enrolls on its own/i);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove from account" }),
    );
    expect(removeFromAccountSpy).toHaveBeenCalledTimes(1);
  });
});
