// The Overview re-provides a scoped stream binding beside its unary one (for the Data & migration group), and
// the real hook reads `useAuthService` - which this suite deliberately does not stand up.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

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

import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostStatusUpdateOperation } from "@traycer/protocol/host/status/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  buildOverviewHostFixture,
  openHostOverviewMenu,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

/** G1 - the selected-Overview lifecycle-gate matrix. */

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

function renderPanel(): void {
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
}

// Same as `renderPanel`, but keeps the `QueryClient` reachable across a `rerender` so a later mutation of
// `scopeOverrides.current` (an unusable scope, say) is observed against the same cache.
function renderPanelPersistent(): { rerender: () => void } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const runnerHost = makeRunnerHost();
  // A fresh element on every call, not a captured/reused one.
  const buildTree = (): ReactNode => (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(buildTree());
  return { rerender: () => rerender(buildTree()) };
}

function attemptOperation(
  overrides: Partial<Extract<HostStatusUpdateOperation, { kind: "attempt" }>>,
): HostStatusUpdateOperation {
  return {
    kind: "attempt",
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.1.0",
    trigger: "manual",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    liveness: "active",
    livenessCause: null,
    busySessionCount: null,
    busyBreakdown: null,
    error: null,
    ...overrides,
  };
}

function statusWith(
  operation: HostStatusUpdateOperation | null,
  extra: Partial<ResponseOfMethod<HostRpcRegistry, "host.status">> | undefined,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: "1.5.0",
    protocolVersion: { major: 1, minor: operation === null ? 2 : 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction:
      operation === null
        ? null
        : { recordSchemaVersion: 2, authority: "attempt" },
    ...extra,
  };
}

async function editNameDisabled(): Promise<boolean> {
  return (await screen.findByTestId("host-overview-edit-name")).hasAttribute(
    "disabled",
  );
}

async function restartMenuAriaDisabled(): Promise<string | null> {
  await openHostOverviewMenu();
  return screen
    .getByTestId("host-overview-restart")
    .getAttribute("aria-disabled");
}

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  vi.useRealTimers();
});

