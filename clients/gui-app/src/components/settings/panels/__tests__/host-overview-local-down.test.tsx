// `LocalHostDownActions` is the header cluster `HostOverviewPanel` renders
// for THIS machine's own host when it is unreachable and the shell has a CLI
// bridge. There is no Start verb (decision 2026-08-19): the local host's
// lifecycle is automatic and target-independent, so all that remains is a
// "Run doctor" button (disabled while this machine's lifecycle lane is busy)
// and, only after the user has removed Traycer, a "Reinstall Traycer" escape
// hatch that clears the removal sentinel and converges.

// Same boundary as the sibling Overview suites: mock `useHostScope` and
// `@/lib/host`'s `useHostBinding` rather than standing up a host runtime.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  ConvergeReadyOk,
  IHostManagement,
  IRunnerHost,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { buildOverviewManagement } from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

/**
 * Renders `HostSettingsPanel` scoped to THIS machine's own host, affirmatively
 * down: `status: "unreachable"`, a local-machine host fixture with no live
 * client, and a CLI bridge (`hostManagement`) so `LocalHostDownActions` is the
 * header cluster that mounts. `localHost: null` on the mock runner host mirrors
 * the down process — no live snapshot to answer with.
 */
function renderLocalDown(options: {
  readonly settingUp: boolean;
  readonly management: IHostManagement;
  readonly name: string;
}): void {
  const hostId = "host-local-down";
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      name: options.name,
      isLocalMachine: true,
      connectable: false,
      settingUp: options.settingUp,
    }),
    hostId,
    status: "unreachable",
    client: null,
  };
  hostBindingMock.current = null;

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    // No live snapshot — this machine's host is down, which is the whole
    // scenario under test.
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: options.management,
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("Overview — this machine's own host, down (LocalHostDownActions)", () => {
  it("a down local host offers Run doctor and no Start verb", async () => {
    const management = buildOverviewManagement({
      getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    });
    renderLocalDown({ settingUp: false, management, name: "This Mac" });

    const doctorButton = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Run doctor",
    });
    expect(doctorButton.disabled).toBe(false);
    expect(screen.queryByTestId("host-overview-start-local")).toBeNull();
    expect(screen.queryByTestId("host-overview-reinstall-local")).toBeNull();
    // No Start verb anywhere on the page — not merely absent under its old
    // test id.
    expect(screen.queryByText("Start host")).toBeNull();
  });

  it("Run doctor is locked while this machine's lifecycle lane is busy", async () => {
    const management = buildOverviewManagement({
      getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    });
    renderLocalDown({ settingUp: true, management, name: "This Mac" });

    const doctorButton = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Run doctor",
    });
    expect(doctorButton.disabled).toBe(true);
  });

  it("a removed host gets Reinstall Traycer, which clears the sentinel and converges", async () => {
    // Captures the ORDER the two bridge calls actually land in, not merely
    // that both happened — `reinstall()` chains `convergeReady` off
    // `clearRemoval`'s resolution, and that is the behaviour worth pinning.
    const callOrder: string[] = [];
    const clearRemoval = vi.fn((): Promise<void> =>
      Promise.resolve().then(() => {
        callOrder.push("clearRemoval");
      }),
    );
    const convergeReady = vi.fn(
      (force: boolean): Promise<MutationOutcome<ConvergeReadyOk>> => {
        void force;
        callOrder.push("convergeReady");
        return Promise.resolve({
          kind: "ok",
          value: { running: true, version: "1.5.0" },
        });
      },
    );
    const management = buildOverviewManagement({
      getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: true })),
      clearRemoval,
      convergeReady,
    });
    renderLocalDown({ settingUp: false, management, name: "This Mac" });

    // The removal read is async (the sentinel query starts disabled-shaped
    // and resolves after mount), so the button only appears once it settles.
    const reinstallButton = await screen.findByRole("button", {
      name: "Reinstall Traycer",
    });
    fireEvent.click(reinstallButton);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        "Reinstalling Traycer on This Mac…",
      );
    });

    expect(clearRemoval).toHaveBeenCalledTimes(1);
    expect(convergeReady).toHaveBeenCalledWith(false);
    expect(callOrder).toEqual(["clearRemoval", "convergeReady"]);
  });

  it("a NOT-removed down host gets no Reinstall", async () => {
    const getRemovalState = vi.fn(() =>
      Promise.resolve({ removedByUser: false }),
    );
    const management = buildOverviewManagement({ getRemovalState });
    renderLocalDown({ settingUp: false, management, name: "This Mac" });

    await screen.findByRole("button", { name: "Run doctor" });
    // Let the removal-state query actually settle before trusting the
    // absence below — otherwise a still-pending query would pass this
    // assertion for the wrong reason.
    await waitFor(() => {
      expect(getRemovalState).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-reinstall-local")).toBeNull();
    });
  });

  it("a reinstall whose converge fails keeps the verb, because the sentinel is already cleared", async () => {
    // `useRunnerReinstallTraycer` clears the removal sentinel FIRST and only
    // THEN converges (`use-runner-reinstall-traycer-mutation.ts`). A converge
    // that RESOLVES non-ok is turned into a REJECTION by the mutation itself
    // (`throw new Error(outcome.message)`), but the sentinel clear already
    // landed - and `onSettled` refetches the removal-state query regardless
    // of the mutation's outcome. Before the fix, `removalRepairable` gated on
    // `removed` alone, so that refetch (now `removedByUser: false`) dropped
    // the only affordance a machine with no host had left. The cluster now
    // also renders on `reinstall.isError`, so the verb survives its own
    // failure.
    //
    // The fixture models the real persisted sentinel across that refetch: the
    // FIRST `getRemovalState` read (the down state that shows the button in
    // the first place) says `removedByUser: true`; every read after
    // (`clearRemoval` having actually run) says `false`.
    // No initial implementation: what call 1 vs. call 2+ answer is owned
    // entirely by the two lines below, not by a constructor default that
    // would be shadowed by them anyway.
    const getRemovalState =
      vi.fn<() => Promise<{ readonly removedByUser: boolean }>>();
    getRemovalState.mockResolvedValueOnce({ removedByUser: true });
    getRemovalState.mockResolvedValue({ removedByUser: false });
    const clearRemoval = vi.fn((): Promise<void> => Promise.resolve());
    const convergeReady = vi.fn(
      (force: boolean): Promise<MutationOutcome<ConvergeReadyOk>> => {
        void force;
        return Promise.resolve({
          kind: "failed",
          message: "installer could not write to the prefix",
        });
      },
    );
    const management = buildOverviewManagement({
      getRemovalState,
      clearRemoval,
      convergeReady,
    });
    renderLocalDown({ settingUp: false, management, name: "This Mac" });

    const reinstallButton = await screen.findByRole("button", {
      name: "Reinstall Traycer",
    });
    fireEvent.click(reinstallButton);

    // Premise: the converge really ran and really came back non-ok - which is
    // what turns the mutation into a rejection and raises the error toast
    // below, rather than the success path the earlier test in this file
    // pins.
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't reinstall Traycer on This Mac.",
        expect.objectContaining({
          description: "installer could not write to the prefix",
        }),
      );
    });

    // The refetch actually happened - not merely that the button never left,
    // which would pass just as happily against a query that stayed disabled
    // and never re-read the sentinel at all.
    await waitFor(() => {
      expect(getRemovalState.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    await waitFor(() => {
      const stillThere = screen.getByRole<HTMLButtonElement>("button", {
        name: "Reinstall Traycer",
      });
      expect(stillThere.disabled).toBe(false);
    });
  });

  it("a second reinstall attempt keeps the button mounted while it is in flight", async () => {
    // `removalRepairable` used to read `removed || reinstall.isError` alone.
    // The FIRST attempt never exposes the missing `isPending` term: `removed`
    // stays true until the removal-state refetch lands, so the button
    // survives on that alone regardless of `isError`. It takes a SECOND click
    // to expose the hole - by then the refetch has landed (`removed: false`),
    // and starting a new attempt resets `reinstall.isError` back to false the
    // instant it goes pending. With `isPending` missing from the disjunction,
    // every term is false and the whole cluster - the Button, its testid, its
    // own inline spinner - unmounts for the length of the retry. The fix
    // (`host-overview-panel.tsx`'s `removalRepairable`) adds
    // `reinstall.isPending` back into the disjunction; without it, the
    // `getByRole` lookup below the second click finds no button at all.
    const getRemovalState =
      vi.fn<() => Promise<{ readonly removedByUser: boolean }>>();
    getRemovalState.mockResolvedValueOnce({ removedByUser: true });
    getRemovalState.mockResolvedValue({ removedByUser: false });
    const clearRemoval = vi.fn((): Promise<void> => Promise.resolve());

    // The SECOND convergeReady call is parked on this gate so the test can
    // assert the retry is provably still in flight before letting it finish -
    // the same manually-released-promise idiom
    // `host-overview-mutations.test.tsx` uses for its arm-time-capture suite.
    // The first call resolves immediately to a failure, exactly like the
    // sibling test above.
    let releaseSecondConverge: (() => void) | null = null;
    const secondConvergeGate = new Promise<void>((resolve) => {
      releaseSecondConverge = resolve;
    });
    let convergeCalls = 0;
    const convergeReady = vi.fn(
      async (force: boolean): Promise<MutationOutcome<ConvergeReadyOk>> => {
        void force;
        convergeCalls += 1;
        if (convergeCalls === 1) {
          return {
            kind: "failed",
            message: "installer could not write to the prefix",
          };
        }
        await secondConvergeGate;
        return { kind: "ok", value: { running: true, version: "1.5.0" } };
      },
    );
    const management = buildOverviewManagement({
      getRemovalState,
      clearRemoval,
      convergeReady,
    });
    renderLocalDown({ settingUp: false, management, name: "This Mac" });

    const reinstallButton = await screen.findByRole("button", {
      name: "Reinstall Traycer",
    });
    fireEvent.click(reinstallButton);

    // Let the first attempt fully settle, including its refetch - `removed`
    // really is false now, not merely "hasn't answered yet".
    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(getRemovalState.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't reinstall Traycer on This Mac.",
        expect.objectContaining({
          description: "installer could not write to the prefix",
        }),
      );
    });

    const retryButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Reinstall Traycer",
    });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(2);
    });
    // The retry is provably still in flight - parked on the gate above, not
    // merely fast enough to have already finished - and the button must
    // still be in the DOM, disabled by `busy` (which includes
    // `reinstall.isPending`).
    await waitFor(() => {
      const stillMounted = screen.getByRole<HTMLButtonElement>("button", {
        name: "Reinstall Traycer",
      });
      expect(stillMounted.disabled).toBe(true);
    });

    // Let the retry finish so no unhandled rejection is left dangling past
    // the end of the test.
    await act(async () => {
      releaseSecondConverge?.();
      await secondConvergeGate;
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        "Reinstalling Traycer on This Mac…",
      );
    });
  });
});
