// `HostRestartSessions` reads its agent list from `useFocusModel()` and its
// terminal list from the terminal-session registry, and both hooks pull in a
// wide dependency tree (agent-activity/notification/auth stores; a live host
// stream for the registry's own hostId bookkeeping) that has nothing to do
// with what this component itself decides. Both are mocked at their own leaf
// modules - the same boundary `local-host-restart-flow.test.tsx` and
// `host-update-banner-bound.test.tsx` already use for `useFocusModel` and the
// registry's directory/client hooks. `useEpicCanvasStore` (real, seeded via
// `setState`) and terminal session STORES (real, built with
// `createTerminalSessionStore` and driven via direct `setState`, never a live
// stream) are exercised for real: they are this component's own state, not an
// external boundary.
type NavigateFn = (...args: unknown[]) => unknown;
const navigateMock = vi.hoisted((): Mock<NavigateFn> => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

type OpenTileFn = (intent: TileOpenIntent) => NestedFocusTarget | null;
const openTileMock = vi.hoisted((): { current: Mock<OpenTileFn> } => ({
  current: vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTile: (intent: TileOpenIntent) => openTileMock.current(intent),
  }),
}));

const focusModelMock = vi.hoisted((): { current: FocusModel | null } => ({
  current: null,
}));
vi.mock("@/hooks/home-focus/use-focus-model", () => ({
  useFocusModel: () => focusModelMock.current,
}));

type RouteNotificationForHostFn = (
  navigate: NavigateFn,
  payload: NotificationPayload,
  receivedAt: number,
  context: NotificationHostRouteContext,
) => boolean;
const routeNotificationForHostMock = vi.hoisted(
  (): { current: Mock<RouteNotificationForHostFn> } => ({
    current: vi.fn(),
  }),
);
vi.mock("@/lib/notifications", () => ({
  routeNotificationForHost: (
    navigate: NavigateFn,
    payload: NotificationPayload,
    receivedAt: number,
    context: NotificationHostRouteContext,
  ) =>
    routeNotificationForHostMock.current(
      navigate,
      payload,
      receivedAt,
      context,
    ),
}));

type GetHandleHostIdFn = (handle: TerminalSessionStoreHandle) => string | null;
const hostIdByHandle = vi.hoisted(
  (): { current: WeakMap<TerminalSessionStoreHandle, string | null> } => ({
    current: new WeakMap(),
  }),
);
const registryHandles = vi.hoisted(
  (): { current: ReadonlyArray<TerminalSessionStoreHandle> } => ({
    current: [],
  }),
);
const getTerminalSessionHandleHostIdMock: GetHandleHostIdFn = (handle) =>
  hostIdByHandle.current.get(handle) ?? null;
