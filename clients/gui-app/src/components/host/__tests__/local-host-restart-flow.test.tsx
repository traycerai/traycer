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
// not about re-proving how those answers are derived. `useHostSupportsMethod`
// stays REAL, reading the real negotiated-manifest registry via
// `recordNegotiatedHostMethods` / `resetNegotiatedManifests`, and
// `useHostRestart` stays REAL, dispatching against a real `HostClient` built
// by `buildOverviewHostFixture` (same fixture host-overview-mutations.test.tsx
// uses) - so the cooperative dispatch in these tests is a genuine RPC over an
// in-memory messenger, not a mocked call.
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
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
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
  resetNegotiatedManifests();
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
    recordNegotiatedHostMethods("host-a", ["host.restart"]);
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
    recordNegotiatedHostMethods("host-a", ["host.restart"]);
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
      recordNegotiatedHostMethods("host-a", ["host.restart"]);
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
    recordNegotiatedHostMethods("host-a", ["host.restart"]);
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
    recordNegotiatedHostMethods("host-a", ["host.restart"]);
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

  it("attempts the cooperative RPC when the local host's manifest is unknown (no handshake recorded yet), and never force-respawns", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    // No `overrideHandlers` here, deliberately, same reasoning as the
    // "dispatches the host.restart RPC" test above: the fixture's OWN default
    // `host.restart` handler is what `restartCalls()` tracks.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    // Deliberately NOT calling `recordNegotiatedHostMethods` for "host-a" -
    // this is the tri-state's `null` case: no handshake with this host has
    // completed yet, so `useHostMethodSupport` cannot say either way. This is
    // the P1 regression guard: the OLD code forced the fallback on this exact
    // state (unknown treated as absent, silently killing a live session); the
    // fix attempts the cooperative RPC here exactly like the known-`true`
    // case, and only degrades to the force offer if the host itself answers
    // that it cannot (see the next test).
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(fixture.restartCalls()).toBe(1);
    });
    expect(requestHostRespawn).not.toHaveBeenCalled();
  });

  it("an unknown manifest whose cooperative RPC is rejected degrades to an explicit force choice, not a silent kill", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
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
    // Same unknown tri-state as the test above (no `recordNegotiatedHostMethods`
    // call for "host-a"), but this time the host itself proves it cannot
    // answer the cooperative RPC - simulating a host too old to have
    // `host.restart`, or simply unreachable. The dial itself IS the
    // negotiation the unknown state was waiting on: it must land on the
    // force-offer dialog, exactly like the known-`false` case, rather than
    // dead-ending in an error toast the user cannot act on.
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

  it("falls back to requestHostRespawn directly when the local host's manifest does not advertise host.restart", async () => {
    hostBindingMock.current = PRESENT_BINDING;
    directoryListMock.current = { data: [localEntry("host-a")] };
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    clientForHostIdMock.current = (hostId) =>
      hostId === "host-a" ? fixture.client : null;
    // Handshaked, but WITHOUT host.restart - the "old host" shape (known
    // `false`, fails closed to force). Deliberately NOT the "never dialled"
    // shape (unknown `null`, no manifest recorded yet) - that state now
    // ATTEMPTS the cooperative RPC instead of forcing; see the two "unknown
    // manifest" tests above for that coverage.
    recordNegotiatedHostMethods("host-a", ["host.status", "host.doctor"]);
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runnerHost = createFakeRunnerHost({ requestHostRespawn });
    renderFlow(runnerHost);

    await openAndConfirm();

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
    expect(fixture.restartCalls()).toBe(0);
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
});
