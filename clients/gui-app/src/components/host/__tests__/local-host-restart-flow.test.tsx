// Same boundary as `host-overview-mutations.test.tsx`: mock `@/lib/host`'s
// `useHostBinding` narrowly, spreading the real module so `hostRpcRegistry`
// (which `buildOverviewHostFixture` needs) and every other real export stay
// intact. Two more hooks are mocked equally narrowly, at their OWN leaf
// modules rather than through a wider barrel: `useHostDirectoryList` (which
// host id, if any, resolves as "the local machine") and
// `useHostClientForHostId` (which `HostClient`, if any, that id resolves
// to). Both already have their own dedicated resolution-algorithm suites
// (`use-host-client-for-host-id.test.ts`, `host-directory-service.test.ts`);
// this file is about `LocalHostRestartFlow`'s branching given their answers,
// not about re-proving how those answers are derived. There is no capability
// gate left to mock: the component no longer consults the negotiated-manifest
// registry at all, so whether a host supports `host.restart` is settled only
// by actually dialing it. `useHostRestart` stays REAL, dispatching against a
// real `HostClient` built by `buildOverviewHostFixture` (same fixture
// host-overview-mutations.test.tsx uses) - so the cooperative dispatch in
// these tests is a genuine RPC over an in-memory messenger, not a mocked
// call.
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
  return `${subject} still working on this host. Nothing was interrupted; try again when they finish. Force restart ends them immediately.`;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * Both the menu and tray listeners hold `requested`/`onClose` state
 * themselves and hand it to `LocalHostRestartFlow` as controlled props; this
 * harness is that same shape, with a button standing in for "the surface
 * asked to restart" so a test can invoke, dismiss, and re-invoke without
 * unmounting the flow (which is exactly what a real re-open sequence does -
 * `armedRestartIdRef` lives inside the flow instance and must survive it).
 */
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
    // The ForceOnly arm must never even ASK "which host does this id
    // resolve to" - a regression that started resolving one anyway would be
    // invisible to a mere "respawn was called" assertion.
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
    // No `overrideHandlers` here, deliberately: the fixture's OWN default
    // `host.restart` handler already answers `accepted` and is what feeds
    // `restartCalls()` / `restartTransitionIds()` below - an override would
    // replace that handler wholesale and silently untrack every call.
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
              verdict: { busySessionCount },
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
            verdict: { busySessionCount: 1 },
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

    // Force, unlike a mere deferral, is a definitive end to the action the
    // armed id names - the process it identified is gone - so
    // `useForceHostRespawn`'s `onRestarted` callback nulls
    // `armedRestartIdRef`. Contrast with "an RPC rejection offers force ...
    // carries the SAME transitionId" above, which defers instead and keeps
    // the id armed.
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
    // `declined` performed nothing - the host was removed, or another
    // process holds the management lock - so it must NOT be treated as the
    // definitive end that a real respawn is in the test above.
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
    // No capability gate is consulted anymore, so there is nothing left to
    // record on the negotiated-manifest registry to steer this test: the
    // cooperative RPC is dialed unconditionally, and a host too old to have
    // `host.restart` proves that by rejecting the dial itself rather than by
    // a cached manifest saying so up front.
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
    // The query is deliberately stale here - it still serves a DIFFERENT
    // `kind: "local"` entry, the shape `useHostDirectoryList` can be in right
    // after a local host identity change, since it retains previous data
    // across a refetch. Dispatching there would ask one host to stand down
    // while the force leg kills another.
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