vi.mock("@/lib/registries/terminal-session-registry", () => ({
  getTerminalSessionRegistry: () => ({
    listHandles: () => registryHandles.current,
    subscribe: () => () => undefined,
  }),
  getTerminalSessionHandleHostId: (handle: TerminalSessionStoreHandle) =>
    getTerminalSessionHandleHostIdMock(handle),
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { HostRestartSessions } from "@/components/host/host-restart-sessions";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import type {
  FocusAgentRow,
  FocusModel,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";
import { EMPTY_FOCUS_MODEL } from "@/lib/home-focus/build-focus-model";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import type { NotificationPayload } from "@/lib/notifications";
import type { NotificationHostRouteContext } from "@/lib/notifications/payload";

// Baseline for every test, not only the `afterEach` reset below: the very
// first test in this file runs before any reset has fired, and
// `vi.hoisted()`'s factory above cannot reference this import (it executes
// before imports are linked), so `focusModelMock.current` starts `null`.
focusModelMock.current = EMPTY_FOCUS_MODEL;

const OPENED_TARGET: NestedFocusTarget = {
  paneId: "pane-1",
  tileInstanceId: "inst-opened",
};

const HOST_ID = "host-a";
const OTHER_HOST_ID = "host-b";

function agentRow(
  overrides: Partial<FocusAgentRow> & { readonly agentId: string },
): FocusAgentRow {
  return {
    title: null,
    surface: "chat",
    tier: "turn",
    parentId: null,
    hostId: null,
    hostUnattributed: false,
    stoppable: true,
    ...overrides,
  };
}

function taskRow(
  epicId: string,
  agents: ReadonlyArray<FocusAgentRow>,
): FocusTaskRow {
  return {
    epicId,
    taskTitle: null,
    mountedHere: true,
    agents,
    needsYou: false,
    stoppable: true,
  };
}

function setFocusModel(tasks: ReadonlyArray<FocusTaskRow>): void {
  focusModelMock.current = { ...EMPTY_FOCUS_MODEL, tasks } satisfies FocusModel;
}

let nextInstanceId = 0;
const createdHandles: TerminalSessionStoreHandle[] = [];

/**
 * A real terminal session store (real Zustand internals), never touched by a
 * live stream - `streamClientFactory` is never invoked because nothing here
 * calls a method that opens one. Lifecycle fields are set directly with
 * `store.setState` instead, which is what lets a test pin an exact
 * (kind, status, scope) combination without driving a fake socket through it.
 */
function makeTerminalHandle(opts: {
  readonly epicId: string;
  readonly sessionId: string;
  readonly registryHostId: string | null;
  readonly kind?: "terminal" | "terminal-agent";
  readonly status?: "creating" | "running" | "exited" | "lost" | "reaped";
  readonly scopeKind?: "epic" | "independent";
  readonly title?: string | null;
}): TerminalSessionStoreHandle {
  const scopeKind = opts.scopeKind ?? "epic";
  const handle = createTerminalSessionStore({
    scope:
      scopeKind === "independent"
        ? { kind: "independent" }
        : { kind: "epic", epicId: opts.epicId },
    sessionId: opts.sessionId,
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind: opts.kind ?? "terminal",
    streamClientFactory: () => ({
      sendAction: () => undefined,
      close: () => undefined,
    }),
  });
  handle.store.setState({
    status: opts.status ?? "running",
    kind: opts.kind ?? "terminal",
    title: opts.title ?? null,
  });
  hostIdByHandle.current.set(handle, opts.registryHostId);
  createdHandles.push(handle);
  return handle;
}

/** Registers a matching open tile for a terminal handle - the thing that has
 * to exist for `RunningTerminal` to render anything at all, on top of every
 * eligibility check passing. */
function seedTileForHandle(
  handle: TerminalSessionStoreHandle,
  opts: { readonly hostId: string; readonly tabId?: string },
): void {
  if (handle.scope.kind !== "epic") {
    throw new Error("seedTileForHandle requires an epic-scoped handle");
  }
  const tabId = opts.tabId ?? `tab-${handle.scope.epicId}`;
  const instanceId = `inst-${nextInstanceId}`;
  nextInstanceId += 1;
  const store = useEpicCanvasStore.getState();
  useEpicCanvasStore.setState({
    tabsById: {
      ...store.tabsById,
      [tabId]: { tabId, epicId: handle.scope.epicId, name: "Epic" },
    },
    canvasByTabId: {
      ...store.canvasByTabId,
      [tabId]: {
        root: null,
        activePaneId: null,
        sizesByGroupId: {},
        tilesByInstanceId: {
          ...store.canvasByTabId[tabId]?.tilesByInstanceId,
          [instanceId]: {
            id: handle.sessionId,
            instanceId,
            type: "terminal",
            name: "Shell",
            titleSource: "default",
            hostId: opts.hostId,
            cwd: "/repo",
          },
        },
      },
    },
  });
}

function renderSessions(overrides: {
  readonly hostId?: string;
  readonly disabled?: boolean;
  readonly onNavigate?: () => void;
}): { readonly onNavigate: Mock<() => void> } {
  const onNavigate = vi.fn();
  render(
    <HostRestartSessions
      hostId={overrides.hostId ?? HOST_ID}
      disabled={overrides.disabled ?? false}
      onNavigate={overrides.onNavigate ?? onNavigate}
    />,
  );
  return { onNavigate };
}

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  focusModelMock.current = EMPTY_FOCUS_MODEL;
  registryHandles.current = [];
  hostIdByHandle.current = new WeakMap();
  openTileMock.current = vi.fn(() => null);
  routeNotificationForHostMock.current = vi.fn(() => true);
  navigateMock.mockClear();
  for (const handle of createdHandles.splice(0)) {
    handle.dispose();
  }
});

describe("HostRestartSessions — agents", () => {
  it("renders only agents whose hostId matches the host being restarted", () => {
    setFocusModel([
      taskRow("epic-a", [
        agentRow({ agentId: "agent-1", hostId: HOST_ID, title: "Agent One" }),
        agentRow({
          agentId: "agent-2",
          hostId: OTHER_HOST_ID,
          title: "Agent Two",
        }),
      ]),
    ]);
    renderSessions({});

    expect(screen.getByRole("button", { name: "Agent One" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Agent Two" })).toBeNull();
  });

  it("falls back to the agent id when no title is known", () => {
    setFocusModel([
      taskRow("epic-a", [
        agentRow({ agentId: "agent-untitled", hostId: HOST_ID, title: null }),
      ]),
    ]);
    renderSessions({});

    expect(
      screen.getByRole("button", { name: "agent-untitled" }),
    ).not.toBeNull();
  });

  it("routes and calls onNavigate when the notification route reports success", () => {
    routeNotificationForHostMock.current = vi.fn(() => true);
    setFocusModel([
      taskRow("epic-a", [
        agentRow({ agentId: "agent-1", hostId: HOST_ID, title: "Agent One" }),
      ]),
    ]);
    const { onNavigate } = renderSessions({});

    fireEvent.click(screen.getByRole("button", { name: "Agent One" }));

    expect(routeNotificationForHostMock.current).toHaveBeenCalledWith(
      navigateMock,
      { kind: "chat", epicId: "epic-a", chatId: "agent-1" },
      expect.any(Number),
      { originHostId: HOST_ID, effectiveHostId: HOST_ID },
    );
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not call onNavigate when the notification route reports failure", () => {
    routeNotificationForHostMock.current = vi.fn(() => false);
    setFocusModel([
      taskRow("epic-a", [
        agentRow({ agentId: "agent-1", hostId: HOST_ID, title: "Agent One" }),
      ]),
    ]);
    const { onNavigate } = renderSessions({});

    fireEvent.click(screen.getByRole("button", { name: "Agent One" }));

    expect(routeNotificationForHostMock.current).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("disables agent links and they do not dispatch on click", () => {
    setFocusModel([
      taskRow("epic-a", [
        agentRow({ agentId: "agent-1", hostId: HOST_ID, title: "Agent One" }),
      ]),
    ]);
    const { onNavigate } = renderSessions({ disabled: true });

    const button = screen.getByRole("button", { name: "Agent One" });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.click(button);
    expect(routeNotificationForHostMock.current).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("HostRestartSessions — terminal eligibility", () => {
  it("excludes a terminal the registry attributes to a different host", () => {
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: OTHER_HOST_ID,
      title: "My Shell",
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    renderSessions({});

    expect(screen.queryByRole("button", { name: "My Shell" })).toBeNull();
  });

  it("excludes a non-terminal session kind (terminal-agent)", () => {
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      kind: "terminal-agent",
      title: "My Shell",
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    renderSessions({});

    expect(screen.queryByRole("button", { name: "My Shell" })).toBeNull();
  });

  it("excludes a terminal that is not running", () => {
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      status: "exited",
      title: "My Shell",
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    renderSessions({});

    expect(screen.queryByRole("button", { name: "My Shell" })).toBeNull();
  });

  it("excludes a terminal scoped outside an epic (independent scope)", () => {
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      scopeKind: "independent",
      title: "My Shell",
    });
    registryHandles.current = [handle];

    renderSessions({});

    expect(screen.queryByRole("button", { name: "My Shell" })).toBeNull();
  });

  it("excludes an otherwise-eligible terminal with no matching open tile (a warm handle)", () => {
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      title: "My Shell",
    });
    // Deliberately NOT calling seedTileForHandle: this handle is warm
    // (registered, running) but no canvas tile currently backs it.
    registryHandles.current = [handle];

    renderSessions({});

    expect(screen.queryByRole("button", { name: "My Shell" })).toBeNull();
  });

  it("renders an eligible terminal with a matching open tile", () => {
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      title: "My Shell",
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    renderSessions({});

    expect(screen.getByRole("button", { name: "My Shell" })).not.toBeNull();
  });

  it("falls back to 'Terminal <sessionId>' when the terminal has no title", () => {
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-untitled",
      registryHostId: HOST_ID,
      title: null,
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    renderSessions({});

    expect(
      screen.getByRole("button", { name: "Terminal term-untitled" }),
    ).not.toBeNull();
  });
});

describe("HostRestartSessions — terminal navigation", () => {
  it("opens the tile and calls onNavigate when openTile resolves a target", () => {
    openTileMock.current = vi.fn(() => OPENED_TARGET);
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      title: "My Shell",
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    const { onNavigate } = renderSessions({});
    fireEvent.click(screen.getByRole("button", { name: "My Shell" }));

    expect(openTileMock.current).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not call onNavigate when openTile returns null", () => {
    openTileMock.current = vi.fn(() => null);
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      title: "My Shell",
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    const { onNavigate } = renderSessions({});
    fireEvent.click(screen.getByRole("button", { name: "My Shell" }));

    expect(openTileMock.current).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("disables terminal links and they do not dispatch on click", () => {
    openTileMock.current = vi.fn(() => OPENED_TARGET);
    const handle = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      title: "My Shell",
    });
    seedTileForHandle(handle, { hostId: HOST_ID });
    registryHandles.current = [handle];

    const { onNavigate } = renderSessions({ disabled: true });
    const button = screen.getByRole("button", { name: "My Shell" });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.click(button);
    expect(openTileMock.current).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("HostRestartSessions — terminal dedup", () => {
  it("collapses two handles that share the same epicId and sessionId into one row", () => {
    const first = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      title: "My Shell",
    });
    const second = makeTerminalHandle({
      epicId: "epic-a",
      sessionId: "term-1",
      registryHostId: HOST_ID,
      title: "My Shell",
    });
    seedTileForHandle(first, { hostId: HOST_ID });
    registryHandles.current = [first, second];

    renderSessions({});

    expect(screen.getAllByRole("button", { name: "My Shell" })).toHaveLength(1);
  });

  it("regression: a same-sessionId warm handle from a DIFFERENT, tile-less epic does not hide a later handle from an epic that HAS a valid tile", () => {
    // Handle A: epic-warm, no backing tile (the "warm handle" case) - would
    // previously have been the one and only entry a sessionId-only Set kept,
    // hiding B behind it even though B is the one that can actually render.
    const warm = makeTerminalHandle({
      epicId: "epic-warm",
      sessionId: "shared-session",
      registryHostId: HOST_ID,
      title: "Warm Shell",
    });
    // Handle B: a DIFFERENT epic, same sessionId, WITH a valid tile.
    const live = makeTerminalHandle({
      epicId: "epic-live",
      sessionId: "shared-session",
      registryHostId: HOST_ID,
      title: "Live Shell",
    });
    seedTileForHandle(live, { hostId: HOST_ID });
    // Warm handle listed FIRST, exactly the ordering that broke the old
    // sessionId-only `Set<string>` dedup.
    registryHandles.current = [warm, live];

    renderSessions({});

    // The warm handle renders nothing (no tile) - not because it was
    // deduped away, but because RunningTerminal itself finds no tile.
    expect(screen.queryByRole("button", { name: "Warm Shell" })).toBeNull();
    // The live handle, in a DIFFERENT epic, must still display.
    expect(screen.getByRole("button", { name: "Live Shell" })).not.toBeNull();
  });
});
