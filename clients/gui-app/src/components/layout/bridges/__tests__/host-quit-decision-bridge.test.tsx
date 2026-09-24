// `HostQuitDecisionBridge` end to end, with a FAKE `hostLifecycle.quit`
// (capturing what it hands to `onQuitRequest`/`onQuitState`, and recording
// `respondToQuitRequest` calls) and a mocked `useLocalHostQuitStatus` so this
// file drives verdicts directly rather than re-deriving them through a real
// host client - that hook's own branching is covered by
// `use-local-host-quit-status.test.ts`. Everything else - `HostQuitDialog`,
// `describeHostQuitPrompt`, `automaticHostQuitDecision`,
// `useRunnerHostQuitRespondMutation` - stays real, so the assertions below
// exercise the genuine composition, not a second mock of it.
const localHostQuitStatusMock = vi.hoisted(
  (): { current: LocalHostQuitStatus } => ({
    current: {
      localHostId: "host-a",
      verdict: { kind: "checking" },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    },
  }),
);
vi.mock(
  "@/components/host/use-local-host-quit-status",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/host/use-local-host-quit-status")
      >();
    return {
      ...actual,
      useLocalHostQuitStatus: () => localHostQuitStatusMock.current,
    };
  },
);

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: {
    info: toastInfo,
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

// `HostQuitDialog` branches on `useHostBinding()` BEFORE it ever calls
// `useLocalHostQuitStatus` - an unbound renderer answers its own
// `UNBOUND_STATUS` rather than reading the (mocked) hook at all. Every test
// in this file exercises the BOUND path, so `useHostBinding` must resolve
// non-null; its actual shape is never read by anything below (the mocked
// status hook owns every fact this suite drives).
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => ({ directory: { getLocalEntry: () => null } }),
  };
});

// A "busy" verdict renders `<HostRestartSessions>` (the session list under
// the modal's Stop copy), which pulls in `useFocusModel` ->
// `useMergedNotificationRows` -> `resolveSubtreeHostClient(binding, ...)` off
// the SAME narrowly-mocked `@/lib/host` binding above, whose fixture carries
// no `hostClient`. Same boundary `local-host-restart-flow.test.tsx` draws for
// the identical reason: this suite is about the quit bridge's own branching,
// not the notifications/focus stack a sessions list also reaches into.
vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";
import type {
  HostQuitDecisionRequest,
  HostQuitDecisionResponse,
  HostQuitStateEvent,
  IHostQuitDecisionHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { LocalHostQuitStatus } from "@/components/host/use-local-host-quit-status";
import { HostQuitDecisionBridge } from "@/components/layout/bridges/host-quit-decision-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  HOST_QUIT_HOST_CHANGED_DESCRIPTION,
  HOST_QUIT_HOST_CHANGED_TITLE,
} from "@/lib/host/host-lifecycle-copy";

interface FakeQuit extends IHostQuitDecisionHost {
  readonly fireRequest: (request: HostQuitDecisionRequest) => void;
  readonly fireState: (event: HostQuitStateEvent) => void;
  readonly respondCalls: HostQuitDecisionResponse[];
  respondImpl: (response: HostQuitDecisionResponse) => Promise<void>;
}

