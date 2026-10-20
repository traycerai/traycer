import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  HostListItem,
  HostOwnerPrincipal,
  HostProfile,
  HostSandboxState,
} from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { SANDBOX_FROZEN_MESSAGE } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";
import { sandboxSummaryFixture } from "./sandbox-fixtures";

const HOST_ID = "host-sbx-1";
const TEAM: HostOwnerPrincipal = { kind: "team", id: "team-a", name: "Alpha" };

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  entry: null as RemoteHostDirectoryEntry | null,
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { warning: mocks.toastWarning, error: mocks.toastError },
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.entry,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));

import { useSandboxWakeForOpenedTile } from "@/hooks/sandboxes/use-sandbox-wake-on-tile-open";
import {
  settleTeamWake,
  useTeamWakeConfirmStore,
} from "@/stores/hosts/team-wake-confirm-store";

/**
 * A tab opened on a TEAM sandbox waits for the confirm before it
 * wakes the sandbox on the opener's bundle; a team pod and a personal sandbox
 * wake at once. A frozen team sandbox's refusal blames the payer's bundle.
 */

function entryFor(input: {
  readonly state: HostSandboxState;
  readonly frozen: boolean;
  readonly owner: HostOwnerPrincipal | undefined;
  readonly profile: HostProfile;
}): RemoteHostDirectoryEntry {
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
    sandboxState: input.state,
    sandboxFrozen: input.frozen,
    profile: input.profile,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.example.test");
}

/** The tab opens on `entry`; the directory the wake reads answers the same. */
function open(entry: RemoteHostDirectoryEntry): FakeSandboxBinding {
  const binding = createFakeSandboxBinding();
  binding.directory.findById.mockImplementation((hostId) =>
    hostId === HOST_ID ? entry : null,
  );
  mocks.binding = binding;
  mocks.entry = entry;
  return binding;
}

function listOf(row: Partial<SandboxSummary>) {
  return () =>
    Promise.resolve({
      kind: "ok" as const,
      response: {
        sandboxes: [
          sandboxSummaryFixture({ id: "sbx_1", hostId: HOST_ID, ...row }),
        ],
      },
    });
}

/** The row reads asleep until a verb has been sent, awake after. */
function scriptListUntilVerb(
  binding: FakeSandboxBinding,
  asleep: HostSandboxState,
): void {
  binding.auth.listSandboxes.mockImplementation(() =>
    listOf({
      state:
        binding.auth.runSandboxVerb.mock.calls.length > 0 ? "awake" : asleep,
    })(),
  );
}

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** Lets the wake's first (unscheduled) awaits settle, then runs its poll sleeps. */
async function settleWake(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function pending(): boolean {
  return useTeamWakeConfirmStore.getState().pending !== null;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.binding = createFakeSandboxBinding();
  mocks.entry = null;
  mocks.toastWarning.mockClear();
  mocks.toastError.mockClear();
  useTeamWakeConfirmStore.setState({ pending: null });
});
afterEach(() => {
  cleanup();
  useTeamWakeConfirmStore.setState({ pending: null });
  vi.useRealTimers();
});

describe("useSandboxWakeForOpenedTile on a team sandbox", () => {
  it("waits for the confirm: no list read and no verb until Resume, then wakes once", async () => {
    const binding = open(
      entryFor({
        state: "suspended",
        frozen: false,
        owner: TEAM,
        profile: "agent",
      }),
    );
    scriptListUntilVerb(binding, "suspended");

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
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
      expect.any(Number),
    );
  });

  it("wakes nothing when the confirm is cancelled", async () => {
    const binding = open(
      entryFor({
        state: "suspended",
        frozen: false,
        owner: TEAM,
        profile: "agent",
      }),
    );
    scriptListUntilVerb(binding, "suspended");

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();
    settleTeamWake(false);
    await settleWake();

    expect(binding.auth.listSandboxes).not.toHaveBeenCalled();
    expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("wakes a team pod at once, without asking", async () => {
    const binding = open(
      entryFor({
        state: "released",
        frozen: false,
        owner: TEAM,
        profile: "automation",
      }),
    );
    scriptListUntilVerb(binding, "released");

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();

    expect(pending()).toBe(false);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledWith(
      "sbx_1",
      "start",
      expect.any(Number),
    );
  });

  it("wakes a personal sandbox at once, without asking", async () => {
    const binding = open(
      entryFor({
        state: "suspended",
        frozen: false,
        owner: undefined,
        profile: "agent",
      }),
    );
    scriptListUntilVerb(binding, "suspended");

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();

    expect(pending()).toBe(false);
    expect(binding.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
  });
});

describe("useSandboxWakeForOpenedTile on a frozen sandbox", () => {
  async function openFrozen(owner: HostOwnerPrincipal | undefined) {
    const binding = open(
      entryFor({ state: "suspended", frozen: true, owner, profile: "agent" }),
    );
    binding.auth.listSandboxes.mockImplementation(
      listOf({ state: "suspended", frozen: true }),
    );
    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();
    return binding;
  }

  it("says its payer's bundle is out on a team sandbox, asks nothing and sends no verb", async () => {
    const binding = await openFrozen(TEAM);

    expect(pending()).toBe(false);
    expect(binding.auth.runSandboxVerb).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith("This sandbox is frozen", {
      description: "Its payer's bundle is out.",
    });
  });

  it("keeps the personal message on a personal sandbox", async () => {
    await openFrozen(undefined);

    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith("This sandbox is frozen", {
      description: SANDBOX_FROZEN_MESSAGE,
    });
  });
});
