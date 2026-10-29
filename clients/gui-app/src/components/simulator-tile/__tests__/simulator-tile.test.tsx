import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type {
  SimulatorHostInstance,
  SimulatorOpenRequest,
  SimulatorOpenResponse,
  SimulatorPackState,
  SimulatorPowerOffRequest,
  SimulatorPowerOffResponse,
  SimulatorSession,
  SimulatorShutdownRequest,
  SimulatorShutdownResponse,
  SimulatorState,
} from "@traycer/protocol/host/simulator/schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import type { SimulatorStreamState } from "@/lib/simulator-view/simulator-stream-controller";
import {
  requestSimulatorConnect,
  resetSimulatorConnectRequestsForTests,
} from "@/lib/simulator-view/simulator-connect-requests";
import {
  makeSimulatorTileRef,
  simulatorTileId,
} from "@/stores/epics/canvas/tile-schema/simulator-tile";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

/**
 * The tile's states, one per host condition: the host that cannot run
 * simulators says why per platform; one with them off shows the switch; one
 * installing shows progress; one with the simulator open shows the surface
 * and the platform's buttons. Every host-facing hook is a fake, so each case
 * is one published state and the words it produces.
 */

const HOST = "host-1";
const EPIC = "epic-1";
const UDID = "udid-1";

/**
 * The host's side of `simulator.open`: what the tile's REAL TanStack mutation
 * calls, so every per-call callback the tile hangs on the mutation runs the
 * way it does in the app. By default the host never answers (a boot in
 * flight); a test that wants an answer installs one with
 * `mockImplementationOnce` before the tile sends the open.
 */
type OpenOnHost = (
  variables: SimulatorOpenRequest,
) => Promise<SimulatorOpenResponse>;

/** The host's side of `simulator.shutdown`; never answers by default. */
type ShutdownOnHost = (
  variables: SimulatorShutdownRequest,
) => Promise<SimulatorShutdownResponse>;

/** The host's side of `simulator.powerOff`; never answers by default. */
type PowerOffOnHost = (
  variables: SimulatorPowerOffRequest,
) => Promise<SimulatorPowerOffResponse>;

const fakes = vi.hoisted(() => ({
  reachability: "reachable",
  /** What `simulator.open` negotiated: `@1.0` unless a case says otherwise. */
  negotiated: { major: 1, minor: 0 } as SchemaVersion | false | null,
  viewerUserId: "user-1" as string | null,
  sessions: null as SimulatorSessionsState | null,
  /** What `simulator.instances` says is booted on the machine, host-wide. */
  hostInstances: [] as SimulatorHostInstance[],
  /** Whether that host-wide read has answered yet; false is its first frame. */
  hostInstancesAnswered: true,
  configSet: vi.fn(),
  open: vi.fn<OpenOnHost>(() => new Promise<SimulatorOpenResponse>(() => {})),
  close: vi.fn(),
  shutdown: vi.fn<ShutdownOnHost>(
    () => new Promise<SimulatorShutdownResponse>(() => {}),
  ),
  powerOff: vi.fn<PowerOffOnHost>(
    () => new Promise<SimulatorPowerOffResponse>(() => {}),
  ),
  action: vi.fn(),
  closeTile: vi.fn(),
  openTile: vi.fn(),
  refresh: vi.fn(),
  retry: vi.fn(),
  screenshot: vi.fn(),
  streamState: null as SimulatorStreamState | null,
  restart: vi.fn(),
  pressButton: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => fakes.negotiated,
}));
vi.mock("@/hooks/host/use-request-context-user-id", () => ({
  useRequestContextUserId: () => fakes.viewerUserId,
}));
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/agent/use-host-reachability")
  >()),
  useHostReachability: () => ({
    status: fakes.reachability,
    hostLabel: "Studio Mac",
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));
vi.mock("@/lib/simulator-view/use-simulator-sessions", () => ({
  useSimulatorSessionsForHost: () => fakes.sessions,
}));
vi.mock("@/hooks/simulator/use-simulator-mutations", async () => {
  // The open and the power off ride real mutations: what the tile does with
  // an answer depends on whether TanStack still delivers it to an observer
  // that may have unmounted, so a hand-rolled fake would pass whatever the
  // tile did with it.
  const { useMutation } = await import("@tanstack/react-query");
  const gated = (mutate: unknown) => ({
    mutation: { mutate, isPending: false, variables: undefined },
    supported: true,
  });
  return {
    useSimulatorConfigQuery: () => ({
      data: { enabled: false },
    }),
    useSimulatorConfigSetMutation: () => gated(fakes.configSet),
    useSimulatorOpenMutation: () => ({
      mutation: useMutation({
        mutationFn: (variables: SimulatorOpenRequest) => fakes.open(variables),
      }),
      supported: true,
    }),
    useSimulatorCloseMutation: () => gated(fakes.close),
    useSimulatorShutdownMutation: () => ({
      mutation: useMutation({
        mutationFn: (variables: SimulatorShutdownRequest) =>
          fakes.shutdown(variables),
      }),
      supported: true,
    }),
    useSimulatorPowerOffMutation: () => ({
      mutation: useMutation({
        mutationFn: (variables: SimulatorPowerOffRequest) =>
          fakes.powerOff(variables),
      }),
      supported: true,
    }),
    useSimulatorActionMutation: () => gated(fakes.action),
    useSimulatorInstancesQuery: () => ({
      data: fakes.hostInstancesAnswered
        ? { instances: fakes.hostInstances }
        : undefined,
      isError: false,
    }),
    useSimulatorScreenshotMutation: () => gated(vi.fn()),
    useSimulatorDetailQuery: () => ({
      data: undefined,
      isError: false,
      isFetching: false,
    }),
    useSimulatorDrawerActionMutation: () => ({
      mutation: {
        mutate: fakes.action,
        isPending: false,
        isError: false,
        error: null,
        variables: undefined,
      },
      supported: true,
    }),
    simulatorActionErrorText: () => "",
  };
});
vi.mock(
  "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus",
  () => ({ useCloseCanvasTileWithNestedFocus: () => fakes.closeTile }),
);
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: fakes.openTile }),
}));
vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => true,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => null,
}));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));
vi.mock("@/components/simulator-tile/use-simulator-screenshot", () => ({
  useSimulatorScreenshot: () => ({ take: fakes.screenshot, isPending: false }),
}));
vi.mock("@/components/simulator-tile/use-simulator-stream", () => ({
  useSimulatorStream: () => ({
    controller: {
      restart: fakes.restart,
      pressButton: fakes.pressButton,
      rotate: fakes.rotate,
    },
    state: fakes.streamState,
    sink: { attachCanvas: () => undefined, attachImage: () => undefined },
  }),
}));