function createFakeQuit(): FakeQuit {
  let requestHandler: ((request: HostQuitDecisionRequest) => void) | null =
    null;
  let stateHandler: ((event: HostQuitStateEvent) => void) | null = null;
  const respondCalls: HostQuitDecisionResponse[] = [];
  const fake: FakeQuit = {
    onQuitRequest: (handler): Disposable => {
      requestHandler = handler;
      return { dispose: () => undefined };
    },
    onQuitState: (handler): Disposable => {
      stateHandler = handler;
      return { dispose: () => undefined };
    },
    respondToQuitRequest: (response) => {
      respondCalls.push(response);
      return fake.respondImpl(response);
    },
    respondImpl: () => Promise.resolve(),
    fireRequest: (request) => requestHandler?.(request),
    fireState: (event) => stateHandler?.(event),
    respondCalls,
  };
  return fake;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderBridge(quit: FakeQuit): void {
  const runnerHost: IRunnerHost = createFakeRunnerHost({
    hostLifecycle: {
      get: () =>
        Promise.resolve({
          desired: { mode: "ask", rev: 1, updatedBy: null, updatedAt: null },
          applied: { localHostCapability: "managed", supervisor: "enforcing" },
          pending: "none",
        }),
      set: () => {
        throw new Error("not used by this suite");
      },
      onChange: () => ({ dispose: () => undefined }),
      quit,
    },
  });
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostQuitDecisionBridge />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function initialAskRequest(): HostQuitDecisionRequest {
  return { requestId: "req-1", mode: "ask", round: "initial" };
}

function busyRequest(): HostQuitDecisionRequest {
  return { requestId: "req-1", mode: "stop-if-idle", round: "busy" };
}

function busyRetryRequest(): HostQuitDecisionRequest {
  return { requestId: "req-1", mode: "ask", round: "busy-retry" };
}

afterEach(() => {
  cleanup();
  toastInfo.mockClear();
  localHostQuitStatusMock.current = {
    localHostId: "host-a",
    verdict: { kind: "checking" },
    liveLocalHostIdNow: () => "host-a",
    recheck: vi.fn(),
  };
  vi.restoreAllMocks();
});

describe("<HostQuitDecisionBridge /> - state table rendering", () => {
  it("renders nothing until a quit request arrives", () => {
    const quit = createFakeQuit();
    renderBridge(quit);
    expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
  });

  it("busy verdict on an initial ask round: title, description, stop label, data-quit-state", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 2,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);

    act(() => {
      quit.fireRequest(initialAskRequest());
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("busy");
    expect(screen.getByText("The host is still working")).not.toBeNull();
    expect(screen.getByTestId("host-quit-stop").textContent).toContain(
      "Stop host and quit",
    );
    expect(screen.getByTestId("host-quit-keep")).not.toBeNull();
  });

  it("idle verdict on an initial ask round renders the idle title and hides sessions", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "idle",
        busySessionCount: 0,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);

    act(() => {
      quit.fireRequest(initialAskRequest());
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("idle");
    expect(screen.getByText("Keep the host running?")).not.toBeNull();
  });

  it("unknown verdict renders the unknown title and the 'anyway' stop label", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: { kind: "unknown", reason: "unreachable" },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);

    act(() => {
      quit.fireRequest(initialAskRequest());
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("unknown");
    expect(
      screen.getByText("Can't tell what's running on the host"),
    ).not.toBeNull();
    expect(screen.getByTestId("host-quit-stop").textContent).toContain(
      "Stop host anyway and quit",
    );
  });

  it("checking verdict renders the checking title with Stop disabled", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: { kind: "checking" },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);

    act(() => {
      quit.fireRequest(initialAskRequest());
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("checking");
    expect(screen.getByText("Checking the host…")).not.toBeNull();
    expect(screen.getByTestId("host-quit-stop")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("busy-retry round always renders the busy title and a force stop, whatever the verdict", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "idle",
        busySessionCount: 0,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);

    act(() => {
      quit.fireRequest(busyRetryRequest());
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("busy-retry");
    expect(screen.getByText("The host is still working")).not.toBeNull();
    expect(
      screen.getByText(
        "Something started on the host while it was stopping, so it was left running. Keep it running, or stop it now and end this work.",
      ),
    ).not.toBeNull();
  });

  it("status 1.6 renders 'not reported by this host'; 1.5 renders 'unknown on this host version'", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    expect(screen.getByTestId("host-quit-counts").textContent).toContain(
      "not reported by this host",
    );

    cleanup();
    const quit15 = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 5,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit15);
    act(() => {
      quit15.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");
    expect(screen.getByTestId("host-quit-counts").textContent).toContain(
      "unknown on this host version",
    );
  });
});

describe("<HostQuitDecisionBridge /> - respond payloads", () => {
  function busyStatus(): LocalHostQuitStatus {
    return {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
  }
  function idleStatus(): LocalHostQuitStatus {
    return {
      localHostId: "host-a",
      verdict: {
        kind: "idle",
        busySessionCount: 0,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
  }
  function unknownStatus(): LocalHostQuitStatus {
    return {
      localHostId: "host-a",
      verdict: { kind: "unknown", reason: "unreachable" },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
  }

  it("Keep on a busy verdict sends kind=keep with the current remember flag", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = busyStatus();
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    act(() => {
      screen.getByTestId("host-quit-keep").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "keep",
      remember: true,
    });
  });

  it("Stop on a busy verdict sends force=true", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = busyStatus();
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "stop",
      force: true,
      remember: false,
    });
  });

  it("Stop on an idle verdict sends force=false", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "stop",
      force: false,
      remember: false,
    });
  });

  it("Stop on an unknown verdict sends force=true (force only after disclosure)", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = unknownStatus();
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "stop",
      force: true,
      remember: false,
    });
  });

  it("Stop on a busy-retry round always sends force=true", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    renderBridge(quit);
    act(() => {
      quit.fireRequest(busyRetryRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "stop",
      force: true,
      remember: false,
    });
  });

  it("Cancel sends kind=cancel", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = busyStatus();
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-cancel").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({ kind: "cancel" });
  });
});

