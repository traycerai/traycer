// There is no capability gate left to mock: the component no longer consults the negotiated-manifest registry
// at all, so whether a host supports `host.restart` is settled only by actually dialing it.
interface HostBindingFixture {
  readonly directory: {
    readonly getLocalEntry: () => HostDirectoryEntry | null;
  };
}
const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({ current: null }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

interface DirectoryListMockState {
  readonly data: readonly HostDirectoryEntry[] | undefined;
}
const directoryListMock = vi.hoisted(
  (): { current: DirectoryListMockState } => ({
    current: { data: undefined },
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => directoryListMock.current,
}));

type HostClientResolver = (
  hostId: string | null,
) => HostClient<HostRpcRegistry> | null;
const clientForHostIdMock = vi.hoisted((): { current: HostClientResolver } => ({
  current: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    clientForHostIdMock.current(hostId),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostRpcRegistry } from "@/lib/host";
import { LocalHostRestartFlow } from "@/components/host/local-host-restart-flow";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { buildOverviewHostFixture } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

const PRESENT_BINDING: HostBindingFixture = {
  directory: { getLocalEntry: () => null },
};

function localEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: "ws://127.0.0.1:0",
    version: "1.5.0",
    transportDialability: "dialable",
  };
}

function busyMessage(subject: string): string {
  return `${subject} still keeping this host busy. Nothing was interrupted; try again when the work finishes. Force restart ends it immediately.`;
}

// A dedicated helper rather than a parameter on `localEntry` itself, so every existing call site keeps its
// current (dialable) meaning unchanged.
function nonDialableLocalEntry(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: null,
    version: "1.5.0",
    transportDialability: "not-dialable",
  };
}

// Copied verbatim from `local-host-restart-flow.tsx` (neither constant is exported) so a change to the
// production copy breaks these assertions instead of silently drifting from what the user actually sees.
const UNREACHABLE_CLIENT_MESSAGE =
  "Traycer couldn't open a connection to ask this host to stop cleanly - you " +
  "may be signed out, or its credentials may be refreshing. Force restart " +
  "kills the host process and relaunches it, ending whatever it is running.";
const HOST_CHANGED_DESCRIPTION =
  "This machine's host was replaced while this dialog was open, so nothing " +
  "was stopped. Restart again to check the new host.";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** Both the menu and tray listeners hold `requested`/`onClose` state themselves and hand it to
 * `LocalHostRestartFlow` as controlled props. */
function RestartFlowHarness(): ReactNode {
  const [requested, setRequested] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setRequested(true)}>
        Open restart
      </button>
      <LocalHostRestartFlow
        requested={requested}
        onClose={() => setRequested(false)}
      />
    </>
  );
}

function renderFlow(runnerHost: IRunnerHost): void {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <RestartFlowHarness />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

async function openAndConfirm(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Open restart" }));
  await screen.findByTestId("confirm-destructive-dialog");
  fireEvent.click(screen.getByTestId("confirm-action"));
}

afterEach(() => {
  cleanup();
  hostBindingMock.current = null;
  directoryListMock.current = { data: undefined };
  clientForHostIdMock.current = () => null;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

describe("<LocalHostRestartFlow /> - no host runtime binding (ForceOnly arm)", () => {
  it("confirms straight to requestHostRespawn, never resolving a cooperative client", async () => {
    hostBindingMock.current = null;
    const clientResolver = vi.fn<HostClientResolver>(() => null);
    clientForHostIdMock.current = clientResolver;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    fireEvent.click(screen.getByRole("button", { name: "Open restart" }));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Restarting will stop");
    expect(requestHostRespawn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
    // The ForceOnly arm must never even ask "which host does this id resolve to" - a regression that started
    // resolving one anyway would be invisible to a mere "respawn was called" assertion.
    expect(clientResolver).not.toHaveBeenCalled();
  });

  it("a declined respawn resolves informationally, not as an error, and closes the dialog", async () => {
    hostBindingMock.current = null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({
        kind: "declined" as const,
        message: "Another Traycer process holds the management lock.",
      }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        "Host not restarted",
        expect.objectContaining({
          description: "Another Traycer process holds the management lock.",
        }),
      );
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
  });

  it("runs the force respawn under the shared runner.host.restart mutation key, visible cross-surface via useIsMutating", async () => {
    hostBindingMock.current = null;
    let releaseRespawn: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseRespawn = resolve;
    });
    const requestHostRespawn = vi.fn(async () => {
      await gate;
      return { kind: "restarted" as const };
    });
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    const queryClient = makeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <RestartFlowHarness />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open restart" }));
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(
        queryClient.isMutating({
          mutationKey: runnerMutationKeys.hostRestart(),
        }),
      ).toBeGreaterThan(0);
    });

    await act(async () => {
      releaseRespawn?.();
      await gate;
    });

    await waitFor(() => {
      expect(
        queryClient.isMutating({
          mutationKey: runnerMutationKeys.hostRestart(),
        }),
      ).toBe(0);
    });
  });
});

