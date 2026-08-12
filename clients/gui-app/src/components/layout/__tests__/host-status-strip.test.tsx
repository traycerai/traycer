import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { HostStatusStrip } from "@/components/layout/host-status-strip";
import { deriveHostStatusStripState } from "@/components/layout/host-status-strip-state";
import {
  hostStatusProbeQueryKey,
  HostCompatibilityContext,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const SETTLED_TRANSPORT_FAILURE = new HostTransportFailureError({
  code: "RPC_ERROR",
  message: "still dialing",
  requestId: "req-1",
  method: "host.status",
  fatalDetails: null,
});

const bindingRef = vi.hoisted(() => ({
  value: null as {
    readonly hostClient: HostClient<HostRpcRegistry>;
  } | null,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => bindingRef.value,
}));

const BASE_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "local",
  localBootIntent: true,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openHostPicker: () => undefined,
  openSettings: () => undefined,
  anyHostDialable: false,
  requestRespawn: () => undefined,
  respawnPending: false,
  compatibility: {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function buildHostClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

function controllerFor(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
  };
}

function renderStrip(args: {
  readonly compatibility: HostCompatibility | null;
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}): void {
  bindingRef.value =
    args.hostClient === null ? null : { hostClient: args.hostClient };
  render(
    <QueryClientProvider client={buildQueryClient()}>
      <HostCompatibilityContext.Provider value={args.compatibility}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(args.readiness, args.presentation)}
        >
          <HostStatusStrip />
        </HostReadinessControllerContext.Provider>
      </HostCompatibilityContext.Provider>
    </QueryClientProvider>,
  );
}

function queryStrip(): HTMLElement | null {
  return screen.queryByTestId("host-status-strip");
}

afterEach(() => {
  cleanup();
  bindingRef.value = null;
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
  });
});

describe("deriveHostStatusStripState", () => {
  // Pure unit table for D3 precedence: switching > error > degraded, plus
  // the anti-flash rule that a still-checking compat stays amber.
  const compatibleLive = {
    status: "compatible" as const,
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
    degraded: false,
    unreachable: false,
    hostStatus: null,
  };
  const compatibleDegraded = { ...compatibleLive, degraded: true };
  const failed = {
    ...compatibleLive,
    status: "failed" as const,
    unreachable: true,
    errorMessage: "dial failed",
  };
  const incompatible = {
    ...compatibleLive,
    status: "incompatible" as const,
    errorMessage: "version mismatch",
  };
  const checking = {
    ...compatibleLive,
    status: "checking" as const,
  };

  it("orders switching over error and degraded, and treats checking as switching", () => {
    expect(
      deriveHostStatusStripState({
        switching: true,
        readinessKind: "ready",
        compatibility: failed,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: true,
        readinessKind: "incompatible-host",
        compatibility: incompatible,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        readinessKind: "ready",
        compatibility: checking,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        readinessKind: "loading-host",
        compatibility: compatibleLive,
      }),
    ).toBe("switching");
    expect(
      deriveHostStatusStripState({
        switching: false,
        readinessKind: "compatibility-error",
        compatibility: failed,
      }),
    ).toBe("error");
    expect(
      deriveHostStatusStripState({
        switching: false,
        readinessKind: "ready",
        compatibility: incompatible,
      }),
    ).toBe("error");
    expect(
      deriveHostStatusStripState({
        switching: false,
        readinessKind: "ready",
        compatibility: compatibleDegraded,
      }),
    ).toBe("degraded");
    expect(
      deriveHostStatusStripState({
        switching: false,
        readinessKind: "ready",
        compatibility: compatibleLive,
      }),
    ).toBe("hidden");
  });
});

