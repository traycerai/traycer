import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";
import { sandboxSummaryFixture } from "./sandbox-fixtures";

const HOST_ID = "host-sbx-1";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  entry: null as RemoteHostDirectoryEntry | null,
  opened: true,
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
vi.mock("@/lib/canvas/tile-open/tile-open-provenance", () => ({
  useTileOpenRequested: () => mocks.opened,
}));

import { SandboxWakeOnTileOpen } from "@/components/hosts/sandbox-wake-on-tile-open";
import { useSandboxWakeForOpenedTile } from "@/hooks/sandboxes/use-sandbox-wake-on-tile-open";

function entryFor(
  kind: "personal" | "sandbox",
  state: HostListItem["sandboxState"],
  frozen: boolean,
): RemoteHostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    {
      hostId: HOST_ID,
      displayName: "build-box",
      platform: "linux",
      kind,
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
      ...(kind === "sandbox"
        ? { sandboxState: state, sandboxFrozen: frozen, profile: "agent" }
        : {}),
    },
    "wss://relay.example.test",
  );
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

beforeEach(() => {
  vi.useFakeTimers();
  mocks.binding = createFakeSandboxBinding();
  mocks.entry = null;
  mocks.opened = true;
  mocks.toastWarning.mockClear();
  mocks.toastError.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSandboxWakeForOpenedTile", () => {
  it("resumes a suspended sandbox, polls until the list says awake, then refreshes the directory without a toast", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    const auth = mocks.binding?.auth;
    auth?.listSandboxes
      .mockImplementationOnce(listOf({ state: "suspended" }))
      .mockImplementation(listOf({ state: "awake" }));

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();

    expect(auth?.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(auth?.runSandboxVerb).toHaveBeenCalledWith("sbx_1", "resume");
    expect(mocks.binding?.directory.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("starts a stopped sandbox", async () => {
    mocks.entry = entryFor("sandbox", "stopped", false);
    const auth = mocks.binding?.auth;
    auth?.listSandboxes
      .mockImplementationOnce(listOf({ state: "stopped" }))
      .mockImplementation(listOf({ state: "awake" }));

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();

    expect(auth?.runSandboxVerb).toHaveBeenCalledWith("sbx_1", "start");
  });

  it("refuses a frozen sandbox at once with the frozen toast and sends no verb, awake or asleep", async () => {
    // A frozen row is asleep by design; a frozen-but-awake one is a freeze
    // whose suspend keeps failing at the provider, and is refused as well.
    for (const state of ["suspended", "awake"] as const) {
      mocks.toastWarning.mockClear();
      mocks.entry = entryFor("sandbox", state, true);
      mocks.binding?.auth.listSandboxes.mockImplementation(
        listOf({ state, frozen: true }),
      );

      renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
        wrapper: wrapper(),
      });
      await settleWake();

      expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
      expect(mocks.toastWarning.mock.calls[0][0]).toBe(
        "This sandbox is frozen",
      );
      cleanup();
    }
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("does nothing for an awake sandbox, a creating one, and a personal host", async () => {
    for (const entry of [
      entryFor("sandbox", "awake", false),
      entryFor("sandbox", "creating", false),
      entryFor("sandbox", "resuming", false),
      entryFor("personal", null, false),
    ]) {
      mocks.entry = entry;
      renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
        wrapper: wrapper(),
      });
      await settleWake();
      cleanup();
    }
    expect(mocks.binding?.auth.listSandboxes).not.toHaveBeenCalled();
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("fires once per mount: a sandbox that wakes and then idles back to sleep under the open tab is not woken again", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    mocks.binding?.auth.listSandboxes
      .mockImplementationOnce(listOf({ state: "suspended" }))
      .mockImplementation(listOf({ state: "awake" }));
    const view = renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);

    const readsAfterFirstWake =
      mocks.binding?.auth.listSandboxes.mock.calls.length ?? 0;
    mocks.entry = entryFor("sandbox", "awake", false);
    view.rerender();
    await settleWake();
    mocks.entry = entryFor("sandbox", "suspended", false);
    view.rerender();
    await settleWake();

    // A second wake would read the list again before deciding anything.
    expect(mocks.binding?.auth.listSandboxes).toHaveBeenCalledTimes(
      readsAfterFirstWake,
    );
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
  });

  it("spends its one shot on the first directory entry: a sandbox first seen awake that later suspends is not woken", async () => {
    mocks.entry = entryFor("sandbox", "awake", false);
    const auth = mocks.binding?.auth;
    const view = renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();
    expect(auth?.listSandboxes).not.toHaveBeenCalled();

    // Idled to sleep under the open tab, by the sandbox's own idle timer.
    mocks.entry = entryFor("sandbox", "suspended", false);
    view.rerender();
    await settleWake();

    expect(auth?.listSandboxes).not.toHaveBeenCalled();
    expect(auth?.runSandboxVerb).not.toHaveBeenCalled();
  });

  it("waits through a directory that has not answered, then wakes once on the first entry if it is asleep", async () => {
    mocks.entry = null;
    const auth = mocks.binding?.auth;
    auth?.listSandboxes
      .mockImplementationOnce(listOf({ state: "suspended" }))
      .mockImplementation(listOf({ state: "awake" }));
    const view = renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();
    expect(auth?.listSandboxes).not.toHaveBeenCalled();
    expect(auth?.runSandboxVerb).not.toHaveBeenCalled();

    mocks.entry = entryFor("sandbox", "suspended", false);
    view.rerender();
    await settleWake();

    expect(auth?.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(auth?.runSandboxVerb).toHaveBeenCalledWith("sbx_1", "resume");
  });

  it("wakes once for a first entry that is asleep, and not again when the entry later reads awake and then suspended", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    const auth = mocks.binding?.auth;
    auth?.listSandboxes
      .mockImplementationOnce(listOf({ state: "suspended" }))
      .mockImplementation(listOf({ state: "awake" }));
    const view = renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();
    expect(auth?.runSandboxVerb).toHaveBeenCalledTimes(1);

    mocks.entry = entryFor("sandbox", "awake", false);
    view.rerender();
    await settleWake();
    mocks.entry = entryFor("sandbox", "suspended", false);
    view.rerender();
    await settleWake();

    expect(auth?.runSandboxVerb).toHaveBeenCalledTimes(1);
  });

  it("wakes a host once however many tiles open on it together", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    // Asleep until a verb has been sent, awake after: both tiles' first reads
    // see it asleep, and only a duplicate wake would send a second verb.
    const auth = mocks.binding?.auth;
    auth?.listSandboxes.mockImplementation(() =>
      listOf({
        state:
          auth.runSandboxVerb.mock.calls.length > 0 ? "awake" : "suspended",
      })(),
    );
    const Wrapper = wrapper();

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: Wrapper,
    });
    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: Wrapper,
    });
    await settleWake();

    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
  });

  it("reports the outcome once when two tiles open on one suspended host while its wake is in flight", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    const auth = mocks.binding?.auth;
    auth?.listSandboxes.mockImplementation(listOf({ state: "suspended" }));
    auth?.runSandboxVerb.mockResolvedValue(refusal(402, "insufficient_credit"));
    const Wrapper = wrapper();

    // The second tile mounts while the first one's wake is still in flight, so
    // it joins that wake; only the starter reports the shared outcome.
    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: Wrapper,
    });
    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: Wrapper,
    });
    await settleWake();

    expect(auth?.runSandboxVerb).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning.mock.calls[0][0]).toBe(
      "Not enough credits to wake this sandbox",
    );
  });

  it("says the wake is not available yet when the control plane does not serve the verb", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    const auth = mocks.binding?.auth;
    auth?.listSandboxes.mockImplementation(listOf({ state: "suspended" }));
    auth?.runSandboxVerb.mockResolvedValue(refusal(501, "verb_not_available"));

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();

    expect(mocks.toastWarning.mock.calls[0][0]).toBe(
      "This sandbox can't be woken from here yet",
    );
  });

  it("names the shortfall when the credit gate refuses the wake", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    const auth = mocks.binding?.auth;
    auth?.listSandboxes.mockImplementation(listOf({ state: "suspended" }));
    auth?.runSandboxVerb.mockResolvedValue({
      ...refusal(402, "insufficient_credit"),
      shortfallMc: 7_000,
      currentAwakeBurnMcPerHour: 120,
    });

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await settleWake();

    expect(mocks.toastWarning.mock.calls[0][0]).toBe(
      "Not enough credits to wake this sandbox",
    );
    expect(mocks.toastWarning.mock.calls[0][1]).toEqual({
      description: "Add 7.00 credits, then try again.",
    });
  });

  it("reports a wake that never lands awake as a failure", async () => {
    mocks.entry = entryFor("sandbox", "suspended", false);
    mocks.binding?.auth.listSandboxes.mockImplementation(
      listOf({ state: "resuming" }),
    );

    renderHook(() => useSandboxWakeForOpenedTile(HOST_ID), {
      wrapper: wrapper(),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });

    expect(mocks.toastError.mock.calls[0][0]).toBe(
      "Couldn't wake this sandbox",
    );
  });
});

describe("<SandboxWakeOnTileOpen />", () => {
  it("wakes the sandbox for a tile that was opened in this session", async () => {
    mocks.opened = true;
    mocks.entry = entryFor("sandbox", "suspended", false);
    mocks.binding?.auth.listSandboxes
      .mockImplementationOnce(listOf({ state: "suspended" }))
      .mockImplementation(listOf({ state: "awake" }));
    const Wrapper = wrapper();
    render(
      <Wrapper>
        <SandboxWakeOnTileOpen hostId={HOST_ID} instanceId="tile-1" />
      </Wrapper>,
    );
    await settleWake();
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(1);
  });

  it("never wakes, or even reads the sandbox list for, a tile a layout restored", async () => {
    mocks.opened = false;
    mocks.entry = entryFor("sandbox", "suspended", false);
    const Wrapper = wrapper();
    render(
      <Wrapper>
        <SandboxWakeOnTileOpen hostId={HOST_ID} instanceId="tile-1" />
      </Wrapper>,
    );
    await settleWake();
    expect(mocks.binding?.auth.listSandboxes).not.toHaveBeenCalled();
    expect(mocks.binding?.auth.runSandboxVerb).not.toHaveBeenCalled();
  });
});