describe("<HostQuitDecisionBridge /> - analytics", () => {
  it("host_quit_decision fires on a real respond, and host_lifecycle_mode_set fires additionally when remember was checked", async () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(trackSpy).toHaveBeenCalledWith(
        AnalyticsEvent.HostQuitDecision,
        expect.objectContaining({
          mode: "ask",
          verdict: "busy",
          choice: "stop",
          forced: true,
          remembered: true,
        }),
      );
    });
    expect(trackSpy).toHaveBeenCalledWith(
      AnalyticsEvent.HostLifecycleModeSet,
      expect.objectContaining({ mode: "linked", source: "quit-modal" }),
    );
  });

  it("no analytics fire for an automatic answer (stop-if-idle's idle first round)", async () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "idle",
        busySessionCount: 0,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    // Held open so the in-flight moment, between sending the answer and main
    // acknowledging it, can be observed.
    let acknowledge: () => void = () => undefined;
    quit.respondImpl = () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    renderBridge(quit);

    act(() => {
      quit.fireRequest({
        requestId: "req-auto",
        mode: "stop-if-idle",
        round: "initial",
      });
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "stop",
      force: false,
      remember: false,
    });
    // The choice prompt never opens for this round: stop-if-idle promises an
    // instant quit when idle, so nothing is asked.
    expect(screen.queryByTestId("host-quit-dialog")).toBeNull();

    await act(async () => {
      acknowledge();
      await Promise.resolve();
    });

    // A sent Stop shows the locked progress view - the same one main's own
    // unprompted stop shows - never the Keep/Stop choice.
    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("stopping");
    expect(trackSpy).not.toHaveBeenCalledWith(
      AnalyticsEvent.HostQuitDecision,
      expect.anything(),
    );
  });
});

describe("<HostQuitDecisionBridge /> - host-changed refusal", () => {
  it("Keep/Stop after the live host changed mid-dialog sends no respond, toasts 'Host changed', and triggers a recheck", async () => {
    const quit = createFakeQuit();
    const recheck = vi.fn();
    const status: LocalHostQuitStatus = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-b",
      recheck,
    };
    localHostQuitStatusMock.current = status;
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalledWith(
        HOST_QUIT_HOST_CHANGED_TITLE,
        expect.objectContaining({
          description: HOST_QUIT_HOST_CHANGED_DESCRIPTION,
        }),
      );
    });
    expect(quit.respondCalls).toHaveLength(0);
    expect(recheck).toHaveBeenCalledTimes(1);
  });
});

/** A breakdown naming one busy terminal, so `hostQuitStoppingLine` says "ending 1 terminal". */
const BUSY_ONE_TERMINAL_BREAKDOWN: HostBusyBreakdownV2 = {
  workingAgents: 0,
  activeTerminalAgents: 0,
  busyTerminals: 1,
  shells: null,
  scheduledWakes: null,
};

