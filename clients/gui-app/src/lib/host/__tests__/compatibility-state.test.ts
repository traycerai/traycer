import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  HostCompatibilityProvider,
  hostRpcRegistry,
  HostRuntimeProvider,
  useHostCompatibility,
  type HostCompatibility,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The argument `TransportEvidenceRelay.reportCompatVerdict` takes, named here
 * so the spy below carries a concrete type. Spelling it out rather than
 * reaching for `ReturnType<typeof vi.spyOn>` is what keeps `.mock.calls`
 * typed - the unparameterized form degrades to `any` and every read off it
 * becomes an unsafe access.
 */
interface CompatVerdictReport {
  readonly hostId: string;
  readonly probedOnSessionId: string | null;
  readonly hostVersion: string | null;
  readonly incompatibility: SelectionIncompatibility | null;
}

type CompatReportSpy = MockInstance<(input: CompatVerdictReport) => void>;

/**
 * P5.2 T9-T11: the compat probe now binds the session id it resolved on into
 * the verdict it reports to the selection authority (`compatAnchorAtSuccess` /
 * `compatAnchorAtFailure` in `compatibility-state.ts`).
 *
 * A minimal render harness rather than `mountStartupConsumers` from
 * `host-compatibility-provider.test.tsx` (read-only for this suite): these
 * tests need no epic tabs, no `epic.getTaskContexts` / `agent.gui.listHarnesses`
 * consumers, and no reconciler - only `host.status` and the compatibility
 * provider itself. Written without JSX (this file is `.test.ts`, and the
 * vitest config's esbuild loader for `.ts` does not parse JSX).
 */

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;

/**
 * `AuthService.start()` fetches `/api/v3/user` to rehydrate the signed-in
 * user before the runtime finishes startup - without this stub `fetch` is
 * unmocked in jsdom and startup never resolves, so every test hangs on the
 * `fallback` node forever. Mirrors `installAuthFetch` in
 * `host-compatibility-provider.test.tsx` (read-only for this suite).
 */
function installAuthFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/v3/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user: {
                id: "test-user",
                name: "Test User",
                providerId: "gh-1",
                providerHandle: "test-user",
                providerType: "GITHUB",
                email: "test@example.com",
                avatarUrl: null,
                activatedAt: null,
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                lastSeenAt: null,
                privacyMode: false,
                isLearningEnabled: true,
              },
              userSubscription: {
                id: "sub-1",
                userID: "test-user",
                orgID: null,
                teamID: null,
                customerId: "cus-1",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                subscriptionExpiry: null,
                trialEndsAt: null,
                subscriptionStatus: "FREE",
                hasPaymentMethod: false,
                isInTrial: false,
                rechargeRateSeconds: 0,
              },
              teamSubscriptions: [],
              payAsYouGoUsage: { allowPayAsYouGo: false },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(
        new Error(`unexpected fetch in compatibility-state test: ${url}`),
      );
    },
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

let restoreFetch: () => void = () => undefined;

/**
 * Each test gets its OWN host id. `compatAnchorAtSuccess` /
 * `compatAnchorAtFailure` in `compatibility-state.ts` and
 * `transportEvidenceRelay`'s session maps are module singletons that
 * `queryClient.clear()` / `cleanup()` never reset - a shared host id would
 * let one test read a slot another test wrote.
 */
function buildLocalSnapshot(hostId: string): LocalHostSnapshot {
  return {
    hostId,
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "1.2.3",
    pid: 4242,
    systemHostName: "hardiks-macbook",
    displayName: "hardiks-macbook",
    availability: "available",
  };
}

const compatibleHostStatus: HostStatusResponse = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => {
    throw new Error("deferred resolver was not initialized");
  };
  let rejectDeferred: (error: unknown) => void = () => {
    throw new Error("deferred rejecter was not initialized");
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function buildMessengerFactory(
  hostStatus: () => Promise<HostStatusResponse> | HostStatusResponse,
): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
      handlers: {
        "host.status": () => hostStatus(),
      },
    });
}

