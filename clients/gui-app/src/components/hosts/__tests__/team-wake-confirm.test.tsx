import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
  HostProfile,
  HostSandboxState,
} from "@traycer/protocol/host/host-status";
import type { SandboxKind } from "@traycer/protocol/host/sandbox-control";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

const HOST_ID = "host-sbx-1";
/** The wake's whole budget: the timeout its first lifecycle request is given. */
const WAKE_BUDGET_MS = 120_000;

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { warning: mocks.toastWarning, error: mocks.toastError },
}));
vi.mock("@/lib/host/runtime", () => ({
  getHostBindingSnapshot: () => mocks.binding,
}));
// The app-wide client the pick reads, free of the app's persistence and
// devtools wiring.
vi.mock("@/lib/query-client", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    }),
  };
});

import { TeamWakeConfirmDialogHost } from "@/components/hosts/team-wake-confirm-dialog";
import { queryClient } from "@/lib/query-client";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  confirmTeamWake,
  settleTeamWake,
  teamWakeAsks,
  useTeamWakeConfirmStore,
} from "@/stores/hosts/team-wake-confirm-store";

/**
 * Waking a team sandbox bills the person who opens it, so
 * every wake path asks "Opening this resumes it on your bundle" first. A team
 * pod, a personal sandbox and a frozen one do not ask.
 */

const TEAM: HostOwnerPrincipal = { kind: "team", id: "team-a", name: "Alpha" };

function signInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