import { SimulatorTile } from "@/components/simulator-tile/simulator-tile";

const READY_STATE: SimulatorState = {
  revision: 1,
  hostId: HOST,
  platforms: [
    { platform: "ios", available: true, reason: null },
    { platform: "android", available: false, reason: "No Android SDK." },
  ],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: [
    {
      simulatorId: UDID,
      platform: "ios",
      name: "iPhone 16",
      version: "18.0",
      booted: false,
      physical: false,
    },
    {
      simulatorId: "udid-2",
      platform: "ios",
      name: "iPad Air",
      version: "18.0",
      booted: true,
      physical: false,
    },
  ],
  sessions: [],
  booting: [],
};

const STREAMING: SimulatorStreamState = {
  lifecycle: "streaming",
  detail: null,
  terminal: false,
  config: {
    platform: "ios",
    codec: "avcc",
    width: 1179,
    height: 2556,
    orientation: "portrait",
    inputAvailable: true,
    frameIntervalMs: 200,
  },
  plane: "canvas",
  frameSize: { width: 1179, height: 2556 },
  input: { connected: true, detail: null },
  stalled: false,
};

function sessions(
  overrides: Partial<SimulatorSessionsState>,
): SimulatorSessionsState {
  return {
    hostId: HOST,
    lifecycle: "live",
    state: READY_STATE,
    errorMessage: null,
    refresh: fakes.refresh,
    retry: fakes.retry,
    ...overrides,
  };
}

function withPack(packState: SimulatorPackState): SimulatorState {
  return { ...READY_STATE, packState };
}

const SESSION = {
  epicId: EPIC,
  ownerUserId: "user-1",
  hostId: HOST,
  simulatorId: UDID,
  platform: "ios",
  openedAt: "2026-10-18T00:00:00.000Z",
} as const;

/**
 * A host that has just started (or restarted): the stream is live and the
 * tools are ready, and the inventory it publishes is empty until something
 * runs `simulator.list`, which is what starts the hub.
 */
const FRESH_HOST_STATE: SimulatorState = { ...READY_STATE, simulators: [] };

/** The tile with its own simulator booted, as the host lists it. */
function withTargetBooted(state: SimulatorState): SimulatorState {
  return {
    ...state,
    simulators: state.simulators.map((simulator) =>
      simulator.simulatorId === UDID
        ? { ...simulator, booted: true }
        : simulator,
    ),
  };
}

/**
 * Re-renders with whatever `fakes.sessions` now says, as the stream would.
 * Under StrictMode, as the desktop renders in development, so a double-run
 * effect or a replayed render is part of what the suite proves.
 */
function renderTile(): () => void {
  return renderTileFor(
    makeSimulatorTileRef({
      hostId: HOST,
      simulatorId: UDID,
      platform: "ios",
      name: "iPhone 16",
      instanceKey: null,
    }),
  );
}

function renderTileFor(node: SimulatorTileRef): () => void {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  // A fresh element each time: React skips a subtree handed the very same
  // element object, and the fake hook is only re-read on a real render.
  const tile = () => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SimulatorTile
            node={node}
            viewTabId="tab-1"
            tileId="pane-1"
            epicId={EPIC}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const { rerender } = render(tile());
  return () => rerender(tile());
}