interface Mount {
  readonly queryClient: QueryClient;
  readonly reportSpy: CompatReportSpy;
}

function mount(
  hostId: string,
  hostStatus: () => Promise<HostStatusResponse> | HostStatusResponse,
): Mount {
  const localSnapshot = buildLocalSnapshot(hostId);
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: localSnapshot,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  void host.tokenStore.signIn(
    { token: "test-token", refreshToken: "test-refresh-token" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  useAuthStore.getState().setSignedIn(
    {
      userId: "test-user",
      userName: "Test User",
      email: "test@example.com",
    },
    { userId: "test-user", username: "Test User" },
    [],
  );

  const queryClient = buildQueryClient();
  const reportSpy = vi.spyOn(transportEvidenceRelay, "reportCompatVerdict");

  // `children` is passed INSIDE props rather than as `createElement`'s third
  // argument: `RunnerHostProviderProps` declares it required, and the variadic
  // children overload does not satisfy a required `children` prop.
  render(
    React.createElement(RunnerHostProvider, {
      runnerHost: host,
      children: React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(HostRuntimeProvider, {
          registry: hostRpcRegistry,
          messengerFactory: buildMessengerFactory(hostStatus),
          invalidator: null,
          requestId: null,
          remoteFetcher: () =>
            Promise.resolve({ kind: "hosts" as const, entries: [] }),
          fallback: React.createElement(
            "div",
            { "data-testid": "runtime-fallback" },
            "runtime loading",
          ),
          // Same required-`children` reason as `RunnerHostProvider` above.
          children: React.createElement(
            HostCompatibilityProvider,
            null,
            React.createElement(CompatibilityStatusProbe, null),
          ),
        }),
      ),
    }),
  );

  return { queryClient, reportSpy };
}

function CompatibilityStatusProbe(): React.ReactNode {
  const compatibility = useHostCompatibility();
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "div",
      { role: "status", "aria-label": "Host compatibility status" },
      compatibility.status,
    ),
    React.createElement(
      "div",
      { role: "status", "aria-label": "Host compatibility detail" },
      compatibilityDetail(compatibility),
    ),
  );
}

function compatibilityDetail(compatibility: HostCompatibility): string {
  if (compatibility.status === "compatible") {
    return compatibility.degraded ? "degraded" : "live";
  }
  if (compatibility.status === "failed") {
    return compatibility.unreachable ? "unreachable" : "rejected";
  }
  if (compatibility.status === "incompatible") {
    return "incompatible";
  }
  return "n/a";
}

function getCompatibilityStatusText(): string | null {
  return screen.getByRole("status", { name: "Host compatibility status" })
    .textContent;
}

function getCompatibilityDetailText(): string | null {
  return screen.getByRole("status", { name: "Host compatibility detail" })
    .textContent;
}

/** The most recent `reportCompatVerdict` call for `hostId`, or undefined. */
function lastReportFor(
  spy: CompatReportSpy,
  hostId: string,
): CompatVerdictReport | undefined {
  const calls = spy.mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const [input] = calls[index];
    if (input.hostId === hostId) return input;
  }
  return undefined;
}

function terminalIncompatibleError(): HostRpcError {
  return new HostRpcError({
    code: "INCOMPATIBLE",
    message: "host RPC protocol is incompatible",
    requestId: "req-incompat",
    method: "host.status",
    fatalDetails: null,
  });
}

