// `HostQuitDialog` directly, with a FAKE `hostLifecycle.quit` (recording
// `respondToQuitRequest` calls) and a mocked `useLocalHostQuitStatus` so this
// file drives verdicts directly rather than re-deriving them through a real
// host client - the harness mirrors
// `components/layout/bridges/__tests__/host-quit-decision-bridge.test.tsx`,
// which draws the identical boundary one layer up (through the bridge rather
// than the dialog itself).
const localHostQuitStatusMock = vi.hoisted(
  (): { current: LocalHostQuitStatus; calls: number } => ({
    current: {
      localHostId: "host-a",
      verdict: { kind: "checking" },
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    },
    calls: 0,
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
      useLocalHostQuitStatus: () => {
        localHostQuitStatusMock.calls += 1;
        return localHostQuitStatusMock.current;
      },
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

// `HostQuitDialog` branches on `useHostBinding()` BEFORE it ever reads the
// (mocked) status hook - an unbound renderer answers its own `UNBOUND_STATUS`
// instead. Switchable so the unbound-arm test can flip it to `null`.
interface HostBindingFixture {
  readonly directory: { readonly getLocalEntry: () => null };
}
const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({
    current: { directory: { getLocalEntry: () => null } },
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

// A "busy" verdict renders `<HostRestartSessions>`, which reaches into the
// focus/notifications stack off the same narrowly-mocked `@/lib/host`
// binding above (whose fixture carries no `hostClient`). Same boundary the
// bridge test draws, for the identical reason: this suite is about the
// dialog's own branching, not that stack.
vi.mock("@/hooks/home-focus/use-focus-model", async () => {
  const { EMPTY_FOCUS_MODEL } =
    await import("@/lib/home-focus/build-focus-model");
  return { useFocusModel: () => EMPTY_FOCUS_MODEL };
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostQuitDecisionRequest,
  HostQuitDecisionResponse,
  IHostQuitDecisionHost,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type {
  HostQuitVerdict,
  LocalHostQuitStatus,
} from "@/components/host/use-local-host-quit-status";
import {
  HostQuitDialog,
  type HostQuitDialogProps,
} from "@/components/host/host-quit-dialog";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import {
  HOST_QUIT_HOST_CHANGED_DESCRIPTION,
  HOST_QUIT_HOST_CHANGED_TITLE,
  HOST_QUIT_TITLE_UNKNOWN,
  hostQuitUnknownDescription,
} from "@/lib/host/host-lifecycle-copy";

interface FakeQuit extends IHostQuitDecisionHost {
  readonly respondCalls: HostQuitDecisionResponse[];
  respondImpl: (response: HostQuitDecisionResponse) => Promise<void>;
}

function createFakeQuit(): FakeQuit {
  const respondCalls: HostQuitDecisionResponse[] = [];
  const fake: FakeQuit = {
    onQuitRequest: () => ({ dispose: () => undefined }),
    onQuitState: () => ({ dispose: () => undefined }),
    respondToQuitRequest: (response) => {
      respondCalls.push(response);
      return fake.respondImpl(response);
    },
    respondImpl: () => Promise.resolve(),
    respondCalls,
  };
  return fake;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function request(
  mode: "ask" | "stop-if-idle",
  round: "initial" | "busy" | "busy-retry",
): HostQuitDecisionRequest {
  return { requestId: "req-1", mode, round };
}

function baseProps(
  quitRequest: HostQuitDecisionRequest,
  overrides: Partial<HostQuitDialogProps>,
): HostQuitDialogProps {
  return {
    request: quitRequest,
    stopping: false,
    idleOnly: false,
    remember: false,
    onRememberChange: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
}

function renderDialog(
  props: HostQuitDialogProps,
  quit: FakeQuit,
): { readonly rerenderDialog: (nextProps: HostQuitDialogProps) => void } {
  const runnerHost: IRunnerHost = createFakeRunnerHost({
    hostLifecycle: {
      get: () =>
        Promise.resolve({
          desired: { mode: "ask", rev: 1, updatedBy: null, updatedAt: null },
          applied: {
            localHostCapability: "managed",
            supervisor: "enforcing",
            admittedAs: null,
          },
          pending: "none",
        }),
      set: () => {
        throw new Error("not used by this suite");
      },
      onChange: () => ({ dispose: () => undefined }),
      quit,
    },
  });
  const client = makeQueryClient();
  const tree = (dialogProps: HostQuitDialogProps) => (
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostQuitDialog {...dialogProps} />
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  const utils = render(tree(props));
  return {
    rerenderDialog: (nextProps: HostQuitDialogProps) => {
      utils.rerender(tree(nextProps));
    },
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

afterEach(() => {
  cleanup();
  toastInfo.mockClear();
  localHostQuitStatusMock.current = {
    localHostId: "host-a",
    verdict: { kind: "checking" },
    liveLocalHostIdNow: () => "host-a",
    recheck: vi.fn(),
  };
  localHostQuitStatusMock.calls = 0;
  hostBindingMock.current = { directory: { getLocalEntry: () => null } };
});

describe("<HostQuitDialog /> - Stop must never force a stop the person never saw disclosed", () => {
  it("verdict flips idle -> busy between render and click: Stop still sends the disclosed force:false", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    const req = request("ask", "initial");
    const { rerenderDialog } = renderDialog(baseProps(req, {}), quit);
    await screen.findByTestId("host-quit-dialog");

    // The 10s status poll lands here, turning the SAME request's list busy
    // without the person having re-opened or re-confirmed anything.
    localHostQuitStatusMock.current = busyStatus();
    rerenderDialog(baseProps(req, {}));
    expect(screen.getByTestId("host-quit-dialog").dataset.quitState).toBe(
      "busy",
    );

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

  it("control: busy from the very first render sends force:true", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = busyStatus();
    renderDialog(baseProps(request("ask", "initial"), {}), quit);
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

  it("a recheck ends the offer: idle, then checking (Stop disabled), then busy offers the force afresh", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    const req = request("ask", "initial");
    const { rerenderDialog } = renderDialog(baseProps(req, {}), quit);
    await screen.findByTestId("host-quit-dialog");

    localHostQuitStatusMock.current = {
      ...idleStatus(),
      verdict: { kind: "checking" },
    };
    rerenderDialog(baseProps(req, {}));
    expect(screen.getByTestId("host-quit-stop").hasAttribute("disabled")).toBe(
      true,
    );

    localHostQuitStatusMock.current = busyStatus();
    rerenderDialog(baseProps(req, {}));

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

  it("a busy-retry round after an idle-first initial round offers its force from its first render", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    const { rerenderDialog } = renderDialog(
      baseProps(request("ask", "initial"), {}),
      quit,
    );
    await screen.findByTestId("host-quit-dialog");

    rerenderDialog(
      baseProps({ requestId: "req-2", mode: "ask", round: "busy-retry" }, {}),
    );

    act(() => {
      screen.getByTestId("host-quit-stop").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0]).toEqual({
      requestId: "req-2",
      decision: { kind: "stop", force: true, remember: false },
    });
  });

  it("control: idle throughout sends force:false", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    const req = request("ask", "initial");
    const { rerenderDialog } = renderDialog(baseProps(req, {}), quit);
    await screen.findByTestId("host-quit-dialog");

    rerenderDialog(baseProps(req, {}));

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
});

describe("<HostQuitDialog /> - Keep is focused on open, so Enter keeps rather than stops", () => {
  it("a busy verdict (where Stop would force) still auto-focuses Keep; Enter sends Keep, never Stop", async () => {
    const user = userEvent.setup();
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = busyStatus();
    renderDialog(baseProps(request("ask", "initial"), {}), quit);
    await screen.findByTestId("host-quit-dialog");

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("host-quit-keep"));
    });

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision.kind).toBe("keep");
    expect(
      quit.respondCalls.some((call) => call.decision.kind === "stop"),
    ).toBe(false);
  });
});

describe("<HostQuitDialog /> - unbound arm and click-time host-changed recheck", () => {
  it("useHostBinding() null renders the unknown/no-connection state and never calls useLocalHostQuitStatus", async () => {
    const quit = createFakeQuit();
    hostBindingMock.current = null;
    renderDialog(baseProps(request("ask", "initial"), {}), quit);

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("unknown");
    expect(screen.getByText(HOST_QUIT_TITLE_UNKNOWN)).not.toBeNull();
    expect(
      screen.getByText(hostQuitUnknownDescription("no-connection")),
    ).not.toBeNull();
    expect(localHostQuitStatusMock.calls).toBe(0);
  });

  it("Keep click-time: the live host changed under the dialog - no respond, toasts Host changed, recheck() once", async () => {
    const quit = createFakeQuit();
    const recheck = vi.fn();
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: {
        kind: "idle",
        busySessionCount: 0,
        breakdown: null,
        statusMinor: 6,
      },
      liveLocalHostIdNow: () => "host-b",
      recheck,
    };
    renderDialog(baseProps(request("ask", "initial"), {}), quit);
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-keep").click();
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

describe("<HostQuitDialog /> - not-running verdict (a directory entry that is down / not dialable)", () => {
  it("initial ask round with a not-running verdict answers Keep automatically and never opens the dialog", async () => {
    const quit = createFakeQuit();
    const NOT_RUNNING_VERDICT: HostQuitVerdict = { kind: "not-running" };
    localHostQuitStatusMock.current = {
      localHostId: "host-a",
      verdict: NOT_RUNNING_VERDICT,
      liveLocalHostIdNow: () => "host-a",
      recheck: vi.fn(),
    };
    renderDialog(baseProps(request("ask", "initial"), {}), quit);

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "keep",
      remember: false,
    });
    expect(screen.queryByTestId("host-quit-dialog")).toBeNull();
  });
});

describe("<HostQuitDialog /> - the terminals-in-use round", () => {
  const TERMINALS_REQUEST: HostQuitDecisionRequest = {
    requestId: "req-1",
    mode: "stop-if-idle",
    round: "terminals-in-use",
    terminalsInUse: 2,
  };
  const STATUSES: ReadonlyArray<readonly [string, LocalHostQuitStatus]> = [
    ["busy", busyStatus()],
    ["idle", idleStatus()],
    ["checking", { ...idleStatus(), verdict: { kind: "checking" } }],
    [
      "unknown",
      { ...idleStatus(), verdict: { kind: "unknown", reason: "unreachable" } },
    ],
  ];

  it("renders the count in the title and no counts line, even beside an idle verdict", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    renderDialog(baseProps(TERMINALS_REQUEST, {}), quit);

    const dialog = await screen.findByTestId("host-quit-dialog");
    expect(dialog.dataset.quitState).toBe("terminals-in-use");
    expect(screen.getByText("2 terminals are still in use")).not.toBeNull();
    expect(
      screen.getByText(
        "Stopping the host ends them. Quitting Traycer can keep the host running so they carry on, or stop it now.",
      ),
    ).not.toBeNull();
    expect(screen.queryByTestId("host-quit-counts")).toBeNull();
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
    expect(screen.getByTestId("host-quit-stop").textContent).toBe(
      "Stop host and quit",
    );
  });

  for (const [label, status] of STATUSES) {
    it(`${label} status: Stop answers the idle-only stop {stop, force:false, remember:false} and is enabled`, async () => {
      const quit = createFakeQuit();
      localHostQuitStatusMock.current = status;
      renderDialog(baseProps(TERMINALS_REQUEST, {}), quit);
      await screen.findByTestId("host-quit-dialog");

      expect(
        screen.getByTestId("host-quit-stop").hasAttribute("disabled"),
      ).toBe(false);
      // Not answered by itself: only a person's click is.
      expect(quit.respondCalls).toEqual([]);

      act(() => {
        screen.getByTestId("host-quit-stop").click();
      });

      await waitFor(() => {
        expect(quit.respondCalls).toHaveLength(1);
      });
      expect(quit.respondCalls[0]).toEqual({
        requestId: "req-1",
        decision: { kind: "stop", force: false, remember: false },
      });
    });
  }

  it("a poll that turns the status busy under the open question still sends force:false", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    const { rerenderDialog } = renderDialog(
      baseProps(TERMINALS_REQUEST, {}),
      quit,
    );
    await screen.findByTestId("host-quit-dialog");

    localHostQuitStatusMock.current = busyStatus();
    rerenderDialog(baseProps(TERMINALS_REQUEST, {}));
    expect(screen.getByTestId("host-quit-dialog").dataset.quitState).toBe(
      "terminals-in-use",
    );

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

  it("Keep answers keep", async () => {
    const quit = createFakeQuit();
    localHostQuitStatusMock.current = idleStatus();
    renderDialog(baseProps(TERMINALS_REQUEST, {}), quit);
    await screen.findByTestId("host-quit-dialog");

    act(() => {
      screen.getByTestId("host-quit-keep").click();
    });

    await waitFor(() => {
      expect(quit.respondCalls).toHaveLength(1);
    });
    expect(quit.respondCalls[0].decision).toEqual({
      kind: "keep",
      remember: false,
    });
  });
});