/** Lets a mutation the tile just sent reach the host fake (TanStack dispatches after awaiting its hooks). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const OPENED: SimulatorOpenResponse = {
  session: {
    epicId: EPIC,
    ownerUserId: "user-1",
    hostId: HOST,
    simulatorId: UDID,
    platform: "ios",
    openedAt: "2026-10-18T00:00:00.000Z",
  },
  simulator: {
    simulatorId: UDID,
    platform: "ios",
    name: "iPhone 16",
    version: "18.0",
    booted: true,
    physical: false,
  },
};

beforeEach(() => {
  fakes.reachability = "reachable";
  fakes.negotiated = { major: 1, minor: 0 };
  fakes.viewerUserId = "user-1";
  fakes.sessions = sessions({});
  fakes.hostInstances = [];
  fakes.hostInstancesAnswered = true;
  fakes.streamState = STREAMING;
});

afterEach(() => {
  cleanup();
  resetSimulatorConnectRequestsForTests();
  vi.clearAllMocks();
});

describe("SimulatorTile", () => {
  it("shows the ordinary host-disconnected notice when the tab host is unreachable", () => {
    fakes.reachability = "unreachable";
    renderTile();
    expect(
      screen.getByTestId("simulator-host-unreachable").textContent,
    ).toContain("Host is unreachable");
  });

  it("says the host needs an update when it cannot serve the stream", () => {
    fakes.sessions = sessions({
      lifecycle: "unsupported",
      state: null,
      errorMessage: "This host needs an update before it can show simulators.",
    });
    renderTile();
    expect(screen.getByTestId("simulator-unavailable").textContent).toContain(
      "needs an update",
    );
  });

  it("lists each platform's reason when the host can run neither", () => {
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        platforms: [
          {
            platform: "ios",
            available: false,
            reason: "Xcode is not installed.",
          },
          { platform: "android", available: false, reason: "No Android SDK." },
        ],
        packState: { kind: "unsupported", reason: null, progress: null },
      },
    });
    renderTile();
    expect(
      screen.getByTestId("simulator-platform-reason-ios").textContent,
    ).toContain("Xcode is not installed.");
    expect(
      screen.getByTestId("simulator-platform-reason-android").textContent,
    ).toContain("No Android SDK.");
  });

  it("shows the setup view with the switch while simulators are off, and turns them on", () => {
    fakes.sessions = sessions({
      state: withPack({ kind: "off", reason: null, progress: null }),
    });
    renderTile();
    expect(screen.getByTestId("simulator-setup").textContent).toContain(
      "Mobile simulators are off on Studio Mac",
    );
    fireEvent.click(screen.getByTestId("simulator-enable-switch"));
    expect(fakes.configSet).toHaveBeenCalledWith({ enabled: true });
  });

  it("shows download progress while the host installs the tools", () => {
    fakes.sessions = sessions({
      state: withPack({ kind: "installing", reason: null, progress: 0.42 }),
    });
    renderTile();
    expect(screen.getByTestId("simulator-installing").textContent).toContain(
      "42% done",
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "42",
    );
  });

  it("shows the host's reason and a retry when setup failed", () => {
    fakes.sessions = sessions({
      state: withPack({
        kind: "failed",
        reason: "The download was interrupted.",
        progress: null,
      }),
    });
    renderTile();
    expect(screen.getByTestId("simulator-failed").textContent).toContain(
      "The download was interrupted.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
  });

  it("asks a fresh host for its inventory once the stream is live with the tools ready, and not again on a re-render", () => {
    fakes.sessions = sessions({ state: FRESH_HOST_STATE });
    const rerender = renderTile();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
  });

  it("asks nothing while the tools are off, and asks as soon as they are ready", () => {
    fakes.sessions = sessions({
      state: {
        ...FRESH_HOST_STATE,
        packState: { kind: "off", reason: null, progress: null },
      },
    });
    const rerender = renderTile();
    expect(fakes.refresh).not.toHaveBeenCalled();
    fakes.sessions = sessions({ state: FRESH_HOST_STATE });
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
  });

  it("asks again when the sessions stream comes back after a drop", () => {
    fakes.sessions = sessions({ state: FRESH_HOST_STATE });
    const rerender = renderTile();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
    // A host restart takes the stream down under a tile that never unmounted,
    // and the hub it had started is gone with the host.
    fakes.sessions = sessions({
      state: FRESH_HOST_STATE,
      lifecycle: "reconnecting",
    });
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
    fakes.sessions = sessions({ state: FRESH_HOST_STATE });
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(2);
  });

  it("boots a cold simulator once when an explicit open placed the tile, and not when the tile is merely shown", async () => {
    // A restored (or re-rendered) cold tile waits for the person.
    const rerender = renderTile();
    await flush();
    expect(fakes.open).not.toHaveBeenCalled();
    rerender();
    await flush();
    expect(fakes.open).not.toHaveBeenCalled();
    cleanup();

    // The row click filed its request before the tile mounted.
    requestSimulatorConnect(
      simulatorTileId({ hostId: HOST, simulatorId: UDID }),
    );
    const rerenderRequested = renderTile();
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
    expect(fakes.open).toHaveBeenCalledWith({
      epicId: EPIC,
      simulatorId: UDID,
      platform: "ios",
      boot: true,
    });
    rerenderRequested();
    await flush();
    expect(fakes.open).toHaveBeenCalledTimes(1);
  });

  it("drops a request for a simulator this tile already shows live", async () => {
    fakes.sessions = sessions({
      state: { ...withTargetBooted(READY_STATE), sessions: [SESSION] },
    });
    requestSimulatorConnect(
      simulatorTileId({ hostId: HOST, simulatorId: UDID }),
    );
    const rerender = renderTile();
    await flush();
    expect(fakes.open).not.toHaveBeenCalled();
    // The session ends later: the stale request must not boot anything.
    fakes.sessions = sessions({ state: withTargetBooted(READY_STATE) });
    rerender();
    await flush();
    expect(fakes.open).not.toHaveBeenCalled();
  });

  it("offers to boot a cold simulator, and places another row as its own tile without booting it", async () => {
    renderTile();
    expect(screen.getByTestId("simulator-inventory").textContent).toContain(
      "Powered off",
    );
    fireEvent.click(screen.getByTestId("simulator-connect"));
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledWith({
        epicId: EPIC,
        simulatorId: UDID,
        platform: "ios",
        boot: true,
      });
    });
    const other = screen.getByTestId("simulator-inventory-row-udid-2");
    expect(other.textContent).toContain("iPad Air");
    fireEvent.click(other);
    expect(fakes.openTile).toHaveBeenCalledTimes(1);
    expect(fakes.openTile.mock.calls[0][0]).toMatchObject({
      node: { type: "simulator", hostId: HOST, simulatorId: "udid-2" },
      target: { tabId: "tab-1" },
    });
    // The other tile connects on its own; this one sent no open for it.
    await flush();
    expect(fakes.open).toHaveBeenCalledTimes(1);
  });

  it("attaches a booted simulator on its own, without a click", async () => {
    fakes.sessions = sessions({ state: withTargetBooted(READY_STATE) });
    renderTile();
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
    expect(fakes.open.mock.calls[0][0]).toMatchObject({ simulatorId: UDID });
  });

  it("shows the live surface with the platform's buttons once the task holds a session", () => {
    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [SESSION] },
    });
    renderTile();
    expect(screen.getByTestId("simulator-toolbar").textContent).toContain(
      "iPhone 16",
    );
    expect(screen.getByTestId("simulator-button-home")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByTestId("simulator-button-appSwitcher")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByTestId("simulator-button-back")).toBeNull();
    expect(
      screen.getByTestId("simulator-surface").getAttribute("data-lifecycle"),
    ).toBe("streaming");
    fireEvent.click(screen.getByTestId("simulator-button-home"));
    expect(fakes.pressButton).toHaveBeenCalledWith("home");
    fireEvent.click(screen.getByTestId("simulator-rotate"));
    expect(fakes.rotate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("simulator-screenshot"));
    expect(fakes.screenshot).toHaveBeenCalledTimes(1);
  });

  it("ends the session on close when the host answered the open a row click made this tile send", async () => {
    // The row click filed its request; the gate sends the open; the stream
    // delivers the session FIRST (the gate unmounts for the live view), and
    // only then does the host answer the RPC - to the tile, which outlives
    // the gate and is what the close rule hangs on.
    let answer: ((response: SimulatorOpenResponse) => void) | null = null;
    fakes.open.mockImplementationOnce(
      () =>
        new Promise<SimulatorOpenResponse>((resolve) => {
          answer = resolve;
        }),
    );
    requestSimulatorConnect(
      simulatorTileId({ hostId: HOST, simulatorId: UDID }),
    );
    fakes.sessions = sessions({ state: withTargetBooted(READY_STATE) });
    const rerender = renderTile();
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
    fakes.sessions = sessions({
      state: { ...withTargetBooted(READY_STATE), sessions: [SESSION] },
    });
    rerender();
    expect(screen.getByTestId("simulator-toolbar")).toBeTruthy();
    await act(async () => {
      answer?.(OPENED);
      // TanStack awaits its lifecycle hooks and notifies on its own timer.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByTestId("simulator-close"));
    expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledWith({
      epicId: EPIC,
      simulatorId: UDID,
      shutdown: false,
    });
  });

  it("leaves the session open on close when a connect request sent the open but the host never answered it", async () => {
    // The row click's request makes the gate send `simulator.open`; the
    // session that then shows up on the stream is not proven to be this
    // tile's until the host answers that open.
    requestSimulatorConnect(
      simulatorTileId({ hostId: HOST, simulatorId: UDID }),
    );
    fakes.sessions = sessions({ state: withTargetBooted(READY_STATE) });
    const rerender = renderTile();
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
    fakes.sessions = sessions({
      state: { ...withTargetBooted(READY_STATE), sessions: [SESSION] },
    });
    rerender();
    fireEvent.click(screen.getByTestId("simulator-close"));
    expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    expect(fakes.close).not.toHaveBeenCalled();
  });

  it("offers Boot and connect again once a session ends under it, even while its own open never settled", async () => {
    // The open the tile sent is still in flight on the RPC when the session
    // arrives on the stream; the host then ends that session (a device shut
    // down under the hub). The inventory that follows must be usable.
    fakes.sessions = sessions({ state: withTargetBooted(READY_STATE) });
    const rerender = renderTile();
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
    fakes.sessions = sessions({
      state: { ...withTargetBooted(READY_STATE), sessions: [SESSION] },
    });
    rerender();
    expect(screen.getByTestId("simulator-toolbar")).toBeTruthy();

    fakes.sessions = sessions({ state: READY_STATE });
    rerender();
    const connect = screen.getByTestId("simulator-connect");
    expect(connect.textContent).toContain("Boot and connect");
    expect(connect).toHaveProperty("disabled", false);
    fireEvent.click(connect);
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(2);
    });
    // Sent again: in flight until the host answers or the session shows up.
    expect(screen.getByTestId("simulator-connect")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("offers Boot and connect for an Android emulator whose serial vanished when it powered off", async () => {
    // An Android emulator is listed under its serial while booted and under
    // its AVD name once it has exited; the tile was placed on the serial.
    const serial = "emulator-5554";
    const avd = "Pixel_8_API_35";
    const bootedRow = {
      simulatorId: serial,
      platform: "android",
      name: avd,
      version: "Android 15.0",
      booted: true,
      physical: false,
    } as const;
    const coldRow = {
      simulatorId: avd,
      platform: "android",
      name: avd,
      version: "Android",
      booted: false,
      physical: false,
    } as const;
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        simulators: [...READY_STATE.simulators, bootedRow],
        sessions: [{ ...SESSION, simulatorId: serial, platform: "android" }],
      },
    });
    const rerender = renderTileFor(
      makeSimulatorTileRef({
        hostId: HOST,
        simulatorId: serial,
        platform: "android",
        name: avd,
        instanceKey: null,
      }),
    );
    expect(screen.getByTestId("simulator-toolbar")).toBeTruthy();

    // Power off: the session ends and the serial is gone from the list.
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        simulators: [...READY_STATE.simulators, coldRow],
      },
    });
    rerender();
    const inventory = screen.getByTestId("simulator-inventory");
    expect(inventory.textContent).not.toContain("no longer lists");
    expect(inventory.textContent).toContain("Powered off");
    // The AVD is this tile's own row, not one of the "other simulators".
    expect(screen.queryByTestId(`simulator-inventory-row-${avd}`)).toBeNull();
    await flush();
    expect(fakes.open).not.toHaveBeenCalled();
    const connect = screen.getByTestId("simulator-connect");
    expect(connect.textContent).toContain("Boot and connect");
    fireEvent.click(connect);
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledWith({
        epicId: EPIC,
        simulatorId: avd,
        platform: "android",
        boot: true,
      });
    });
  });

  it("closes the tile after a power off even when its session ended before the host answered", async () => {
    fakes.sessions = sessions({
      state: { ...withTargetBooted(READY_STATE), sessions: [SESSION] },
    });
    let answer: (response: SimulatorShutdownResponse) => void = () => {};
    fakes.shutdown.mockImplementationOnce(
      () =>
        new Promise<SimulatorShutdownResponse>((resolve) => {
          answer = resolve;
        }),
    );
    const rerender = renderTile();
    fireEvent.click(screen.getByTestId("simulator-power-off"));
    fireEvent.click(screen.getByRole("button", { name: "Power off" }));
    await waitFor(() => {
      expect(fakes.shutdown).toHaveBeenCalledTimes(1);
    });

    // The sessions stream drops the session first, which unmounts the live
    // tile and the observer that sent the shutdown.
    fakes.sessions = sessions({ state: READY_STATE });
    rerender();
    expect(screen.queryByTestId("simulator-toolbar")).toBeNull();
    expect(fakes.closeTile).not.toHaveBeenCalled();

    await act(async () => {
      answer({ simulatorId: UDID, booted: false });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves a session it only attached to - an agent's - open when the tile closes", async () => {
    fakes.sessions = sessions({
      state: { ...withTargetBooted(READY_STATE), sessions: [SESSION] },
    });
    renderTile();
    await flush();
    expect(fakes.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("simulator-close"));
    expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    expect(fakes.close).not.toHaveBeenCalled();
  });

  it("does not reconnect on its own once its session is closed under it", async () => {
    fakes.sessions = sessions({
      state: { ...withTargetBooted(READY_STATE), sessions: [SESSION] },
    });
    const rerender = renderTile();
    fakes.sessions = sessions({ state: withTargetBooted(READY_STATE) });
    rerender();
    expect(screen.getByTestId("simulator-inventory").textContent).toContain(
      "not yet open in this task",
    );
    await flush();
    expect(fakes.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("simulator-connect"));
    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
  });

  it("opens the settings drawer from the toolbar and closes it again", () => {
    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [SESSION] },
    });
    renderTile();
    const toggle = screen.getByTestId("simulator-settings-toggle");
    expect(screen.queryByTestId("simulator-settings-drawer")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("simulator-settings-drawer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByTestId("simulator-settings-drawer")).toBeNull();
  });

  it("says it is waiting over the last frame while the hub has gone quiet, with the surface still live", () => {
    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [SESSION] },
    });
    fakes.streamState = { ...STREAMING, stalled: true };
    const rerender = renderTile();
    expect(screen.getByTestId("simulator-stall-overlay").textContent).toContain(
      "Waiting for the simulator",
    );
    expect(
      screen.getByTestId("simulator-surface").getAttribute("data-lifecycle"),
    ).toBe("streaming");
    expect(screen.queryByTestId("simulator-surface-overlay")).toBeNull();
    // The next frame clears it.
    fakes.streamState = STREAMING;
    rerender();
    expect(screen.queryByTestId("simulator-stall-overlay")).toBeNull();
  });

  it("offers Reconnect when the video stopped, and nothing when the session is gone", () => {
    const withSession: SimulatorState = {
      ...READY_STATE,
      sessions: [SESSION],
    };
    fakes.sessions = sessions({ state: withSession });
    fakes.streamState = {
      ...STREAMING,
      lifecycle: "error",
      detail: "No video arrived from the simulator.",
      terminal: false,
    };
    renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(fakes.restart).toHaveBeenCalledTimes(1);

    cleanup();
    fakes.streamState = {
      ...STREAMING,
      lifecycle: "error",
      detail: "This simulator was closed.",
      terminal: true,
    };
    renderTile();
    expect(
      screen.getByTestId("simulator-surface-overlay").textContent,
    ).toContain("This simulator was closed.");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});

/**
 * On a `@1.1` host the tile goes live only on the viewer's own person session
 * on its instance, closes it by `sessionId` whoever sent the open, and powers
 * off through `simulator.powerOff`.
 */