describe("compatibility-state - compat verdict session anchoring (P5.2)", () => {
  beforeEach(() => {
    restoreFetch = installAuthFetch();
    useAuthStore.getState().setSignedOut();
  });

  afterEach(() => {
    cleanup();
    restoreFetch();
    useAuthStore.getState().setSignedOut();
    useSelectionAuthorityStore.getState().reset();
  });

  it("T9/P5: a fresh successful probe reports a verdict anchored to the session live at resolution", async () => {
    const hostId = "desktop-t9";
    transportEvidenceRelay.sessionEstablished(hostId, "s-t9", "local-ws");

    const { reportSpy, queryClient } = mount(
      hostId,
      () => compatibleHostStatus,
    );

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });

    const report = lastReportFor(reportSpy, hostId);
    expect(report?.probedOnSessionId).toBe("s-t9");
    expect(report?.probedOnSessionId).not.toBeNull();

    queryClient.clear();
  });

  it("T10/P4: the held discriminator - a compat report must stay bound to the session it was produced on, never the CURRENT one", async () => {
    const hostId = "desktop-t10";
    transportEvidenceRelay.sessionEstablished(hostId, "s-A", "local-ws");

    let probes = 0;
    const reprobe = createDeferred<HostStatusResponse>();
    const hostStatus = (): Promise<HostStatusResponse> | HostStatusResponse => {
      probes += 1;
      return probes === 1 ? compatibleHostStatus : reprobe.promise;
    };

    const { reportSpy, queryClient } = mount(hostId, hostStatus);

    await waitFor(() => {
      expect(getCompatibilityStatusText()).toBe("compatible");
    });
    expect(lastReportFor(reportSpy, hostId)?.probedOnSessionId).toBe("s-A");

    // The connection cycles underneath: A tears down, B comes up.
    act(() => {
      transportEvidenceRelay.sessionLost(hostId, "s-A", "local-ws");
      transportEvidenceRelay.sessionEstablished(hostId, "s-B", "local-ws");
    });

    // A refetch starts and FAILS - the verdict is served HELD: `probe.data`
    // survives from the original success, `degraded` becomes true.
    //
    // NOT awaited: `invalidateQueries()` awaits the refetch it triggers, and
    // that refetch resolves on `reprobe.promise` - which this test does not
    // reject until below. Awaiting it here would deadlock the test on its own
    // unsettled promise. Fire it, wait for the refetch to actually start
    // (`probes > 1`), then reject.
    act(() => {
      void queryClient.invalidateQueries();
    });
    await waitFor(() => {
      expect(probes).toBeGreaterThan(1);
    });
    await act(async () => {
      reprobe.reject(new Error("host did not answer the dial"));
      // Awaited so the rejection is flushed inside this `act`, which is what
      // lets the held-verdict render settle before the assertions below.
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getCompatibilityDetailText()).toBe("degraded");
    });
    expect(getCompatibilityStatusText()).toBe("compatible");

    // THE DISCRIMINATOR: every report for this host still names A. A
    // report-time lookup implementation would emit a "B" report on the failed
    // refetch above, which is exactly the bug this anchor exists to prevent.
    // The retry predicate runs on every failure and `hostStatus` keeps
    // returning the same already-rejected promise on retries, so this checks
    // ALL reports for the host, not just the last one.
    const reportsForHost = reportSpy.mock.calls
      .map(([input]) => input)
      .filter((input) => input.hostId === hostId);
    expect(reportsForHost.length).toBeGreaterThan(0);
    for (const report of reportsForHost) {
      expect(report.probedOnSessionId).not.toBe("s-B");
      expect(report.probedOnSessionId).toBe("s-A");
    }

    queryClient.clear();
  });

  it("T11/P7: a terminal incompatible failure reports incompatible anchored to the session live at rejection", async () => {
    const hostId = "desktop-t11";
    transportEvidenceRelay.sessionEstablished(hostId, "s-t11", "local-ws");

    const { reportSpy, queryClient } = mount(hostId, () => {
      throw terminalIncompatibleError();
    });

    // NOT asserted via the rendered status text: the real selection bridge is
    // mounted here, so the incompatible verdict moves `effectiveHostId` off
    // this host (D13/C4) and the probe's own status falls back to `checking`
    // with nothing bound - see `authorityIncompatibleCode` in
    // `host-compatibility-provider.test.tsx` for the same reasoning. The
    // report to the authority is the thing under test, so wait on it directly.
    await waitFor(() => {
      expect(lastReportFor(reportSpy, hostId)).toBeDefined();
    });

    const report = lastReportFor(reportSpy, hostId);
    expect(report?.probedOnSessionId).toBe("s-t11");
    expect(report?.probedOnSessionId).not.toBeNull();

    queryClient.clear();
  });
});