describe("<LocalHostRestartFlow /> - host runtime binding present, local host resolved (Cooperative arm)", () => {
  it("dispatches the host.restart RPC with a non-empty transitionId and never calls requestHostRespawn", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    // No `overrideHandlers` here, deliberately: the fixture's own default `host.restart` handler already answers
    // `accepted` and is what feeds `restartCalls` / `restartTransitionIds` below.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(fixture.restartCalls()).toBe(1);
    });
    expect(fixture.restartTransitionIds()[0].length).toBeGreaterThan(0);
    expect(requestHostRespawn).not.toHaveBeenCalled();
  });

  it("an accepted outcome shows the success toast, closes without opening the busy dialog, and never force-respawns", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Host restart requested");
    });
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(requestHostRespawn).not.toHaveBeenCalled();
  });

  it.each([
    [2, "2 sessions are"],
    [1, "1 session is"],
  ] as const)(
    "busySessionCount=%i renders the exact busy copy, and Force respawns",
    async (busySessionCount, subject) => {
      hostBindingMock.current = PRESENT_BINDING;
      directoryListMock.current = { data: [localEntry("host-a")] };
      const fixture = buildOverviewHostFixture({
        hostId: "host-a",
        isLocalMachine: true,
        overrideHandlers: {
          "host.restart": () =>
            Promise.resolve({
              outcome: "busy" as const,
              verdict: {
                busySessionCount,
                blockers: null,
                busyBreakdown: null,
              },
            }),
        },
      });
      clientForHostIdMock.current = (hostId) =>
        hostId === "host-a" ? fixture.client : null;
      const requestHostRespawn = vi.fn(() =>
        Promise.resolve({ kind: "restarted" as const }),
      );
      const runnerHost = createFakeRunnerHost({ requestHostRespawn });
      renderFlow(runnerHost);

      await openAndConfirm();

      const busyDialog = await screen.findByTestId(
        "host-busy-force-defer-dialog",
      );
      // The same dialog serves the update banner's Force; `data-purpose`
      // is what tells a page test which of the two it opened.
      expect(busyDialog.dataset.purpose).toBe("restart");
      expect(busyDialog.textContent).toContain(busyMessage(subject));
      expect(
        screen.getByRole("button", { name: "Force restart" }),
      ).not.toBeNull();

      fireEvent.click(screen.getByTestId("host-busy-force"));

      await waitFor(() => {
        expect(requestHostRespawn).toHaveBeenCalledTimes(1);
      });
    },
  );

  it("an RPC rejection offers force with the 'didn't complete' copy; deferring and retrying carries the SAME transitionId", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    const transitionIds: string[] = [];
    let attempt = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": (req) => {
          transitionIds.push(req.transitionId);
          attempt += 1;
          if (attempt === 1) {
            return Promise.reject(new Error("relay dropped the ack"));
          }
          return Promise.resolve({ outcome: "accepted" as const });
        },
      },
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();
    const errorDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    expect(errorDialog.textContent).toContain(
      "This host didn't complete the restart request.",
    );
    expect(transitionIds).toHaveLength(1);

    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });

    await openAndConfirm();
    await waitFor(() => {
      expect(transitionIds).toHaveLength(2);
    });

    expect(transitionIds[1]).toBe(transitionIds[0]);
    expect(requestHostRespawn).not.toHaveBeenCalled();
  });

  it("an armed id minted against one host is not adopted when dispatching to another", async () => {
    const queryClient = makeQueryClient();
    let liveEntry: HostDirectoryEntry | null = localEntry("host-a");
    hostBindingMock.current = {
      directory: { getLocalEntry: () => liveEntry },
    };
    directoryListMock.current = { data: [localEntry("host-a")] };
    const hostATransitionIds: string[] = [];
    const hostBTransitionIds: string[] = [];
    // Host A's `host.restart` never answers definitively - it rejects, which is the one outcome that keeps
    // `armedRestartIdRef` armed rather than clearing it (see "an RPC rejection offers force...
    const hostAFixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": (req) => {
          hostATransitionIds.push(req.transitionId);
          return Promise.reject(new Error("relay dropped the ack"));
        },
      },
    });
    const hostBFixture = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": (req) => {
          hostBTransitionIds.push(req.transitionId);
          return Promise.resolve({ outcome: "accepted" as const });
        },
      },
    });
    clientForHostIdMock.current = (hostId) => {
      if (hostId === "host-a") return hostAFixture.client;
      if (hostId === "host-b") return hostBFixture.client;
      return null;
    };
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    // A fresh element tree (not a reused reference) on every call.
    function buildHarness(): ReactNode {
      return (
        <QueryClientProvider client={queryClient}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <RestartFlowHarness />
          </RunnerHostProvider>
        </QueryClientProvider>
      );
    }
    const result = render(buildHarness());

    await openAndConfirm();
    const errorDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    expect(errorDialog.textContent).toContain(
      "This host didn't complete the restart request.",
    );
    expect(hostATransitionIds).toHaveLength(1);

    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });

    // Both resolution sources have to agree, or the live entry would simply win and the test would not exercise
    // the directory-list side of the switch.
    liveEntry = localEntry("host-b");
    directoryListMock.current = { data: [localEntry("host-b")] };
    result.rerender(buildHarness());

    await openAndConfirm();
    await waitFor(() => {
      expect(hostBTransitionIds).toHaveLength(1);
    });

    // The armed id from host A's ambiguous rejection must not have been handed to host B - that would ask host B
    // to adopt a claim it never granted.
    expect(hostBTransitionIds[0]).not.toBe(hostATransitionIds[0]);
    expect(requestHostRespawn).not.toHaveBeenCalled();
  });

  it("after a busy verdict, a fresh invoke+confirm carries a NEW transitionId", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    const transitionIds: string[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": (req) => {
          transitionIds.push(req.transitionId);
          return Promise.resolve({
            outcome: "busy" as const,
            verdict: {
              busySessionCount: 1,
              blockers: null,
              busyBreakdown: null,
            },
          });
        },
      },
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const runnerHost = createFakeRunnerHost({});
    renderFlow(runnerHost);

    await openAndConfirm();
    await screen.findByTestId("host-busy-force-defer-dialog");
    expect(transitionIds).toHaveLength(1);

    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });

    await openAndConfirm();
    await waitFor(() => {
      expect(transitionIds).toHaveLength(2);
    });

    expect(transitionIds[0].length).toBeGreaterThan(0);
    expect(transitionIds[1].length).toBeGreaterThan(0);
    expect(transitionIds[0]).not.toBe(transitionIds[1]);
  });

  it("a rejection followed by a successful force clears the armed id; the next attempt mints a NEW transitionId", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    const transitionIds: string[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": (req) => {
          transitionIds.push(req.transitionId);
          return Promise.reject(new Error("relay dropped the ack"));
        },
      },
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();
    await screen.findByTestId("host-busy-force-defer-dialog");
    expect(transitionIds).toHaveLength(1);

    // Force, unlike a mere deferral, is a definitive end to the action the armed id names - the process it
    // identified is gone - so `useForceHostRespawn`'s `onRestarted` callback nulls `armedRestartIdRef`.
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });

    await openAndConfirm();
    await waitFor(() => {
      expect(transitionIds).toHaveLength(2);
    });

    expect(transitionIds[1]).not.toBe(transitionIds[0]);
  });

  it("a declined force does NOT clear the armed id; the next attempt reuses the SAME transitionId", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    const transitionIds: string[] = [];
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": (req) => {
          transitionIds.push(req.transitionId);
          return Promise.reject(new Error("relay dropped the ack"));
        },
      },
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    // `declined` performed nothing - the host was removed, or another process holds the management lock - so it
    // must not be treated as the definitive end that a real respawn is in the test above.
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({
        kind: "declined" as const,
        message: "Another Traycer process holds the management lock.",
      }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();
    await screen.findByTestId("host-busy-force-defer-dialog");
    expect(transitionIds).toHaveLength(1);

    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });

    await openAndConfirm();
    await waitFor(() => {
      expect(transitionIds).toHaveLength(2);
    });

    expect(transitionIds[1]).toBe(transitionIds[0]);
  });

  it("attempts the cooperative RPC even when the host rejects it (too old for host.restart), offering force only after the explicit click", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    // No capability gate is consulted anymore, so there is nothing left to record on the negotiated-manifest
    // registry to steer this test.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": () =>
          Promise.reject(new Error("host too old for host.restart")),
      },
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    const errorDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    expect(errorDialog.textContent).toContain(
      "This host didn't complete the restart request.",
    );
    expect(requestHostRespawn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to requestHostRespawn directly when no local directory entry resolves", async () => {
    hostBindingMock.current = {
      directory: { getLocalEntry: () => null },
    };
    directoryListMock.current = { data: [] };
    const clientResolver = vi.fn<HostClientResolver>(() => null);
    clientForHostIdMock.current = clientResolver;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
    // Resolved with `null` (no local id to look up), not skipped outright -
    // distinguishing this from the ForceOnly arm's "never even asks" shape.
    expect(clientResolver).toHaveBeenCalledWith(null);
  });

  it("the LIVE local host id wins over a stale query-list entry, dispatching against the live host's client only", async () => {
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-live") },
    };
    // Dispatching there would ask one host to stand down while the force leg kills another.
    directoryListMock.current = { data: [localEntry("host-stale")] };
    const liveFixture = buildOverviewHostFixture({
      hostId: "host-live",
      isLocalMachine: true,
    });
    const staleFixture = buildOverviewHostFixture({
      hostId: "host-stale",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) => {
      if (hostId === "host-live") return liveFixture.client;
      if (hostId === "host-stale") return staleFixture.client;
      return null;
    };
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(liveFixture.restartCalls()).toBe(1);
    });
    expect(staleFixture.restartCalls()).toBe(0);
    expect(requestHostRespawn).not.toHaveBeenCalled();
  });
});