describe("SimulatorTile on a @1.1 host", () => {
  const PERSON_SESSION: SimulatorSession = {
    ...SESSION,
    sessionId: "session-person",
    instanceKey: UDID,
    agentId: null,
    requestId: "palette-request",
  };
  const AGENT_SESSION: SimulatorSession = {
    ...SESSION,
    sessionId: "session-agent",
    instanceKey: UDID,
    agentId: "agent-1",
    requestId: null,
  };

  /**
   * An Android device with one clone of its own. The host keys an instance by
   * its AVD name and lists what runs under the serial its emulator took, so a
   * clone's key and the serial its tile carries are two different strings -
   * and the clone is never a device, only a row under its source's
   * `instances`.
   */
  const SOURCE_SERIAL = "emulator-5554";
  const SOURCE_AVD = "Pixel_8_API_35";
  const CLONE_AVD = "Pixel_8_API_35_traycer_2";
  const CLONE_SERIAL = "emulator-5556";
  const SOURCE_OWN_INSTANCE = {
    instanceKey: SOURCE_AVD,
    name: SOURCE_AVD,
    booted: true,
    cloneOf: null,
    drivenByAgent: false,
    keepRunning: false,
    idleUntil: null,
  } as const;
  const CLONE_INSTANCE = {
    ...SOURCE_OWN_INSTANCE,
    instanceKey: CLONE_AVD,
    name: "Pixel_8_API_35 · 2",
    cloneOf: SOURCE_AVD,
    drivenByAgent: true,
  } as const;
  const CLONE_STATE: SimulatorState = {
    ...READY_STATE,
    platforms: [
      { platform: "ios", available: true, reason: null },
      { platform: "android", available: true, reason: null },
    ],
    simulators: [
      ...READY_STATE.simulators,
      {
        simulatorId: SOURCE_SERIAL,
        platform: "android",
        name: SOURCE_AVD,
        version: "Android 15.0",
        booted: true,
        physical: false,
        instances: [SOURCE_OWN_INSTANCE, CLONE_INSTANCE],
      },
    ],
  };
  /** The same clone in the host-wide read, which names its serial beside its key. */
  const CLONE_HOST_WIDE: SimulatorHostInstance = {
    ...CLONE_INSTANCE,
    drivenByAgent: false,
    keepRunning: true,
    simulatorId: CLONE_SERIAL,
    platform: "android",
    version: "Android 15.0",
    cloneOfName: SOURCE_AVD,
    bootedByTraycer: true,
    tasks: [],
    otherTaskCount: 0,
  };
  const onClone = (session: SimulatorSession): SimulatorSession => ({
    ...session,
    simulatorId: CLONE_SERIAL,
    instanceKey: CLONE_AVD,
    platform: "android",
  });
  /**
   * A clone's tile as Boot another on the source device places it: that
   * device's name, and - stored before the tile carried an instance, or
   * placed from a device row - no instance of its own, so only a live read
   * can tell it from the device it is named after.
   */
  function cloneTileNamedAfterSource(): SimulatorTileRef {
    return makeSimulatorTileRef({
      hostId: HOST,
      simulatorId: CLONE_SERIAL,
      platform: "android",
      name: SOURCE_AVD,
      instanceKey: null,
    });
  }

  /** The same tile with the instance its open answered with recorded on it. */
  function cloneTileNamingItsInstance(): SimulatorTileRef {
    return makeSimulatorTileRef({
      hostId: HOST,
      simulatorId: CLONE_SERIAL,
      platform: "android",
      name: SOURCE_AVD,
      instanceKey: CLONE_AVD,
    });
  }

  beforeEach(() => {
    fakes.negotiated = { major: 1, minor: 1 };
  });

  it("opens the new serial, with no instance, for an Android tile whose AVD re-booted under another serial", async () => {
    const avd = "Pixel_8_API_35";
    const rebooted = {
      simulatorId: "emulator-5556",
      platform: "android",
      name: avd,
      version: "Android 15.0",
      booted: true,
      physical: false,
    } as const;
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        simulators: [...READY_STATE.simulators, rebooted],
      },
    });
    renderTileFor(
      makeSimulatorTileRef({
        hostId: HOST,
        simulatorId: "emulator-5554",
        platform: "android",
        name: avd,
        instanceKey: null,
      }),
    );

    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
    const sent = fakes.open.mock.calls[0][0];
    expect(sent).toEqual({
      epicId: EPIC,
      simulatorId: "emulator-5556",
      platform: "android",
      boot: true,
    });
    expect("instance" in sent).toBe(false);
    expect("requestId" in sent).toBe(false);
  });

  it("gets its own session beside an agent's reopened one: the agent's does not make the tile live", async () => {
    fakes.sessions = sessions({
      state: {
        ...withTargetBooted(READY_STATE),
        sessions: [AGENT_SESSION],
      },
    });
    renderTile();

    await waitFor(() => {
      expect(fakes.open).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("simulator-toolbar")).toBeNull();
    const sent = fakes.open.mock.calls[0][0];
    expect(sent).toEqual({
      epicId: EPIC,
      simulatorId: UDID,
      platform: "ios",
      boot: true,
    });
    expect("instance" in sent).toBe(false);
  });

  it("goes live on the viewer's own person session and ignores one owned by someone else", () => {
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        sessions: [{ ...PERSON_SESSION, ownerUserId: "user-2" }],
      },
    });
    renderTile();
    expect(screen.queryByTestId("simulator-toolbar")).toBeNull();
    cleanup();

    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [AGENT_SESSION, PERSON_SESSION] },
    });
    renderTile();
    expect(screen.getByTestId("simulator-toolbar")).toBeTruthy();
  });

  it("ends the person's session by its sessionId on close, though the palette sent the open", async () => {
    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [AGENT_SESSION, PERSON_SESSION] },
    });
    renderTile();
    await flush();
    // This tile sent no open: the palette did, before the tile was placed.
    expect(fakes.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("simulator-close"));

    expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledWith({
      epicId: EPIC,
      simulatorId: UDID,
      shutdown: false,
      sessionId: "session-person",
    });
  });

  it("waits for the handshake rather than reading an agent's session as the viewer's", async () => {
    // The registry's third state: no handshake has completed, so neither
    // version's session rule has been established for this host.
    fakes.negotiated = null;
    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [AGENT_SESSION] },
    });
    renderTile();

    expect(await screen.findByTestId("simulator-loading")).toBeTruthy();
    expect(screen.queryByTestId("simulator-toolbar")).toBeNull();
  });

  it("offers Connect for a still-running clone whose own session ended while an agent's remains", async () => {
    // A clone is never a device on a `@1.1` host: it exists only under its
    // source's `instances`, so a tile on one has no row of its own to find.
    const CLONE = "udid-1-clone-2";
    const cloneState: SimulatorState = {
      ...READY_STATE,
      simulators: READY_STATE.simulators.map((simulator) =>
        simulator.simulatorId === UDID
          ? {
              ...simulator,
              instances: [
                {
                  instanceKey: CLONE,
                  name: "iPhone 16 · 2",
                  booted: true,
                  cloneOf: UDID,
                  drivenByAgent: true,
                  keepRunning: false,
                  idleUntil: null,
                },
              ],
            }
          : simulator,
      ),
    };
    const onClone = (session: SimulatorSession): SimulatorSession => ({
      ...session,
      simulatorId: CLONE,
      instanceKey: CLONE,
    });
    fakes.sessions = sessions({
      state: { ...cloneState, sessions: [onClone(PERSON_SESSION)] },
    });
    const rerender = renderTileFor(
      makeSimulatorTileRef({
        hostId: HOST,
        simulatorId: CLONE,
        platform: "ios",
        name: "iPhone 16 · 2",
        instanceKey: null,
      }),
    );
    // Live first, so `wasLive` latches and the tile will not auto-attach when
    // it comes back - the state the person is left in.
    expect(await screen.findByTestId("simulator-toolbar")).toBeTruthy();

    // The person's session ends in another window; the agent's still holds it.
    fakes.sessions = sessions({
      state: { ...cloneState, sessions: [onClone(AGENT_SESSION)] },
    });
    rerender();

    const inventory = await screen.findByTestId("simulator-inventory");
    expect(inventory.textContent).not.toContain("no longer lists");
    expect(screen.getByTestId("simulator-connect").textContent).toContain(
      "Connect",
    );
  });

  it("offers Connect for a still-running Android clone, whose key is an AVD name and whose tile is a serial", async () => {
    // The same case on Android, where the two identifiers differ: the host
    // keys the clone by its AVD name and the tile carries the serial its
    // emulator runs on, so the key alone can never find the instance.
    fakes.sessions = sessions({
      state: { ...CLONE_STATE, sessions: [onClone(PERSON_SESSION)] },
    });
    const rerender = renderTileFor(
      makeSimulatorTileRef({
        hostId: HOST,
        simulatorId: CLONE_SERIAL,
        platform: "android",
        name: "Pixel_8_API_35 · 2",
        instanceKey: null,
      }),
    );
    expect(await screen.findByTestId("simulator-toolbar")).toBeTruthy();

    fakes.sessions = sessions({
      state: { ...CLONE_STATE, sessions: [onClone(AGENT_SESSION)] },
    });
    rerender();

    const inventory = await screen.findByTestId("simulator-inventory");
    expect(inventory.textContent).not.toContain("no longer lists");
    expect(screen.getByTestId("simulator-connect").textContent).toContain(
      "Connect",
    );

    // The agent's session ends too, so nothing in this task's `sessions` ties
    // the AVD-name key to the serial any more - and the clone is still booted,
    // kept running past its idle deadline. The host-wide read names the pair,
    // so the tile still offers Connect rather than calling the clone gone.
    fakes.hostInstances = [CLONE_HOST_WIDE];
    fakes.sessions = sessions({ state: { ...CLONE_STATE, sessions: [] } });
    rerender();

    const alone = await screen.findByTestId("simulator-inventory");
    expect(alone.textContent).not.toContain("no longer lists");
    expect(screen.getByTestId("simulator-connect").textContent).toContain(
      "Connect",
    );
  });

  it("waits for the host-wide read before a clone's tile named after its source attaches to that device", async () => {
    // Boot another on the source device names the clone's tile after THAT
    // device, so a tile restored with no session has only a device of the
    // same name to fall back to. Attaching to it would open a session on the
    // wrong simulator and place its serial's tile beside this one.
    fakes.hostInstancesAnswered = false;
    fakes.sessions = sessions({ state: CLONE_STATE });
    const rerender = renderTileFor(cloneTileNamedAfterSource());
    await flush();

    expect(fakes.open).not.toHaveBeenCalled();

    // Answered, naming the clone's key beside this tile's serial: now the
    // tile knows which instance it is and attaches to that one.
    fakes.hostInstancesAnswered = true;
    fakes.hostInstances = [CLONE_HOST_WIDE];
    rerender();
    await flush();

    expect(fakes.open).toHaveBeenCalledWith({
      epicId: EPIC,
      simulatorId: CLONE_SERIAL,
      platform: "android",
      boot: true,
    });
  });

  it("offers an exited clone's own tile its Boot and connect, off the instance the tile names", async () => {
    // The clone's emulator has exited: no session, and the host-wide read has
    // ANSWERED with nothing booted, so neither read ties its key to this
    // tile's serial any more and the AVD-name fallback is free to match the
    // source device. The tile recorded that pair when its open answered, and
    // the device rows still carry the clone's cold ledger row - so it is
    // resolved as the clone it is, not as the device it is named after.
    fakes.sessions = sessions({
      state: {
        ...CLONE_STATE,
        simulators: CLONE_STATE.simulators.map((simulator) =>
          simulator.simulatorId === SOURCE_SERIAL
            ? {
                ...simulator,
                instances: [
                  SOURCE_OWN_INSTANCE,
                  { ...CLONE_INSTANCE, booted: false },
                ],
              }
            : simulator,
        ),
      },
    });
    renderTileFor(cloneTileNamingItsInstance());
    await flush();

    const inventory = await screen.findByTestId("simulator-inventory");
    expect(inventory.textContent).not.toContain("no longer lists");
    expect(inventory.textContent).toContain("Pixel_8_API_35 · 2");
    expect(screen.getByTestId("simulator-connect").textContent).toContain(
      "Boot and connect",
    );
    expect(fakes.open).not.toHaveBeenCalled();
  });

  it("names a clone's instance from the host's own rows when no catalog record does", async () => {
    // The tile carries the source device's name, and the task catalog lists
    // nothing for the session - a pane that was never visible, a task host
    // too old to relay the catalog, the read's own first frame. The session
    // names its instance key, so the host's nested row answers for the
    // header instead of the name the tile was placed with.
    fakes.sessions = sessions({
      state: { ...CLONE_STATE, sessions: [onClone(PERSON_SESSION)] },
    });
    renderTileFor(cloneTileNamedAfterSource());

    const toolbar = await screen.findByTestId("simulator-toolbar");
    expect(toolbar.textContent).toContain("Pixel_8_API_35 · 2");
    expect(toolbar.textContent).toContain("Android 15.0");
    expect(within(toolbar).getByText("Agent")).toBeTruthy();
  });

  it("sends no power off while the session names no instance to power off", async () => {
    // `instanceKey` is a `@1.1` field, and the tile's own id is never read as
    // one: on Android it is the serial its emulator runs on, and only on iOS
    // does it happen to be the instance's key as well. So the control is
    // inert rather than asking to power off something it cannot name.
    const { instanceKey: _unnamed, ...noInstance } = onClone(PERSON_SESSION);
    fakes.sessions = sessions({
      state: { ...CLONE_STATE, sessions: [noInstance] },
    });
    renderTileFor(cloneTileNamedAfterSource());

    expect(await screen.findByTestId("simulator-toolbar")).toBeTruthy();
    fireEvent.click(screen.getByTestId("simulator-power-off"));
    await flush();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fakes.powerOff).not.toHaveBeenCalled();
  });

  it("asks before powering off, names what it reaches, then sends simulator.powerOff by instance key", async () => {
    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [PERSON_SESSION] },
    });
    fakes.powerOff.mockResolvedValueOnce({
      kind: "powered-off",
      instanceKey: UDID,
    });
    renderTile();

    fireEvent.click(screen.getByTestId("simulator-power-off"));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("ends every task's session on it");
    expect(dialog.textContent).toContain("A copy is deleted");
    expect(fakes.powerOff).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Power off" }));

    await waitFor(() => {
      expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    });
    expect(fakes.powerOff).toHaveBeenCalledWith({
      instanceKey: UDID,
      confirm: false,
    });
    expect(fakes.shutdown).not.toHaveBeenCalled();
  });

  it("asks a second time when the host answers confirm-required, and sends confirm: true only once the person agrees again", async () => {
    fakes.sessions = sessions({
      state: { ...READY_STATE, sessions: [PERSON_SESSION] },
    });
    fakes.powerOff
      .mockResolvedValueOnce({ kind: "confirm-required", instanceKey: UDID })
      .mockResolvedValueOnce({ kind: "powered-off", instanceKey: UDID });
    renderTile();

    fireEvent.click(screen.getByTestId("simulator-power-off"));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Power off",
      }),
    );

    await waitFor(() => {
      expect(fakes.powerOff).toHaveBeenCalledTimes(1);
    });
    // The host's own refusal raises the agent question, which the tile's
    // confirm does not answer.
    const agentDialog = await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("An agent is using it right now");
      return dialog;
    });
    expect(fakes.closeTile).not.toHaveBeenCalled();

    fireEvent.click(
      within(agentDialog).getByRole("button", { name: "Power off" }),
    );

    await waitFor(() => {
      expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    });
    expect(fakes.powerOff).toHaveBeenNthCalledWith(2, {
      instanceKey: UDID,
      confirm: true,
    });
  });
});
