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

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

// G5: `HostOverviewOperationCard` renders measured byte progress
// (`host-overview-operation-bytes`) independently of percentage — the
// counterpart to the landing banner's own bytes coverage, since both surfaces
// share `operationProgressBytes`/`showsProgressBar`.

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
  operation: HostStatusUpdateOperation,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: "1.5.0",
    protocolVersion: { major: 1, minor: 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
  };
}

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  vi.useRealTimers();
});

describe("HostOverviewOperationCard — measured byte progress (G5)", () => {
  it("bytes-only (percent absent) renders host-overview-operation-bytes and keeps the bar indeterminate", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWith(
            attemptOperation({
              progress: {
                percent: null,
                bytes: 80_000_000,
                totalBytes: 200_000_000,
              },
            }),
          ),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    const bytesEl = await screen.findByTestId("host-overview-operation-bytes");
    expect(bytesEl.textContent).not.toBe("");
    await screen.findByTestId("update-progress-indeterminate");
  });

  it("percent + bytes both present render together", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: "host-a",
      isLocalMachine: true,
      overrideHandlers: {
        "host.status": () =>
          statusWith(
            attemptOperation({
              progress: {
                percent: 40,
                bytes: 80_000_000,
                totalBytes: 200_000_000,
              },
            }),
          ),
      },
    });
    recordNegotiatedHostMethods("host-a", ALL_OVERVIEW_METHODS);
    hostBindingMock.current = { hostClient: fixture.client };
    scopeOverrides.current = scopeFrom("host-a", fixture);
    renderPanel();

    await screen.findByTestId("host-overview-operation-card");
    const bytesEl = await screen.findByTestId("host-overview-operation-bytes");
    expect(bytesEl.textContent).not.toBe("");
    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-operation-card").textContent,
      ).toContain("40%");
    });
    await screen.findByTestId("update-progress-determinate");
  });

  it("a RETAINED (stale) attempt shows no bar at all once the read goes unhealthy, even though it still carries measured bytes", async () => {
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
              attemptOperation({
                progress: {
                  percent: null,
                  bytes: 80_000_000,
                  totalBytes: 200_000_000,
                },
              }),
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

    // The live baseline: the bar IS present while the read is healthy, so the
    // retained case below is a genuine transition rather than a card that
    // never draws a bar at all.
    await screen.findByTestId("update-progress-indeterminate");

    // Advance past the 10s `host.status` poll so the same query refetches and
    // fails, retaining the last (active) response.
    await vi.advanceTimersByTimeAsync(11_000);

    await waitFor(() => {
      expect(screen.queryByTestId("update-progress-indeterminate")).toBeNull();
      expect(screen.queryByTestId("update-progress-determinate")).toBeNull();
    });
    // The measured bytes are a claim about the past ("Last seen: …") and stay
    // on screen; only the animated bar withdraws.
    const bytesEl = screen.getByTestId("host-overview-operation-bytes");
    expect(bytesEl.textContent).not.toBe("");
    vi.useRealTimers();
  });
});