describe("<LocalHostRestartFlow /> - a local host identity change under an open force offer", () => {
  it("a host identity change while the offer is open dismisses it and returns to the confirm step", async () => {
    const queryClient = makeQueryClient();
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    directoryListMock.current = { data: [localEntry("host-a")] };
    let restartCallCount = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": () => {
          restartCallCount += 1;
          return Promise.resolve({
            outcome: "busy" as const,
            verdict: {
              busySessionCount: 1,
              blockers: null,
              busyBreakdown: null,
            },
          });
        },
      },
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    // A fresh element tree (not a reused reference) on every call.
    function buildHarness(): ReactNode {
      return (
        <QueryClientProvider client={queryClient}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <RestartFlowHarness />
          </RunnerHostProvider>
        </QueryClientProvider>
      );
    }
    const result = render(buildHarness());

    await openAndConfirm();
    await screen.findByTestId("host-busy-force-defer-dialog");
    expect(restartCallCount).toBe(1);

    // The machine's local host identity changed while the offer sat open -
    // both resolution sources now describe host-b.
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-b") },
    };
    directoryListMock.current = { data: [localEntry("host-b")] };
    result.rerender(buildHarness());

    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    expect(
      await screen.findByTestId("confirm-destructive-dialog"),
    ).not.toBeNull();
    expect(requestHostRespawn).not.toHaveBeenCalled();
  });

  it("a Force click after the live host changed under an open offer refuses and explains, instead of killing the new host", async () => {
    const mutableBinding: {
      directory: { getLocalEntry: () => HostDirectoryEntry | null };
    } = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    hostBindingMock.current = mutableBinding;
    directoryListMock.current = { data: [localEntry("host-a")] };
    let restartCallCount = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": () => {
          restartCallCount += 1;
          return Promise.resolve({
            outcome: "busy" as const,
            verdict: {
              busySessionCount: 1,
              blockers: null,
              busyBreakdown: null,
            },
          });
        },
      },
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();
    await screen.findByTestId("host-busy-force-defer-dialog");
    expect(restartCallCount).toBe(1);

    // Mutate the same binding object the component already captured, without re-rendering.
    mutableBinding.directory.getLocalEntry = () => localEntry("host-b");

    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        "Host changed",
        expect.objectContaining({
          description:
            "This machine's host was replaced while this dialog was open, so nothing was stopped. Restart again to check the new host.",
        }),
      );
    });
    expect(requestHostRespawn).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
  });
});

