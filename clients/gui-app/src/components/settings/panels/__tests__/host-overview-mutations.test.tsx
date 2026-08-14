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
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  buildOverviewHostFixture,
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