describe("HostOverviewPanel — lifecycle gate matrix (G1)", () => {
  it("(a) an ACTIVE attempt (downloading, execution: active) HOLDS the gate — the rename control and Restart menu item are both disabled", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => statusWith(attemptOperation({}), undefined),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(async () => {
      expect(await editNameDisabled()).toBe(true);
    });
    expect(await restartMenuAriaDisabled()).toBe("true");
  });

  it.each([
    {
      name: "parked (waiting-to-activate)",
      operation: attemptOperation({
        phase: "waiting-to-activate",
        execution: "parked",
      }),
    },
    {
      name: "terminal (failed)",
      operation: attemptOperation({
        phase: "failed",
        execution: "terminal",
        liveness: "terminal",
      }),
    },
    {
      name: "terminal (complete)",
      operation: attemptOperation({
        phase: "complete",
        execution: "terminal",
        liveness: "terminal",
      }),
    },
    {
      name: "unknown (peer said nothing — updateOperation: null)",
      operation: null,
    },
  ])(
    "(b) $name does NOT hold the gate — the rename control stays enabled",
    async ({ operation }) => {
      const fixture = buildOverviewHostFixture({
        hostId: "host-a",
        isLocalMachine: true,
        overrideHandlers: {
          "host.status": () => statusWith(operation, undefined),
        },
      });
      recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
      hostBindingMock.current = { hostClient: fixture.client };
      scopeOverrides.current = scopeFrom("host-a", fixture);
      renderPanel();

      // Let the initial read settle before asserting the negative - otherwise a false "not disabled" could just mean
      // the query has not resolved yet.
      await screen.findByTestId("host-overview-edit-name");
      await waitFor(async () => {
        expect(await editNameDisabled()).toBe(false);
      });
    },
  );

  it("(d) a pre-@1.3 peer (updateOperation: null) with the COARSE updateProgress.state === 'updating' still HOLDS the gate — byte-identical to the released behaviour", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWith(null, {
            updateProgress: { state: "updating", error: null },
          }),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await waitFor(async () => {
      expect(await editNameDisabled()).toBe(true);
    });
  });

  it("(c) THE DEFECT ITSELF — a retained active status whose READ THEN GOES UNHEALTHY must release the gate, and an already-open restart confirmation must STAY open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCalls = 0;
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () => {
          statusCalls += 1;
          if (statusCalls === 1) {
            return statusWith(
              attemptOperation({ phase: "downloading" }),
              undefined,
            );
          }
          throw new Error("host unreachable");
        },
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    // The first, healthy read: active, gate holds. Restart is refused, so it cannot yet be opened - proving the
    // eventual open below is caused by the read going unhealthy, not by some other path.
    await waitFor(async () => {
      expect(await editNameDisabled()).toBe(true);
    });
    expect(await restartMenuAriaDisabled()).toBe("true");
    // Close the menu before advancing time - leaving a Radix dropdown open across an unrelated state change is not
    // part of what this test proves.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-restart")).toBeNull();
    });

    // `host.status` polls every 10s (`host-method-policy-table.ts`).
    await vi.advanceTimersByTimeAsync(11_000);

    // The fix: the read is now unhealthy (isError), so `observationFromCanonicalRead` stamps an already-expired
    // deadline and `projectFleetUpdateView` demotes to `unknown`.
    await waitFor(async () => {
      expect(await editNameDisabled()).toBe(false);
    });
    expect(await restartMenuAriaDisabled()).not.toBe("true");

    // Open the restart confirmation now that the gate has released, and prove it stays open - the render-time
    // close at `anyPending && !ownDispatch` must not re-fire once the gate is genuinely released.
    fireEvent.click(screen.getByTestId("host-overview-restart"));
    await screen.findByTestId("confirm-destructive-dialog");

    // Advance more polling ticks (all of which keep failing) to prove this is a stable release, not a one-tick
    // flicker that the next failed poll would re-lock and re-close.
    await vi.advanceTimersByTimeAsync(11_000);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();
  });

  it("(c2) THE DEFECT ITSELF, unusable-scope leg — a retained active status whose SCOPE turns unusable must demote the SAME way an unhealthy read does", async () => {
    // null: (<HostOverviewOperationCard.../>)`) - gated only on the retained data existing at all, never on the
    // scope's usability.
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWith(attemptOperation({ phase: "downloading" }), undefined),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    const panel = renderPanelPersistent();

    // Healthy and usable: gate holds, exactly like (a)/(c), and the card reads the live sentence - no "Last seen:"
    // prefix.
    await waitFor(async () => {
      expect(await editNameDisabled()).toBe(true);
    });
    expect(await restartMenuAriaDisabled()).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-restart")).toBeNull();
    });
    expect(
      (await screen.findByTestId("host-overview-operation-phase")).textContent,
    ).toBe("Downloading update to v2.1.0");

    // Only the scope stops being usable, the way a negotiated `@1.3` peer going unreachable would leave it:
    // `client` unchanged so the query key is unchanged and the retained data survives.
    scopeOverrides.current = {
      ...scopeFrom("host-a", fixture),
      status: "unreachable",
    };
    panel.rerender();

    // The fix: the retained attempt demotes to "last known" the moment the scope stops being usable, exactly as it
    // does when the read itself turns unhealthy in (c) - same predicate, different input.
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-phase").textContent,
      ).toBe("Last seen: Downloading update to v2.1.0");
    });

    // And the orthogonal rule holds too: an unusable scope withdraws the
    // controls rather than merely disabling them.
    expect(screen.queryByTestId("host-overview-edit-name")).toBeNull();
    expect(screen.queryByTestId("host-overview-menu")).toBeNull();
  });
});