describe("<LocalHostRestartFlow /> - confirm re-reads the live local host (Finding 1)", () => {
  it("a host identity change between render and confirm refuses instead of dispatching", async () => {
    // A mutable (non-readonly) local binding object - not the shared `PRESENT_BINDING`.
    const mutableBinding: {
      directory: { getLocalEntry: () => HostDirectoryEntry | null };
    } = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    hostBindingMock.current = mutableBinding;
    directoryListMock.current = { data: [localEntry("host-a")] };
    // No `overrideHandlers` here, deliberately: the fixture's own default `host.restart` handler is what
    // `restartCalls` below tracks.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    // Open the confirm dialog but do NOT confirm yet - `openAndConfirm()`
    // clicks confirm immediately, which is not what this test needs.
    fireEvent.click(screen.getByRole("button", { name: "Open restart" }));
    await screen.findByTestId("confirm-destructive-dialog");

    // Mutate the same binding object the component already captured, without re-rendering, so `getLocalEntry` now
    // answers host-b.
    mutableBinding.directory.getLocalEntry = () => localEntry("host-b");

    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        "Host changed",
        expect.objectContaining({ description: HOST_CHANGED_DESCRIPTION }),
      );
    });
    expect(fixture.restartCalls()).toBe(0);
    expect(requestHostRespawn).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
  });
});

