// Same boundary as the parity/recovery-console suites: mock `useHostScope`
// and `@/lib/host`'s `useHostBinding`.
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
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  openHostOverviewAdvanced,
  openHostOverviewMenu,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

const ALL_OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

function scopeFrom(
  hostId: string,
  fixture: OverviewHostFixture,
): Record<string, unknown> {
  return {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
}

function makeRunnerHost(): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

/**
 * Same in-memory shell as `makeRunnerHost`, but with a CLI bridge attached —
 * `MockRunnerHost` otherwise defaults `hostManagement` to `null`, which is
 * exactly "no bridge" and cannot exercise the Force-restart offer at all.
 */
function makeRunnerHostWithManagement(
  management: IHostManagement | null,
): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: management,
  });
}

/**
 * Same shape as `scopeFrom`, but with `isLocalMachine` a caller-supplied axis
 * rather than pinned `true` — the Force-restart offer forks on exactly that
 * flag (bridge respawns THIS machine's process only), so these tests need
 * both a local and a remote host from the same fixture.
 */
function scopeFromWithLocality(
  hostId: string,
  fixture: OverviewHostFixture,
  isLocalMachine: boolean,
): Record<string, unknown> {
  return {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine,
      connectable: true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
}

async function waitForButton(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole("button", { name });
}

describe("<HostSettingsPanel /> Overview arm-time capture", () => {
  it("host.restart: a scope move mid-flight does not redirect the request or its retry to the new host", async () => {
    let releaseRestart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    // `overrideHandlers` REPLACES the tracked default handler wholesale, so
    // this attempt is counted locally rather than through the fixture's own
    // `restartCalls()` (which would stay 0 forever under an override).
    let armedHostCalls = 0;
    const armedHostTransitionIds: string[] = [];
    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": async (req) => {
          await gate;
          armedHostCalls += 1;
          armedHostTransitionIds.push(req.transitionId);
          return { outcome: "accepted" as const };
        },
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFrom("host-a", fixtureA);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = makeRunnerHost();
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    await waitFor(() => {
      expect(armedHostCalls).toBe(0); // still parked on the gate
    });

    // Move the scope to another host WHILE the restart is still in flight.
    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    await act(async () => {
      releaseRestart?.();
      await gate;
    });

    await waitFor(() => {
      expect(armedHostCalls).toBe(1);
    });
    expect(fixtureB.restartCalls()).toBe(0);
    expect(armedHostTransitionIds[0].length).toBeGreaterThan(0);
  });

  it("host.identity.set: the post-success invalidation targets the ARMED host, not the one the page moved to", async () => {
    let releaseSet: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Original Name",
      overrideHandlers: {
        "host.identity.set": async (req) => {
          await gate;
          return {
            systemName: "host-a",
            customName: req.customName,
            effectiveName: req.customName ?? "host-a",
          };
        },
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFrom("host-a", fixtureA);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const runnerHost = makeRunnerHost();
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    // Wait for `host.identity.get` to resolve — "Edit name" stays disabled
    // (`busy={identity === null}`) until then, so a click before this would
    // be a no-op.
    await screen.findByText("Original Name");
    fireEvent.click(await waitForButton("Edit name"));
    // The name edits IN PLACE now (`useInlineRename`, same hook the tab strips
    // use), so there is no separate editor row and no Save button — the write
    // is what Enter commits.
    const input = await screen.findByTestId("host-overview-name-input");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFrom("host-b", fixtureB);
    view.rerender(makeUi());

    await act(async () => {
      releaseSet?.();
      await gate;
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled();
    });
    const targetedKeys = invalidateSpy.mock.calls.map(
      (call) =>
        (call[0] as { readonly queryKey?: readonly unknown[] }).queryKey,
    );
    const expectedKey = hostQueryKeys.methodScope(
      "host-a",
      "host.identity.get",
    );
    const wrongKey = hostQueryKeys.methodScope("host-b", "host.identity.get");
    expect(
      targetedKeys.some(
        (key) =>
          key !== undefined &&
          JSON.stringify(key) === JSON.stringify(expectedKey),
      ),
    ).toBe(true);
    expect(
      targetedKeys.every(
        (key) =>
          key === undefined || JSON.stringify(key) !== JSON.stringify(wrongKey),
      ),
    ).toBe(true);
  });
});

describe("<HostSettingsPanel /> Overview restart outcomes", () => {
  it("a busy restart renders the busy notice, not a success or an error toast", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 2 },
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    expect(
      await screen.findByTestId("host-overview-restart-busy"),
    ).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reuses the armed transitionId when the retry follows an AMBIGUOUS failure", async () => {
    // The complement of the busy case above, and the one the claim contract is
    // actually for: a transport failure says nothing about whether the host
    // granted the shutdown claim. Minting a fresh id for that retry means it
    // cannot adopt a claim the host may already hold - turning the idempotent
    // retry this design exists for into a busy refusal.
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
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await waitFor(() => expect(transitionIds).toHaveLength(1));

    // The user tries again after the failure toast.
    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await waitFor(() => expect(transitionIds).toHaveLength(2));

    expect(transitionIds[1]).toBe(transitionIds[0]);
  });

  it("sends a non-empty transitionId, and a retry from the busy notice sends a fresh one", async () => {
    // Tracked locally, same reason as the arm-time-capture suite:
    // `overrideHandlers` replaces the fixture's own tracked handler.
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
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await screen.findByTestId("host-overview-restart-busy");

    fireEvent.click(screen.getByTestId("host-overview-restart-busy-retry"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    await waitFor(() => {
      expect(transitionIds.length).toBe(2);
    });
    expect(transitionIds[0].length).toBeGreaterThan(0);
    expect(transitionIds[1].length).toBeGreaterThan(0);
    expect(transitionIds[0]).not.toBe(transitionIds[1]);
  });
});

describe("<HostSettingsPanel /> Overview restart outcomes — Force restart", () => {
  it("a busy restart on a REMOTE host offers no Force restart, even with a management bridge present", async () => {
    // The forking rule is `isLocalMachine`, not "is a bridge available" — a
    // remote host's process cannot be respawned by THIS machine's bridge, so
    // the offer must stay withheld even when `hostManagement` answers.
    const fixture = buildOverviewHostFixture({
      hostId: "host-remote",
      isLocalMachine: false,
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 2 },
          }),
      },
    });
    recordNegotiatedHostMethods("host-remote", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFromWithLocality(
      "host-remote",
      fixture,
      false,
    );
    const management = buildOverviewManagement({});
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider
          runnerHost={makeRunnerHostWithManagement(management)}
        >
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    expect(
      await screen.findByTestId("host-overview-restart-busy"),
    ).toBeTruthy();
    // CodeRabbit: absence pinned by ACCESSIBLE ROLE, not the testid — a
    // future markup change that drops the testid but leaves a real "Force
    // restart" button behind must still fail this.
    expect(screen.queryByRole("button", { name: "Force restart" })).toBeNull();
  });

  it("a busy restart on a LOCAL host with no CLI bridge offers no Force restart either", async () => {
    // The parity half of the case above: local alone is not enough. Pins that
    // the no-bridge fixture (`makeRunnerHost`, `hostManagement: null`) stays
    // equivalent for local and remote — neither offers Force.
    const fixture = buildOverviewHostFixture({
      hostId: "host-local",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 3 },
          }),
      },
    });
    recordNegotiatedHostMethods("host-local", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFromWithLocality("host-local", fixture, true);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHostWithManagement(null)}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    expect(
      await screen.findByTestId("host-overview-restart-busy"),
    ).toBeTruthy();
    // CodeRabbit: absence pinned by ACCESSIBLE ROLE, not the testid — a
    // future markup change that drops the testid but leaves a real "Force
    // restart" button behind must still fail this.
    expect(screen.queryByRole("button", { name: "Force restart" })).toBeNull();
  });

  it("a LOCAL host with a CLI bridge offers Force restart, and a successful force clears the busy notice", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-local",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 2 },
          }),
      },
    });
    recordNegotiatedHostMethods("host-local", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFromWithLocality("host-local", fixture, true);
    const restartHost = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const management = buildOverviewManagement({ restartHost });
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider
          runnerHost={makeRunnerHostWithManagement(management)}
        >
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await screen.findByTestId("host-overview-restart-busy");

    fireEvent.click(
      await screen.findByRole("button", { name: "Force restart" }),
    );

    await waitFor(() => {
      expect(restartHost).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-restart-busy")).toBeNull();
    });
    expect(toast.success).toHaveBeenCalledWith("Restarting host-local");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a declined force restart clears the busy notice and shows an informational toast, not an error", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-local",
      isLocalMachine: true,
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 4 },
          }),
      },
    });
    recordNegotiatedHostMethods("host-local", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFromWithLocality("host-local", fixture, true);
    const restartHost = vi.fn(() =>
      Promise.resolve({
        kind: "declined" as const,
        message: "Another Traycer process holds the management lock.",
      }),
    );
    const management = buildOverviewManagement({ restartHost });
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider
          runnerHost={makeRunnerHostWithManagement(management)}
        >
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await screen.findByTestId("host-overview-restart-busy");

    fireEvent.click(
      await screen.findByRole("button", { name: "Force restart" }),
    );

    await waitFor(() => {
      expect(restartHost).toHaveBeenCalledTimes(1);
    });
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
      expect(screen.queryByTestId("host-overview-restart-busy")).toBeNull();
    });
  });

  it("a scope move mid-flight toasts under the INITIATING host's name, not the one the page moved to", async () => {
    // Mirrors the `host.restart` arm-time-capture test above, for the
    // page-remount half of the force-restart scoping fix: `HostSettingsPanel`
    // keys `HostSettingsPanelInner` by `scopeId`, so a host swap unmounts the
    // whole subtree the armed `forceRestart` mutation lives in. Its `onSuccess`
    // closure — and the `variables.hostName` it toasts with — is frozen at the
    // OLD render, so this proves the toast survives that remount naming the
    // host that was actually being restarted, not whichever host the page
    // shows once it resolves.
    let releaseForceRestart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseForceRestart = resolve;
    });
    const restartHost = vi.fn(async () => {
      await gate;
      return { kind: "restarted" as const };
    });
    const management = buildOverviewManagement({ restartHost });
    const runnerHost = makeRunnerHostWithManagement(management);

    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Host A Display",
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 1 },
          }),
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      effectiveName: "Host B Display",
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFromWithLocality("host-a", fixtureA, true);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    // Wait for the identity read so the captured `hostName` is deterministic
    // rather than a transient scope-row fallback.
    await screen.findByText("Host A Display");

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await screen.findByTestId("host-overview-restart-busy");

    fireEvent.click(
      await screen.findByRole("button", { name: "Force restart" }),
    );
    await waitFor(() => {
      expect(restartHost).toHaveBeenCalledTimes(1);
    });

    // Move the scope to another host WHILE the force restart is still
    // killing and relaunching the local bridge process.
    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFromWithLocality("host-b", fixtureB, true);
    view.rerender(makeUi());
    await screen.findByText("Host B Display");

    await act(async () => {
      releaseForceRestart?.();
      await gate;
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Restarting Host A Display");
    });
    expect(toast.success).not.toHaveBeenCalledWith(
      expect.stringContaining("Host B Display"),
    );
    expect(restartHost).toHaveBeenCalledTimes(1);
  });

  it("Force restart armed on host A stays counted after a remount to host B, locking B's lifecycle writes until it settles", async () => {
    // The regression Codex proved: `forceRestart.isPending` is the LOCAL
    // `useMutation` observer's flag, and that observer dies with the
    // scope-keyed remount (`HostSettingsPanel` keys `HostSettingsPanelInner`
    // by `scopeId`). A swap away mid-flight used to mount a FRESH observer
    // that starts idle, so the page-wide gate read `false` and reopened every
    // lifecycle write it exists to hold shut — on host B's brand-new page,
    // not even the host the bridge respawn is running against.
    // `forceRestartInFlight` (`useIsMutating` against the shared
    // `runnerMutationKeys.hostRestart()` key) is CACHE-derived, so it must
    // stay `true` on host B's fresh mount for as long as the mutation the
    // stale host-A instance armed is still settling, and drop back to
    // `false` once it does.
    let releaseForceRestart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseForceRestart = resolve;
    });
    const restartHost = vi.fn(async () => {
      await gate;
      return { kind: "restarted" as const };
    });
    const management = buildOverviewManagement({ restartHost });
    const runnerHost = makeRunnerHostWithManagement(management);

    const fixtureA = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      effectiveName: "Host A Display",
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 1 },
          }),
      },
    });
    const fixtureB = buildOverviewHostFixture({
      hostId: "host-b",
      isLocalMachine: true,
      effectiveName: "Host B Display",
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    recordNegotiatedHostMethods("host-b", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixtureA.client };
    scopeOverrides.current = scopeFromWithLocality("host-a", fixtureA, true);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    await screen.findByText("Host A Display");
    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await screen.findByTestId("host-overview-restart-busy");

    fireEvent.click(
      await screen.findByRole("button", { name: "Force restart" }),
    );
    await waitFor(() => {
      expect(restartHost).toHaveBeenCalledTimes(1);
    });

    // Move the scope to host B WHILE the force restart is still killing and
    // relaunching the local bridge process.
    hostBindingMock.current = { hostClient: fixtureB.client };
    scopeOverrides.current = scopeFromWithLocality("host-b", fixtureB, true);
    view.rerender(makeUi());

    // Wait for host B's identity to load so the lock asserted below is
    // attributable to `locked` (the page-wide gate) rather than to
    // `!loaded`, which disables the pencil regardless of the gate.
    await screen.findByText("Host B Display");
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
      ).toBe(true);
    });

    await act(async () => {
      releaseForceRestart?.();
      await gate;
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-edit-name").hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("a pending PAGE-WIDE write (rename in flight) disables both busy-notice buttons; releasing it re-enables them", async () => {
    // Codex P1: the notice's own buttons only gated each OTHER
    // (`retryPending || forcePending`) - nothing gated them on the REST of
    // the page. Every other lifecycle write already refuses to dispatch
    // while a restart is in flight (`corePending` includes `restart.isPending`
    // and `forceRestartInFlight`), but the exclusion did not hold in the
    // other direction: Try again and Force restart stayed clickable while a
    // rename, an update install, or a service write was running - any of
    // which a forced bridge respawn would then race. `pageGatePending`
    // (`anyPending`, the page's fullest write gate) closes that gap.
    let releaseRename: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const fixture = buildOverviewHostFixture({
      hostId: "host-local",
      isLocalMachine: true,
      effectiveName: "Host Local Display",
      overrideHandlers: {
        "host.restart": () =>
          Promise.resolve({
            outcome: "busy" as const,
            verdict: { busySessionCount: 2 },
          }),
        "host.identity.set": async (req) => {
          await gate;
          return {
            systemName: "host-local",
            customName: req.customName,
            effectiveName: req.customName ?? "host-local",
          };
        },
      },
    });
    recordNegotiatedHostMethods("host-local", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFromWithLocality("host-local", fixture, true);
    const management = buildOverviewManagement({});
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider
          runnerHost={makeRunnerHostWithManagement(management)}
        >
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await screen.findByText("Host Local Display");
    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );
    await screen.findByTestId("host-overview-restart-busy");

    // Enabled BEFORE the unrelated write - so the lock below is caused by
    // the rename, not by a fixture that never let the buttons load.
    expect(
      screen
        .getByRole("button", { name: "Force restart" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Try again" })
        .hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
    const input = await screen.findByTestId("host-overview-name-input");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Force restart" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });
    expect(
      screen
        .getByRole("button", { name: "Try again" })
        .hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      releaseRename?.();
      await gate;
    });

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Force restart" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(
      screen
        .getByRole("button", { name: "Try again" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("<HostSettingsPanel /> Overview update-install degrade", () => {
  it("an externally-managed install outcome retires the whole update region", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      hostVersion: "1.5.0",
      overrideHandlers: {
        "host.update.check": () =>
          Promise.resolve({
            outcome: "ok" as const,
            manifest: updateCheckManifest("1.6.0"),
          }),
        "host.update.install": () =>
          Promise.resolve({ outcome: "externally-managed" as const }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await waitForButton("Check now"));
    await openHostOverviewAdvanced();
    fireEvent.click(await waitForButton(/^Install \d/));

    // The whole REGION retires, not just the install button. This test used to
    // assert a disabled install button beside a live "Check now", which is the
    // shape a review called out: `externally-managed` means the cloud pin
    // governs updates for this host, so leaving a check control behind keeps
    // offering the one action the host has just said leads nowhere.
    expect(
      await screen.findByTestId("host-overview-updates-degraded"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-update-check")).toBeNull();
    });
    expect(screen.queryByTestId("host-overview-version-picker")).toBeNull();
  });
});

describe("<HostSettingsPanel /> Overview OS service externally-managed outcome", () => {
  // The OUTCOME axis, distinct from `ok` + `state: "externally-managed"`: the
  // host refused to consult the CLI because an external supervisor owns its
  // service lifecycle, so there is no label or manifest line to show and both
  // verbs are withheld rather than offered-and-refused.
  it("withholds both service verbs and names the external supervisor", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.service.status": () =>
          Promise.resolve({ outcome: "externally-managed" as const }),
      },
    });
    // The service methods too: a host that has not negotiated them has no
    // service section at all, which would make every absence below vacuous.
    recordNegotiatedHostMethods("host-a", [
      ...ALL_OVERVIEW_METHODS,
      "host.service.status",
      "host.service.register",
      "host.service.deregister",
    ]);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewAdvanced();
    const description = await screen.findByTestId(
      "host-overview-service-description",
    );
    await waitFor(() => {
      expect(description.textContent).toContain(
        "managed by an external supervisor",
      );
    });
    expect(screen.queryByRole("button", { name: "Re-register" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deregister" })).toBeNull();
    expect(screen.queryByTestId("host-overview-service-manifest")).toBeNull();
  });
});

describe("<HostSettingsPanel /> Overview doctor structured failure", () => {
  it("cli-unavailable renders the structured Doctor message, not an error toast", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.doctor": () =>
          Promise.resolve({ status: "cli-unavailable" as const }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
    const message = await screen.findByTestId("host-doctor-message");
    expect(message.textContent).toContain("no Traycer CLI installed");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("<HostSettingsPanel /> Overview per-button capability degrade", () => {
  it("degrades ONLY host.restart when the manifest omits it, and does NOT degrade on a null tri-state", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    // Handshaked WITHOUT host.restart, but WITH host.doctor and everything else.
    recordNegotiatedHostMethods(
      "host-a",
      ALL_OVERVIEW_METHODS.filter((m) => m !== "host.restart"),
    );
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    const restart = await screen.findByTestId("host-overview-restart");
    await waitFor(() => {
      expect(restart.getAttribute("data-degraded")).toBe("unsupported");
    });
    // `aria-disabled`, not the `disabled` ATTRIBUTE. These are Radix
    // `DropdownMenuItem`s — divs with `role="menuitem"` — so `hasAttribute
    // ("disabled")` is false for every one of them, enabled or not, and the
    // assertion it replaces could never have failed.
    expect(restart.getAttribute("aria-disabled")).toBe("true");

    const doctor = screen.getByTestId("host-overview-run-doctor");
    expect(doctor.getAttribute("data-degraded")).toBeNull();
    expect(doctor.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("does NOT degrade any button when NO manifest has been recorded yet (null tri-state)", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
    });
    // No `recordNegotiatedHostMethods` call at all for this host id: "not
    // dialled yet", the tri-state's null — must never read as "absent".
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
          })
        }
      >
        <RunnerHostProvider runnerHost={makeRunnerHost()}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await openHostOverviewMenu();
    const restart = await screen.findByTestId("host-overview-restart");
    const doctor = screen.getByTestId("host-overview-run-doctor");
    expect(restart.getAttribute("data-degraded")).toBeNull();
    expect(restart.getAttribute("aria-disabled")).not.toBe("true");
    expect(doctor.getAttribute("data-degraded")).toBeNull();
    expect(doctor.getAttribute("aria-disabled")).not.toBe("true");
  });
});