describe("<HostQuitDecisionBridge /> - phase transitions", () => {
  it("a stopping state for the active request renders a locked, progress-only dialog", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      quit.fireState({
        requestId: "req-1",
        phase: "stopping",
        idleOnly: false,
      });
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("stopping");
    expect(screen.getByTestId("host-quit-stopping")).not.toBeNull();
    expect(screen.queryByTestId("host-quit-counts")).toBeNull();
    expect(screen.getByTestId("host-quit-stop")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("idleOnly:false names the work the live list shows (e.g. 'ending 1 terminal')", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: BUSY_ONE_TERMINAL_BREAKDOWN,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      quit.fireState({
        requestId: "req-1",
        phase: "stopping",
        idleOnly: false,
      });
    });

    const stopping = await screen.findByTestId("host-quit-stopping");
    expect(stopping.textContent).toContain("ending 1 terminal");
  });

  it("idleOnly:true names NO work for the active request, even though the live list is busy", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: BUSY_ONE_TERMINAL_BREAKDOWN,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      quit.fireState({ requestId: "req-1", phase: "stopping", idleOnly: true });
    });

    const stopping = await screen.findByTestId("host-quit-stopping");
    expect(stopping.textContent).toContain("Stopping host…");
    expect(stopping.textContent).not.toContain("ending");
  });

  it("a stopping state with requestId: null (unprompted) renders a progress-only dialog with no active request", async () => {
    const quit = createFakeQuit();
    renderBridge(quit);
    expect(screen.queryByTestId("host-quit-dialog")).toBeNull();

    act(() => {
      quit.fireState({ requestId: null, phase: "stopping", idleOnly: true });
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("stopping");
    expect(screen.getByTestId("host-quit-stopping")).not.toBeNull();
  });

  it("unprompted stopping with idleOnly:true names no work, even while the local host status is busy", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: BUSY_ONE_TERMINAL_BREAKDOWN,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);

    act(() => {
      quit.fireState({ requestId: null, phase: "stopping", idleOnly: true });
    });

    const stopping = await screen.findByTestId("host-quit-stopping");
    expect(stopping.textContent).toContain("Stopping host…");
    expect(stopping.textContent).not.toContain("ending");
  });

  it("unprompted stopping with idleOnly:false names the live work (e.g. 'ending 1 terminal')", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: BUSY_ONE_TERMINAL_BREAKDOWN,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);

    act(() => {
      quit.fireState({ requestId: null, phase: "stopping", idleOnly: false });
    });

    const stopping = await screen.findByTestId("host-quit-stopping");
    expect(stopping.textContent).toContain("ending 1 terminal");
  });

  it("quitting ends the transaction and unmounts the dialog", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      quit.fireState({ requestId: "req-1", phase: "quitting" });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });
  });

  it("cancelled ends the transaction and unmounts the dialog", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      quit.fireState({ requestId: "req-1", phase: "cancelled" });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });
  });

  it("a stopping event naming a DIFFERENT requestId than the active one is ignored", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    const dialogBefore = await screen.findByTestId("host-quit-dialog");
    expect(dialogBefore.dataset.quitState).toBe("busy");

    act(() => {
      quit.fireState({
        requestId: "some-other-request",
        phase: "stopping",
        idleOnly: false,
      });
    });

    const dialogAfter = screen.getByTestId("host-quit-dialog");
    expect(dialogAfter.dataset.quitState).toBe("busy");
  });
});