function pending(): boolean {
  return useTeamWakeConfirmStore.getState().pending !== null;
}

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.toastWarning.mockClear();
  mocks.toastError.mockClear();
  signInAs("user-a");
  useTeamWakeConfirmStore.setState({ pending: null });
});
afterEach(() => {
  cleanup();
  useTeamWakeConfirmStore.setState({ pending: null });
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("teamWakeAsks", () => {
  it("asks for a team sandbox that is not a pod and not frozen", () => {
    expect(teamWakeAsks(true, "agent", false)).toBe(true);
    expect(teamWakeAsks(true, null, false)).toBe(true);
  });

  it("does not ask for a team pod, whatever else is true", () => {
    expect(teamWakeAsks(true, "automation", false)).toBe(false);
    expect(teamWakeAsks(true, "automation", true)).toBe(false);
  });

  it("does not ask for a personal sandbox", () => {
    const profiles: readonly (HostProfile | null)[] = [
      "agent",
      "automation",
      null,
    ];
    for (const profile of profiles) {
      expect(teamWakeAsks(false, profile, false)).toBe(false);
    }
  });

  it("does not ask for a frozen sandbox: its wake is refused before it bills", () => {
    expect(teamWakeAsks(true, "agent", true)).toBe(false);
    expect(teamWakeAsks(true, null, true)).toBe(false);
    expect(teamWakeAsks(false, "agent", true)).toBe(false);
  });
});

describe("confirmTeamWake and settleTeamWake", () => {
  it("runs the wake at once when it does not ask, and holds nothing", () => {
    const wake = vi.fn<() => void>();
    confirmTeamWake(false, wake);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(false);
  });

  it("holds the wake when it asks, and does not run it", () => {
    const wake = vi.fn<() => void>();
    confirmTeamWake(true, wake);
    expect(wake).not.toHaveBeenCalled();
    expect(pending()).toBe(true);
  });

  it("runs the held wake once on Resume, and holds nothing after", () => {
    const wake = vi.fn<() => void>();
    confirmTeamWake(true, wake);
    settleTeamWake(true);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(false);
    // A second answer has nothing left to run.
    settleTeamWake(true);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("drops the held wake on Cancel", () => {
    const wake = vi.fn<() => void>();
    confirmTeamWake(true, wake);
    settleTeamWake(false);
    expect(wake).not.toHaveBeenCalled();
    expect(pending()).toBe(false);
  });

  it("answers the wake asked last when a second ask replaces the first", () => {
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    confirmTeamWake(true, first);
    confirmTeamWake(true, second);
    settleTeamWake(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("drops a wake held for another account: its bundle is not this person's", () => {
    const wake = vi.fn<() => void>();
    confirmTeamWake(true, wake);
    signInAs("user-b");
    settleTeamWake(true);
    expect(wake).not.toHaveBeenCalled();
    expect(pending()).toBe(false);
  });

  it("leaves a held wake alone when a no-ask wake runs", () => {
    const held = vi.fn<() => void>();
    const immediate = vi.fn<() => void>();
    confirmTeamWake(true, held);
    confirmTeamWake(false, immediate);
    expect(immediate).toHaveBeenCalledTimes(1);
    expect(held).not.toHaveBeenCalled();
    expect(pending()).toBe(true);
  });
});

describe("<TeamWakeConfirmDialogHost />", () => {
  it("shows nothing while no wake is held", () => {
    render(<TeamWakeConfirmDialogHost />);
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
  });

  it("asks once a wake is held, and runs nothing until Resume is pressed", async () => {
    const wake = vi.fn<() => void>();
    render(<TeamWakeConfirmDialogHost />);
    act(() => {
      confirmTeamWake(true, wake);
    });

    const dialog = await screen.findByTestId("team-wake-confirm");
    expect(dialog.textContent).toContain(
      "Opening this resumes it on your bundle.",
    );
    expect(wake).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("team-wake-confirm-resume"));
    expect(wake).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
    });
  });

  it("drops the wake on Cancel", async () => {
    const wake = vi.fn<() => void>();
    render(<TeamWakeConfirmDialogHost />);
    act(() => {
      confirmTeamWake(true, wake);
    });

    await screen.findByTestId("team-wake-confirm");
    fireEvent.click(screen.getByTestId("team-wake-confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
    });
    expect(wake).not.toHaveBeenCalled();
    expect(pending()).toBe(false);
  });

  it("drops a wake asked by another account instead of keeping it for its return", () => {
    // Asked as A; the dialog mounts with B signed in.
    const wake = vi.fn<() => void>();
    confirmTeamWake(true, wake);
    signInAs("user-b");
    render(<TeamWakeConfirmDialogHost />);
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
    expect(pending()).toBe(false);
    // A signing back in finds no question, and the wake never runs.
    act(() => {
      signInAs("user-a");
    });
    expect(screen.queryByTestId("team-wake-confirm")).toBeNull();
    expect(wake).not.toHaveBeenCalled();
  });
});

/** A directory entry for the sandbox host, as the registry reports it. */
function sandboxEntry(
  owner: HostOwnerPrincipal | undefined,
  profile: HostProfile,
): RemoteHostDirectoryEntry {
  const item: HostListItem = {
    hostId: HOST_ID,
    displayName: "build-box",
    platform: "linux",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    updatePolicy: "manual",
    sandboxState: "suspended",
    sandboxFrozen: false,
    profile,
    ...(owner === undefined ? {} : { owner }),
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.example.test");
}

/** The row a pick hands `wakeSandboxOnPick`; `teamOwned` is what its scope resolved. */
function sleepingOption(
  state: HostSandboxState,
  kind: SandboxKind,
  teamOwned: boolean,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: HOST_ID,
    kind: "sandbox",
    connectable: false,
    sandbox: {
      state,
      frozen: false,
      summary: sandboxSummaryFixture({
        id: "sbx_1",
        hostId: HOST_ID,
        state,
        kind,
      }),
      teamOwned,
    },
  });
}

function listOf(state: HostSandboxState, kind: SandboxKind) {
  return () =>
    Promise.resolve({
      kind: "ok" as const,
      response: {
        sandboxes: [
          sandboxSummaryFixture({ id: "sbx_1", hostId: HOST_ID, state, kind }),
        ],
      },
    });
}

/** The row reads asleep until a verb has been sent, awake after. */
function scriptListUntilVerb(
  binding: FakeSandboxBinding,
  asleep: HostSandboxState,
  kind: SandboxKind,
): void {
  binding.auth.listSandboxes.mockImplementation(() =>
    listOf(
      binding.auth.runSandboxVerb.mock.calls.length > 0 ? "awake" : asleep,
      kind,
    )(),
  );
}

/** Lets a wake's unscheduled awaits settle, runs its poll sleep, and lets the rest settle. */
async function settleWake(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(0);
}

describe("a pick that wakes a sandbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    // Runs any wake still polling out to its end, so none leaks into the next
    // test through the module-level map of wakes in flight.
    await vi.advanceTimersByTimeAsync(300_000);
    queryClient.clear();
    vi.useRealTimers();
  });

  /** A binding whose directory knows the host as `entry`, or not at all. */
  function bindDirectory(
    entry: RemoteHostDirectoryEntry | null,
    asleep: HostSandboxState,
    kind: SandboxKind,
  ): FakeSandboxBinding {
    const binding = createFakeSandboxBinding();
    binding.directory.findById.mockImplementation((hostId) =>
      hostId === HOST_ID ? entry : null,
    );
    scriptListUntilVerb(binding, asleep, kind);
    mocks.binding = binding;
    return binding;
  }

  describe("on a team sandbox", () => {
    it("waits for the confirm: no list read and no verb until Resume, then wakes once", async () => {
      const binding = bindDirectory(
        sandboxEntry(TEAM, "agent"),
        "suspended",
        "agent",
      );

      wakeSandboxOnPick(sleepingOption("suspended", "agent", true));
      await settleWake();

      expect(pending()).toBe(true);
      expect(binding.auth.listSandboxes).not.toHaveBeenCalled();
      expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();

      settleTeamWake(true);
      await settleWake();

      expect(pending()).toBe(false);
      expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
      expect(binding.auth.runSandboxVerb).toHaveBeenCalledWith(
        "sbx_1",
        "resume",
        WAKE_BUDGET_MS,
      );
    });

    it("asks even when the directory has no entry for the picked row", async () => {
      const binding = bindDirectory(null, "suspended", "agent");

      wakeSandboxOnPick(sleepingOption("suspended", "agent", true));
      await settleWake();

      expect(pending()).toBe(true);
      expect(binding.auth.listSandboxes).not.toHaveBeenCalled();
      expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();

      settleTeamWake(true);
      await settleWake();

      expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });

    it("asks when only the directory knows it is a team's: the pick's row says personal", async () => {
      const binding = bindDirectory(
        sandboxEntry(TEAM, "agent"),
        "suspended",
        "agent",
      );

      wakeSandboxOnPick(sleepingOption("suspended", "agent", false));
      await settleWake();

      expect(pending()).toBe(true);
      expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
    });

    it("wakes nothing when the confirm is cancelled", async () => {
      const binding = bindDirectory(null, "suspended", "agent");

      wakeSandboxOnPick(sleepingOption("suspended", "agent", true));
      settleTeamWake(false);
      await settleWake();

      expect(binding.auth.listSandboxes).not.toHaveBeenCalled();
      expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
      expect(pending()).toBe(false);
    });

    it("wakes nothing when the account changed before Resume", async () => {
      const binding = bindDirectory(null, "suspended", "agent");

      wakeSandboxOnPick(sleepingOption("suspended", "agent", true));
      signInAs("user-b");
      settleTeamWake(true);
      await settleWake();

      expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
    });

    it("does not ask again when it joins a wake already in flight for the host", async () => {
      const binding = bindDirectory(null, "suspended", "agent");
      // A lifecycle request that stays pending, so the first wake is in flight.
      binding.auth.runSandboxVerb.mockImplementation(
        (_sandboxId, _verb, timeoutMs) =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  kind: "network-error",
                  detail: "the request timed out",
                }),
              timeoutMs,
            );
          }),
      );

      wakeSandboxOnPick(sleepingOption("suspended", "agent", true));
      settleTeamWake(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);

      // A second pick of the same host while the first wake runs.
      wakeSandboxOnPick(sleepingOption("suspended", "agent", true));
      await vi.advanceTimersByTimeAsync(0);

      expect(pending()).toBe(false);
      expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
    });
  });

  describe("that does not ask", () => {
    it("starts a team pod's wake at once, with the directory's entry or without", async () => {
      for (const entry of [sandboxEntry(TEAM, "automation"), null]) {
        const binding = bindDirectory(entry, "released", "automation");

        wakeSandboxOnPick(sleepingOption("released", "automation", true));
        await settleWake();

        expect(pending()).toBe(false);
        expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
        expect(binding.auth.runSandboxVerb).toHaveBeenCalledWith(
          "sbx_1",
          "start",
          WAKE_BUDGET_MS,
        );
        await vi.advanceTimersByTimeAsync(300_000);
      }
    });

    it("starts a personal sandbox's wake at once, whether the directory has its entry or not", async () => {
      for (const entry of [
        sandboxEntry(undefined, "agent"),
        sandboxEntry({ kind: "user", id: "user-a" }, "agent"),
        null,
      ]) {
        const binding = bindDirectory(entry, "suspended", "agent");

        wakeSandboxOnPick(sleepingOption("suspended", "agent", false));
        await settleWake();

        expect(pending()).toBe(false);
        expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(300_000);
      }
    });
  });
});