describe("<LocalHostRestartFlow /> - a dialable host with no client is offered force explicitly (Finding 2)", () => {
  it("a dialable local host with no client offers force explicitly instead of killing it", async () => {
    hostBindingMock.current = {
      directory: { getLocalEntry: () => localEntry("host-a") },
    };
    directoryListMock.current = { data: [localEntry("host-a")] };
    // `localEntry` already builds a dialable entry - verify that, since it
    // is exactly what makes this case "offer-force" rather than "force".
    const entry = localEntry("host-a");
    expect(entry.websocketUrl).not.toBeNull();
    expect(entry.transportDialability).toBe("dialable");
    // Simulates a renderer with no authenticated request context (signed out, or a credential lease being
    // released): the host resolves and looks reachable, but no client could be built for it.
    clientForHostIdMock.current = () => null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    expect(requestHostRespawn).not.toHaveBeenCalled();
    const offerDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    expect(offerDialog.textContent).toContain(UNREACHABLE_CLIENT_MESSAGE);

    fireEvent.click(screen.getByTestId("host-busy-force"));

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
  });

  it("a local host that is not dialable still force-restarts in one click", async () => {
    hostBindingMock.current = {
      directory: { getLocalEntry: () => nonDialableLocalEntry("host-a") },
    };
    directoryListMock.current = { data: [nonDialableLocalEntry("host-a")] };
    // Same "no client could be built" resolver as the dialable case above - the only difference is dialability,
    // which is what must decide between an explicit force offer and the one-click down-host recovery path.
    clientForHostIdMock.current = () => null;
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
    // Pins that the down-host recovery path stays a single click: the busy/
    // force-offer dialog must never have appeared along the way.
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
  });
});