describe("<HostQuitDecisionBridge /> - remember carried across busy-retry, reset on a fresh initial", () => {
  it("carries the checked Remember box from the initial round into a busy-retry round of the SAME quit", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    // Never resolves: this round's Stop must stay open through the retry.
    quit.respondImpl = () => new Promise(() => undefined);
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    expect(screen.getByTestId("host-quit-remember")).toHaveProperty(
      "dataset.state",
      "checked",
    );

    act(() => {
      quit.fireRequest(busyRetryRequest());
    });

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("busy-retry");
    expect(screen.getByTestId("host-quit-remember")).toHaveProperty(
      "dataset.state",
      "checked",
    );
  });

  it("resets Remember when a fresh initial request starts a new quit", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    expect(screen.getByTestId("host-quit-remember")).toHaveProperty(
      "dataset.state",
      "checked",
    );

    // Cancel closes this quit; a brand-new initial request is a NEW quit.
    act(() => {
      screen.getByTestId("host-quit-cancel").click();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });

    act(() => {
      quit.fireRequest({ requestId: "req-2", mode: "ask", round: "initial" });
    });
    await screen.findByTestId("host-quit-dialog");

    expect(screen.getByTestId("host-quit-remember")).toHaveProperty(
      "dataset.state",
      "unchecked",
    );
  });

  it("a fresh quit's 'busy' round (Stop-if-idle's own first ask) ALSO resets Remember, unlike 'busy-retry'", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "busy",
        busySessionCount: 1,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderBridge(quit);
    act(() => {
      quit.fireRequest(initialAskRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-remember").click();
    });
    expect(screen.getByTestId("host-quit-remember")).toHaveProperty(
      "dataset.state",
      "checked",
    );

    // Cancel closes this quit; a brand-new request - even a 'busy' round - is
    // a NEW quit, and 'busy' is not 'busy-retry'.
    act(() => {
      screen.getByTestId("host-quit-cancel").click();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
    });

    act(() => {
      quit.fireRequest(busyRequest());
    });
    await screen.findByTestId("host-quit-dialog");

    expect(screen.getByTestId("host-quit-remember")).toHaveProperty(
      "dataset.state",
      "unchecked",
    );
  });
});

describe("<HostQuitDecisionBridge /> - handlers never throw on malformed input", () => {
  it("onQuitRequest called with an empty requestId does not throw and still renders", async () => {
    const quit = createFakeQuit();
    renderBridge(quit);

    expect(() => {
      act(() => {
        quit.fireRequest({ requestId: "", mode: "ask", round: "initial" });
      });
    }).not.toThrow();

    await screen.findByTestId("host-quit-dialog");
  });

  it("onQuitState called before any request ever arrived does not throw", () => {
    const quit = createFakeQuit();
    renderBridge(quit);

    expect(() => {
      act(() => {
        quit.fireState({ requestId: "never-requested", phase: "quitting" });
      });
    }).not.toThrow();
  });
});

describe("<HostQuitDecisionBridge /> - no CLI text ever reaches the dialog", () => {
  const REQUESTS: ReadonlyArray<readonly [string, HostQuitDecisionRequest]> = [
    ["initial", initialAskRequest()],
    ["busy", busyRequest()],
    ["busy-retry", busyRetryRequest()],
  ];
  const VERDICTS: ReadonlyArray<readonly [string, LocalHostQuitStatus]> = [
    [
      "busy",
      {
        localHostId: "host-a",
        verdict: {
          kind: "busy",
          busySessionCount: 1,
          breakdown: BUSY_ONE_TERMINAL_BREAKDOWN,
          statusMinor: 6,
        },
        liveLocalHostIdNow: () => "host-a",
        recheck: vi.fn(),
      },
    ],
    [
      "unknown",
      {
        localHostId: "host-a",
        verdict: { kind: "unknown", reason: "unreachable" },
        liveLocalHostIdNow: () => "host-a",
        recheck: vi.fn(),
      },
    ],
  ];

  for (const [requestLabel, request] of REQUESTS) {
    for (const [verdictLabel, status] of VERDICTS) {
      it(`round=${requestLabel}, verdict=${verdictLabel}: no "--force" or "Re-run" anywhere in the dialog`, async () => {
        const quit = createFakeQuit();
        localHostQuitStatusMock.current = status;
        renderBridge(quit);
        act(() => {
          quit.fireRequest(request);
        });
        const dialog = await screen.findByTestId("host-quit-dialog");
        expect(dialog.textContent).not.toContain("--force");
        expect(dialog.textContent).not.toContain("Re-run");
      });
    }
  }
});