describe("<HostStatusStrip />", () => {
  it("says the connection is degraded while a compatible verdict is held", () => {
    // Absorbs HostConnectionDegradedBanner: same amber strip + working Retry.
    const retry = vi.fn();
    renderStrip({
      compatibility: {
        status: "compatible",
        degraded: true,
        retry,
        hostStatus: {
          busy: false,
          busySessionCount: 0,
          hostVersion: "1.0.0",
        },
      },
      readiness: { kind: "ready" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "compatible",
          degraded: true,
          retry,
        },
      },
      hostClient: null,
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("degraded");
    fireEvent.click(screen.getByTestId("host-status-strip-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way on a live connection", () => {
    renderStrip({
      compatibility: {
        status: "compatible",
        degraded: false,
        retry: () => undefined,
        hostStatus: {
          busy: false,
          busySessionCount: 0,
          hostVersion: "1.0.0",
        },
      },
      readiness: { kind: "ready" },
      presentation: BASE_PRESENTATION,
      hostClient: null,
    });

    expect(queryStrip()).toBeNull();
  });

  it("renders nothing outside the compatibility provider", () => {
    // The context decides whether the strip exists at all - null is how
    // test harnesses and the gui-app dev preview mount surfaces without one.
    renderStrip({
      compatibility: null,
      readiness: { kind: "ready" },
      presentation: {
        ...BASE_PRESENTATION,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "compatible",
          degraded: true,
        },
      },
      hostClient: null,
    });
    expect(queryStrip()).toBeNull();
  });

  /**
   * Mounts the strip under a live client + query client so the composite
   * switch signal can be driven end to end: bind, then settle (or unbind)
   * the new host's probe slot the way the real probe would.
   */
  function mountSwitchSurface(args: {
    readonly compatibility: HostCompatibility;
    readonly presentation: DefaultHostReadinessPresentation;
  }): {
    readonly hostClient: HostClient<HostRpcRegistry>;
    readonly queryClient: QueryClient;
  } {
    const hostClient = buildHostClient();
    hostClient.bind(mockLocalHostEntry);
    bindingRef.value = { hostClient };
    const queryClient = buildQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <HostCompatibilityContext.Provider value={args.compatibility}>
          <HostReadinessControllerContext.Provider
            value={controllerFor({ kind: "ready" }, args.presentation)}
          >
            <HostStatusStrip />
          </HostReadinessControllerContext.Provider>
        </HostCompatibilityContext.Provider>
      </QueryClientProvider>,
    );
    return { hostClient, queryClient };
  }

  it("clears switching once the new host's probe settles with data", () => {
    // The switch is held until the host we moved TO has answered - and then
    // it must actually let go. A latch that never clears would leave the app
    // saying "Switching to…" for the rest of the session.
    const live: HostCompatibility = {
      status: "compatible",
      degraded: false,
      retry: () => undefined,
      hostStatus: { busy: false, busySessionCount: 0, hostVersion: "1.0.0" },
    };
    const { hostClient, queryClient } = mountSwitchSurface({
      compatibility: live,
      presentation: BASE_PRESENTATION,
    });

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });
    expect(queryStrip()?.dataset.state).toBe("switching");

    act(() => {
      queryClient.setQueryData(
        hostStatusProbeQueryKey(mockRemoteHostEntry.hostId),
        { ready: true, busy: false, busySessionCount: 0, hostVersion: "1.0.0" },
      );
    });
    expect(queryStrip()).toBeNull();
  });

  it("lets a settled failure paint red once the switch has cleared", () => {
    // The other half of the anti-flash rule. Suppressing the red variant
    // during a switch is only safe if it is NOT suppressed afterwards -
    // otherwise a host that genuinely failed to answer would go unreported.
    const failedCompat: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: false,
      error: SETTLED_TRANSPORT_FAILURE,
      unreachable: true,
    };
    const presentation: DefaultHostReadinessPresentation = {
      ...BASE_PRESENTATION,
      compatibility: {
        ...BASE_PRESENTATION.compatibility,
        status: "failed",
        unreachable: true,
        errorMessage: "host did not answer",
      },
    };
    const { hostClient, queryClient } = mountSwitchSurface({
      compatibility: failedCompat,
      presentation,
    });

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });
    expect(queryStrip()?.dataset.state).toBe("switching");

    // A settled failure for the NEW host: no data, error state, and the error
    // is not pending-class - exactly what `hasSettledHostStatusProbe` treats
    // as an answer.
    act(() => {
      queryClient.setQueryData(
        hostStatusProbeQueryKey(mockRemoteHostEntry.hostId),
        () => undefined,
      );
      const cache = queryClient.getQueryCache();
      const query = cache.build(queryClient, {
        queryKey: hostStatusProbeQueryKey(mockRemoteHostEntry.hostId),
      });
      query.setState({
        status: "error",
        error: SETTLED_TRANSPORT_FAILURE,
        fetchStatus: "idle",
      });
    });
    expect(queryStrip()?.dataset.state).toBe("error");
  });

  it("drops the switch when the host it was switching to is unbound", () => {
    // A host removed mid-switch (its directory row disappears, or the user
    // clears the selection) used to leave "Switching to B…" latched forever,
    // and `switching` precedence then suppressed every settled error behind
    // it. Unbinding ENDS the switch.
    const failedCompat: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: false,
      error: SETTLED_TRANSPORT_FAILURE,
      unreachable: true,
    };
    const presentation: DefaultHostReadinessPresentation = {
      ...BASE_PRESENTATION,
      compatibility: {
        ...BASE_PRESENTATION.compatibility,
        status: "failed",
        unreachable: true,
        errorMessage: "host did not answer",
      },
    };
    const { hostClient } = mountSwitchSurface({
      compatibility: failedCompat,
      presentation,
    });

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });
    expect(queryStrip()?.dataset.state).toBe("switching");

    act(() => {
      hostClient.bind(null);
    });
    // The suppressed error is now visible instead of a permanent amber lie.
    expect(queryStrip()?.dataset.state).toBe("error");
  });

  it("does not paint the red error variant while a host switch is in flight", () => {
    // Anti-flash rule: switching > error. A still-settling probe (or a
    // readiness kind that maps to error) must not blink red under an active
    // host-bound switch - that amber → red → hidden blink is what every
    // remote switch used to show.
    const hostClient = buildHostClient();
    hostClient.bind(mockLocalHostEntry);
    bindingRef.value = { hostClient };

    const presentation: DefaultHostReadinessPresentation = {
      ...BASE_PRESENTATION,
      compatibility: {
        ...BASE_PRESENTATION.compatibility,
        status: "failed",
        unreachable: true,
        errorMessage: "still dialing",
      },
    };
    const failedCompat: HostCompatibility = {
      status: "failed",
      retry: () => undefined,
      retrying: false,
      error: SETTLED_TRANSPORT_FAILURE,
      unreachable: true,
    };

    const queryClient = buildQueryClient();
    // Mount first so useHostSwitchTarget's onChange subscription is armed,
    // then bind the remote host - the composite switch signal is the only
    // thing that can fire switching for a remote target (readiness stays
    // ready).
    render(
      <QueryClientProvider client={queryClient}>
        <HostCompatibilityContext.Provider value={failedCompat}>
          <HostReadinessControllerContext.Provider
            value={controllerFor({ kind: "ready" }, presentation)}
          >
            <HostStatusStrip />
          </HostReadinessControllerContext.Provider>
        </HostCompatibilityContext.Provider>
      </QueryClientProvider>,
    );

    // Without a live switch the strip is already red (failed compat, ready
    // readiness). After host-bound it must go amber.
    expect(queryStrip()?.dataset.state).toBe("error");

    act(() => {
      hostClient.bind(mockRemoteHostEntry);
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("switching");
  });

  // The amber strip covers two unrelated situations, and Retry has to mean the
  // right one in each. A stalled/dead LOCAL host needs its process back; the
  // full-screen cards this strip replaced put `requestRespawn` behind Retry for
  // exactly these three readiness kinds. Re-running the compat probe against a
  // process that is not there answers the same nothing every click.
  for (const kind of [
    "loading-host",
    "provisioning-host",
    "unavailable-host",
  ] as const) {
    it(`respawns the local host instead of re-probing on '${kind}'`, () => {
      const retry = vi.fn();
      const requestRespawn = vi.fn();
      renderStrip({
        compatibility: {
          status: "checking",
          retry,
        },
        readiness: { kind },
        presentation: {
          ...BASE_PRESENTATION,
          targetKind: "local",
          requestRespawn,
          compatibility: {
            ...BASE_PRESENTATION.compatibility,
            status: "checking",
            retry,
          },
        },
        hostClient: null,
      });

      expect(queryStrip()?.dataset.state).toBe("switching");
      fireEvent.click(screen.getByTestId("host-status-strip-retry"));
      expect(requestRespawn).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    });
  }

  it("disables Retry while a respawn it issued is still pending", () => {
    const requestRespawn = vi.fn();
    renderStrip({
      compatibility: { status: "checking", retry: () => undefined },
      readiness: { kind: "unavailable-host" },
      presentation: {
        ...BASE_PRESENTATION,
        targetKind: "local",
        requestRespawn,
        respawnPending: true,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "checking",
        },
      },
      hostClient: null,
    });

    const button = screen.getByTestId("host-status-strip-retry");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(requestRespawn).not.toHaveBeenCalled();
  });

  // The counter-pin: a CONNECTION wait must keep the probe retry. For a remote
  // target readiness is already `ready`, so respawning the local host would be
  // both useless and wrong.
  it("keeps the compatibility retry while the probe is still dialing", () => {
    const retry = vi.fn();
    const requestRespawn = vi.fn();
    renderStrip({
      compatibility: { status: "checking", retry },
      readiness: { kind: "compatibility-checking" },
      presentation: {
        ...BASE_PRESENTATION,
        requestRespawn,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "checking",
          retry,
        },
      },
      hostClient: null,
    });

    expect(queryStrip()?.dataset.state).toBe("switching");
    fireEvent.click(screen.getByTestId("host-status-strip-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(requestRespawn).not.toHaveBeenCalled();
  });

  // The counter-pin the local fix needed: `unavailable-host` is ALSO what a
  // selected REMOTE host reports once it loses its dialable endpoint. Respawning
  // then restarts the host on THIS computer and leaves the host the user is
  // actually pointed at untouched.
  it("does not respawn the local host when the unavailable target is remote", () => {
    const retry = vi.fn();
    const requestRespawn = vi.fn();
    renderStrip({
      compatibility: { status: "checking", retry },
      readiness: { kind: "unavailable-host" },
      presentation: {
        ...BASE_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
        requestRespawn,
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "checking",
          retry,
        },
      },
      hostClient: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(requestRespawn).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("files the same report-issue context as the full-screen card on the error variant", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const retry = vi.fn();
    renderStrip({
      compatibility: {
        status: "failed",
        retry,
        retrying: false,
        error: SETTLED_TRANSPORT_FAILURE,
        unreachable: true,
      },
      readiness: { kind: "compatibility-error" },
      presentation: {
        ...BASE_PRESENTATION,
        localHostState: "ready",
        compatibility: {
          ...BASE_PRESENTATION.compatibility,
          status: "failed",
          errorMessage: "fetch failed",
          unreachable: true,
          retry,
        },
      },
      hostClient: null,
    });

    const strip = queryStrip();
    expect(strip).not.toBeNull();
    expect(strip?.dataset.state).toBe("error");
    expect(screen.getByTestId("host-status-strip-retry")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Report issue/i }));
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
    // Same title/code/source as the full-screen compatibility-error card
    // (host-readiness-controller.test.tsx unreachable-host report pin).
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Traycer Host is not responding",
      message:
        "The app could not reach Traycer Host. Host health: host ready, compat unreachable.",
      code: "HOST_UNREACHABLE",
      source: "Host connection",
    });
  });
});
