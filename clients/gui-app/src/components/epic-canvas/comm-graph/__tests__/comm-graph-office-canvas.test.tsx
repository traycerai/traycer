const registerFindAdapterMock = vi.hoisted(() =>
  vi.fn<(adapter: TileFindAdapter) => void>(),
);

vi.mock("@/components/epic-canvas/tile-find/tile-find-adapter-context", () => ({
  useRegisterTileFindAdapter: registerFindAdapterMock,
}));

// The floor signs resolve host display names through the host directory, which
// is a Query like every other host read - so this suite needs the provider and
// an inert binding, the same pair the other comm-graph suites install.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
}));

// A plain constant here would make a theme flip untestable: the render loop's
// effect depends on `resolvedTheme`, and proving a flip restarts it exactly
// once needs a mock a test can change and then re-render against. `light` is
// the default every other suite in this file was written assuming.
const resolvedThemeMock = vi.hoisted(() => ({
  current: "light" as "light" | "dark",
}));

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: resolvedThemeMock.current,
    themePreset: "default",
  }),
}));

// `useEpicAgentActivityTiers` resolves the open-epic session handle, which this
// suite has no use for: the office statuses it feeds are covered in
// `lib/comm-graph/office/__tests__/office-status.test.ts`. PARTIAL, because the
// detail panel this suite opens reaches other selectors in the same module.
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  /**
   * ONE INSTANCE EACH, FOR THE LIFE OF THE MODULE - and that is load-bearing,
   * not tidiness.
   *
   * Returning `new Map()` / `{}` per call handed the canvas a fresh identity on
   * every render. Two effects push these at the runtime and then ask for a
   * frame because nothing else would - role claims at `:2239`, scene input at
   * `:2532` - so ANY re-render of the canvas, for any reason at all, quietly
   * invalidated the frame gate. A case that then changed some unrelated state
   * and watched the floor repaint was reading the mock, not the product.
   *
   * That is exactly how the idle-repaint bug hid: a theme change re-renders
   * this component, the churn asked for a frame, and the office looked like it
   * repainted itself. Production does no such thing - the real activity tiers
   * are a cached empty singleton and the real role claims are stable - so the
   * mock has to be stable too or every frame-gate case here is false
   * confidence.
   */
  const activityTiers = new Map();
  const roleClaims = {};
  return {
    ...actual,
    useEpicAgentActivityTiers: () => activityTiers,
    // The office reads every agent's role claims in one bulk selector for the
    // door plates; like the activity tiers above, it resolves an epic session
    // this suite deliberately renders without.
    useEpicAgentRoleClaimsByAgentId: () => roleClaims,
    // The hover card resolves these per-agent, the same way the graph node
    // does - and this suite renders no `EpicSessionProvider` for the real
    // selector to read through.
    useEpicNodeHostId: () => "host-1",
    useEpicNodeOwnerKind: () => "chat",
  };
});

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable" }),
}));

// The shared tooltip pulls in the worktree/PR machinery through its OWN
// deps, none of which this suite provides - and F6 only needs the TRIGGER
// (the transparent hit target the double-click lands on) live in the tree,
// not the card's contents. Passing the trigger straight through keeps that
// element real while skipping everything downstream of it.
vi.mock("@/components/epic-canvas/sidebar/agent-hover-tooltip", () => ({
  AgentHoverTooltip: (props: { readonly trigger: ReactNode }) => props.trigger,
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { cloneElement, type ReactNode } from "react";
import { CommGraphOfficeCanvas } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import { OfficeAutoChip } from "@/components/epic-canvas/comm-graph/office/office-auto-chip";
import type { OfficeAutoDecision } from "@/lib/comm-graph/office/office-auto";
import { useCommGraphTimelineStore } from "@/stores/epics/comm-graph-timeline-store";
import {
  commGraphPairId,
  type CommGraphAgentNode,
} from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import type { OfficeView } from "@/lib/comm-graph/office/views/office-view";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { BASE_STEP_MS } from "@/components/epic-canvas/comm-graph/use-comm-graph-transport";
import { OFFICE_FRAME_INTERVAL_MS } from "@/components/epic-canvas/comm-graph/office/office-frame-gate";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { officeModelTier } from "@/lib/comm-graph/office/office-model-tier";
import {
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeFloor,
  type OfficeHitRegion,
  type OfficeLayout,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSign,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import type { TileFindAdapter } from "@/stores/tile-find";
import type { CommGraphOfficeCanvasProps } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import { OfficeDirectoryPanel } from "@/components/epic-canvas/comm-graph/office/office-directory-panel";
import { OfficeStaticLayer } from "@/components/epic-canvas/comm-graph/office/office-static-layer";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";

const OFFICE_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
  mode: "office",
  officeView: null,
  officeAutoView: null,
  officeCameraView: null,
};

/** Large enough to hold this suite's fixtures with room to spare. */
const WHOLE_WORLD: OfficeRect = { x: 0, y: 0, width: 4000, height: 4000 };

/**
 * A controllable stand-in for the real `IntersectionObserver`, which jsdom
 * does not implement at all - the harness's own `MockIntersectionObserver`
 * (`__tests__/test-browser-apis.ts`) never fires, so left in place the office
 * canvas would be permanently ineligible and every case that reaches its
 * scene would be untestable. `observe`/`unobserve` are no-ops on purpose:
 * this suite drives visibility by calling the registered callbacks directly,
 * not by tracking which element was observed.
 */
type ObserverEntryLike = { readonly isIntersecting: boolean };
type ObserverCallback = (entries: ReadonlyArray<ObserverEntryLike>) => void;
let activeObserverCallbacks: Array<ObserverCallback> = [];

class ControllableIntersectionObserver {
  private readonly callback: ObserverCallback;
  constructor(callback: ObserverCallback) {
    this.callback = callback;
    activeObserverCallbacks.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    activeObserverCallbacks = activeObserverCallbacks.filter(
      (registered) => registered !== this.callback,
    );
  }
  takeRecords(): ReadonlyArray<ObserverEntryLike> {
    return [];
  }
}

/** Reports intersection to every office canvas currently observing. */
function setIntersecting(value: boolean): void {
  act(() => {
    for (const callback of activeObserverCallbacks) {
      callback([{ isIntersecting: value }]);
    }
  });
}

beforeEach(() => {
  activeObserverCallbacks = [];
  vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
  resolvedThemeMock.current = "light";
});

function agent(id: string, name: string): CommGraphAgentNode {
  return {
    id,
    kind: "chat",
    name,
    hostId: "host-1",
    parentId: null,
    harnessId: null,
    model: null,
    archived: false,
    archivedAt: null,
    createdAt: 1,
  };
}

const ORCHESTRATOR = agent("agent-1", "Orchestrator");
const REVIEWER = agent("agent-2", "Reviewer");
/** Never part of the default fixture's agents; opted into by name via `agents`. */
const OFFSCREEN = agent("agent-3", "Offscreen scout");
/**
 * A second host with two agents rather than one: a lone root on a host
 * settles as that host's HQ - never listed in the directory regardless of
 * visibility - so exercising the visible-set filter on a REAL solo row needs
 * a lead (the HQ) and a member under it (the solo the filter actually acts
 * on).
 */
const HOST_B_LEAD: CommGraphAgentNode = {
  ...agent("agent-4", "Bay lead"),
  hostId: "host-2",
};
const HOST_B_MEMBER: CommGraphAgentNode = {
  ...agent("agent-5", "Bay member"),
  hostId: "host-2",
  parentId: HOST_B_LEAD.id,
};
/**
 * A THIRD host, kept fully visible: with only host-1 and a dropped host-2,
 * a single surviving section renders no heading at all ("one host needs no
 * header"), which would make host-1's own heading absent too and undercut
 * "host-2 is missing" as a claim about FILTERING rather than about there
 * only ever being one section. A second surviving section is what makes
 * host-1's heading a real positive control.
 */
const HOST_C_LEAD: CommGraphAgentNode = {
  ...agent("agent-6", "Dock lead"),
  hostId: "host-3",
};
const HOST_C_MEMBER: CommGraphAgentNode = {
  ...agent("agent-7", "Dock member"),
  hostId: "host-3",
  parentId: HOST_C_LEAD.id,
};

interface OfficeRenderOptions {
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly pulse: CommGraphPulse | null;
  readonly pulseKey: string | null;
  readonly playing?: boolean;
}

const STATIC_OFFICE: OfficeRenderOptions = {
  events: [],
  pulse: null,
  pulseKey: null,
};

function officeElement(
  visibleIds: ReadonlySet<string>,
  options: OfficeRenderOptions,
  overrides: Partial<CommGraphOfficeCanvasProps>,
) {
  return (
    <CommGraphOfficeCanvas
      epicId="epic-1"
      tileInstanceId="comm-graph-instance-1"
      agents={[ORCHESTRATOR, REVIEWER]}
      agentIds={visibleIds}
      events={options.events}
      hosts={[]}
      initialHistoryCaughtUp={false}
      playing={options.playing ?? false}
      pulse={options.pulse}
      pulseKey={options.pulseKey}
      modeToggle={null}
      view={OFFICE_VIEW}
      officeView={OFFICE_VIEWS.floor}
      // The tile has settled which view this is; these cases are about the
      // canvas, not about Auto still deciding what to hand it.
      ready
      onAutoProbe={vi.fn()}
      viewPicker={null}
      autoChip={null}
      onCameraChange={vi.fn()}
      canOpenAgentForEvent={() => true}
      canJump={() => false}
      onJump={vi.fn()}
      canJumpToSender={() => false}
      onJumpToSender={vi.fn()}
      canJumpToCreated={() => false}
      onJumpToCreated={vi.fn()}
      onOpenAgent={vi.fn()}
      {...overrides}
    />
  );
}

function renderOffice(visibleIds: ReadonlySet<string>) {
  return render(withQueryClient(officeElement(visibleIds, STATIC_OFFICE, {})));
}

/** Stubs the office canvas container's measured box and re-triggers the resize path that reads it. */
function setCanvasSize(size: { width: number; height: number }): void {
  const container = screen.getByTestId("comm-graph-office-canvas");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect(size),
  );
  fireEvent(window, new Event("resize"));
}

/**
 * What the scene ACTUALLY framed, read back through a type guard.
 *
 * A `vi.spyOn` records its calls as `any`, and these frames are read field by
 * field, which the repo's type rules refuse. Guarding at the boundary keeps
 * every read typed without a cast and without wrapping the real method - which
 * would mean referencing an unbound prototype method to call through to.
 */
interface SpiedCalls {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}

interface SpiedResults {
  readonly mock: {
    readonly results: ReadonlyArray<{ readonly value: unknown }>;
  };
}

function isOfficeRect(value: unknown): value is OfficeRect {
  if (typeof value !== "object" || value === null) return false;
  if (!("x" in value && "y" in value)) return false;
  if (!("width" in value && "height" in value)) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function isHitRegion(value: unknown): value is OfficeHitRegion {
  if (typeof value !== "object" || value === null) return false;
  if (!("agentId" in value && "rect" in value)) return false;
  return typeof value.agentId === "string" && isOfficeRect(value.rect);
}

/** The world rect of the most recent frame, or `null` if none was drawn. */
function lastFramedRect(spy: SpiedCalls): OfficeRect | null {
  const view = spy.mock.calls.at(-1)?.[1];
  return isOfficeRect(view) ? view : null;
}

/** The hit regions of the most recent frame, empty if none was drawn. */
function lastHitRegions(spy: SpiedResults): ReadonlyArray<OfficeHitRegion> {
  const frame = spy.mock.results.at(-1)?.value;
  if (typeof frame !== "object" || frame === null) return [];
  if (!("hitRegions" in frame)) return [];
  const regions = frame.hitRegions;
  if (!Array.isArray(regions)) return [];
  // Built by hand rather than `.filter`: `Array.isArray` narrows to `any[]`,
  // whose `filter` would hand back `any[]` however well the guard is typed.
  const hits: OfficeHitRegion[] = [];
  for (const region of regions) {
    if (isHitRegion(region)) hits.push(region);
  }
  return hits;
}

function withQueryClient(children: ReactNode) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

const PAIR_EDGE_ID = commGraphPairId(ORCHESTRATOR.id, REVIEWER.id);

const REQUEST_EVENT: CommGraphEvent = {
  id: 1,
  timestamp: 10,
  hostId: "host-1",
  kind: "a2a_message",
  senderAgentId: ORCHESTRATOR.id,
  receiverAgentId: REVIEWER.id,
  responseId: "r1",
  inReplyTo: null,
  expectReply: false,
  messageText: "take a look",
  noticeReason: null,
  originKind: null,
  originChatId: null,
  originRefId: null,
};

const REQUEST_PULSE: CommGraphPulse = {
  kind: "edge",
  edgeId: PAIR_EDGE_ID,
  pulseKind: "request",
  fromAgentId: ORCHESTRATOR.id,
  toAgentId: REVIEWER.id,
};

const IN_FLIGHT: OfficeRenderOptions = {
  events: [REQUEST_EVENT],
  pulse: REQUEST_PULSE,
  pulseKey: "row-1",
};

function officeAgentInput(agent: CommGraphAgentNode): OfficeAgentInput {
  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    hostId: agent.hostId,
    archivedAt: agent.archivedAt,
    modelTier: officeModelTier(agent.model),
    harnessId: agent.harnessId,
    model: agent.model,
    parentId: agent.parentId,
    archived: agent.archived,
    createdAt: agent.createdAt,
    appearance: agentAppearance(agent.id, agent.kind, agent.harnessId),
  };
}

/**
 * Where the envelope for {@link IN_FLIGHT} sits, from a scene built the same
 * way the canvas builds its own and fed the same two syncs.
 *
 * Reading the component's own scene is not possible and re-deriving the
 * geometry by hand would be a second implementation of it. The scene is pure
 * and deterministic by construction - same agents, same input, same box - so a
 * parallel instance answers the identical question, and if that ever stopped
 * being true this test failing is the correct outcome.
 */
function envelopeRect(visibleIds: ReadonlySet<string>): OfficeRect {
  const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
  const agents = [ORCHESTRATOR, REVIEWER].map(officeAgentInput);
  const statusById = new Map<string, OfficeAgentStatus>();
  const base: OfficeSceneInput = {
    agents,
    visibleAgentIds: visibleIds,
    statusById,
    partition: partitionOfficePopulation({
      agents,
      statusById,
      previous: null,
    }),
    activityById: new Map(),
    // The component stamps `runtime.getViewport()` at sync time, and jsdom's
    // `getBoundingClientRect()` is all zeros - so a parallel scene fed
    // anything else would be answering a different question. Nothing
    // re-plans on viewport, so this only matters for staying identical.
    viewport: { width: 0, height: 0 },
    pulse: null,
    pulseKey: null,
    // The component's own value at the speed this suite runs (1x), so the
    // parallel scene stays the identical question if the base step changes.
    stepMs: BASE_STEP_MS / 1,
    cursorMs: null,
    clockMs: 0,
    openRequestsByReceiver: new Map(),
    playing: false,
    reducedMotion: false,
  };
  // The first sync MATERIALIZES the floor and never replays its row, so the
  // envelope only exists after a second sync carrying a new key - exactly the
  // sequence the canvas performs across the two renders below.
  scene.sync(base);
  scene.sync({ ...base, pulse: REQUEST_PULSE, pulseKey: "row-1" });
  const regions = scene.frame(2, WHOLE_WORLD).envelopeHitRegions;
  if (regions.length === 0) throw new Error("No envelope was in flight");
  return regions[0].rect;
}

function latestFindAdapter(): TileFindAdapter {
  const adapter = registerFindAdapterMock.mock.lastCall?.[0];
  if (adapter === undefined) throw new Error("Find adapter was not registered");
  return adapter;
}

/** `makeTestEpic`'s agents are `OfficeAgentInput`; the canvas takes the projection's own node shape. */
function canvasAgent(agent: OfficeAgentInput): CommGraphAgentNode {
  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    hostId: agent.hostId,
    parentId: agent.parentId,
    harnessId: agent.harnessId,
    model: agent.model,
    archived: agent.archived,
    archivedAt: agent.archivedAt,
    createdAt: agent.createdAt,
  };
}

/**
 * A real 2d context (recording nothing usable, but not throwing) plus a
 * controllable `requestAnimationFrame`, so the frame loop actually RUNS in
 * jsdom instead of being permanently gated off by `get2dContext`'s null. This
 * is what lets a case observe the camera and the frame it produces rather
 * than only the calls made on the way there - `scene.locate` was called is a
 * weaker claim than "the agent it names is now inside the frame".
 */
function installCanvas(): { readonly step: () => void } {
  const noop = () => undefined;
  // The proxy is typed at its SOURCE rather than asserted onto afterwards: a
  // literal carrying three of this interface's hundred-odd members does not
  // overlap it enough for a single assertion, and widening through `unknown`
  // to get there is exactly what the type rules forbid. Everything the
  // painter reaches for that is not answered here is a no-op.
  const blank = {} as CanvasRenderingContext2D;
  const face = { font: "10px monospace", letterSpacing: "0px" };
  const context = new Proxy(blank, {
    get: (_target, key): unknown => {
      if (key === "measureText") {
        return (text: string) => ({
          width: modelledTextWidth(text, face.font, face.letterSpacing),
        });
      }
      if (key === "createImageData") {
        return (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        });
      }
      return noop;
    },
    set: (_target, key, value): boolean => {
      // The face is the one thing this proxy has to REMEMBER rather than
      // discard: `measureText` answers in whatever the caller just set.
      if (key === "font" && typeof value === "string") face.font = value;
      if (key === "letterSpacing" && typeof value === "string") {
        face.letterSpacing = value;
      }
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 1040, 700),
  );
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextId += 1;
    callbacks.set(nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  let now = performance.now();
  return {
    step: () =>
      act(() => {
        now += 100;
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback(now);
      }),
  };
}

afterEach(() => {
  cleanup();
  registerFindAdapterMock.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useCommGraphTimelineStore.setState({ stateByEpicId: {} });
});

/**
 * jsdom has no 2d canvas context, so nothing here can assert a pixel. That is
 * deliberate rather than a gap being tolerated: the drawing is a pure function
 * of the frame (covered where the frame is built, in the scene's own suite),
 * while what a person can DO with the floor - reach an agent, open it, and not
 * lose the surface when there is no context at all - is exactly what survives
 * the missing context and is asserted below.
 */
describe("CommGraphOfficeCanvas", () => {
  it("renders the floor without a 2d context instead of throwing", () => {
    const result = renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    expect(result.getByTestId("comm-graph-office-canvas")).toBeDefined();
    expect(
      screen.getByRole("img", {
        name: "Office view of the communication graph",
      }),
    ).toBeDefined();
  });

  it("exposes one accessible control per agent that exists as of the cursor", () => {
    // The second agent has not been revealed by the cursor yet, so it has no
    // character on the floor and must have no way to be opened either.
    renderOffice(new Set([ORCHESTRATOR.id]));

    expect(
      screen.getByTestId(`comm-graph-office-agent-${ORCHESTRATOR.id}`)
        .textContent,
    ).toBe("Orchestrator");
    expect(
      screen.queryByTestId(`comm-graph-office-agent-${REVIEWER.id}`),
    ).toBeNull();
  });

  it("opens the agent's activity panel from the accessible control", () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));
    expect(screen.queryByTestId("comm-graph-agent-panel")).toBeNull();

    fireEvent.click(
      screen.getByTestId(`comm-graph-office-agent-${REVIEWER.id}`),
    );

    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
    // The panel names the agent that was clicked, not merely "an" agent.
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);
  });

  it("closes the detail panel when its agent drops out of the as-of visible set", () => {
    const both = new Set([ORCHESTRATOR.id, REVIEWER.id]);
    const view = render(
      withQueryClient(officeElement(both, STATIC_OFFICE, {})),
    );

    fireEvent.click(
      screen.getByTestId(`comm-graph-office-agent-${REVIEWER.id}`),
    );
    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);

    // The cursor moves back before Reviewer existed: it drops out of
    // agentIds, so the surface is handed the as-of set rather than the full
    // present-day roster.
    view.rerender(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {}),
      ),
    );

    // The panel's own selection is still Reviewer's id, but that id is no
    // longer among the agents the surface was handed, so it resolves
    // nothing to show and renders nothing at all - it does not fall back to
    // stale data.
    expect(screen.queryByTestId("comm-graph-agent-panel")).toBeNull();
    expect(screen.queryByText("Reviewer")).toBeNull();
  });

  it("registers a Find adapter that searches the agents on the floor", async () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    await act(async () => {
      await latestFindAdapter().search({
        requestId: 3,
        query: "review",
        matchCase: false,
      });
    });

    const snapshot = latestFindAdapter().getSnapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.activeUnitId).toBe(REVIEWER.id);
  });

  it("searches only the agents the cursor has revealed", async () => {
    // The floor is drawn as of the time cursor, so an agent that has not been
    // created yet is not on it - and must not be findable on it either.
    renderOffice(new Set([ORCHESTRATOR.id]));

    await act(async () => {
      await latestFindAdapter().search({
        requestId: 4,
        query: "review",
        matchCase: false,
      });
    });

    expect(latestFindAdapter().getSnapshot().total).toBe(0);
  });

  it("opens the agent panel when Find focuses a match", async () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));
    setIntersecting(true);
    await act(async () => {
      await latestFindAdapter().search({
        requestId: 5,
        query: "e",
        matchCase: false,
      });
    });
    expect(screen.queryByTestId("comm-graph-agent-panel")).toBeNull();

    // `next` moves off the first match and focuses the one it lands on;
    // focusing is what opens the panel, so a match is readable and not merely
    // pointed at.
    await act(async () => {
      await latestFindAdapter().next();
    });

    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
  });

  it("opens the pair thread when an envelope in flight is clicked", () => {
    const both = new Set([ORCHESTRATOR.id, REVIEWER.id]);
    const view = render(
      withQueryClient(officeElement(both, STATIC_OFFICE, {})),
    );
    setIntersecting(true);
    // A first render with no pulse, then the row: the scene deliberately does
    // not replay the row its very first sync arrives on.
    view.rerender(withQueryClient(officeElement(both, IN_FLIGHT, {})));
    const rect = envelopeRect(both);
    // The gestures live on the CANVAS, not on the wrapper - the wrapper is the
    // parent of the overlay controls, and taking pointer capture there stole
    // their clicks.
    const surface = screen.getByRole("img", {
      name: "Office view of the communication graph",
    });

    // The camera is untouched here (jsdom starts no frame loop), so sprite
    // pixels and client pixels coincide and the centre of the box is the click.
    const point = {
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    };
    fireEvent.pointerDown(surface, { pointerId: 1, ...point });
    fireEvent.pointerUp(surface, { pointerId: 1, ...point });

    expect(screen.getByTestId("comm-graph-thread-panel")).toBeDefined();
    // The message in flight is the pair's, so the panel is the PAIR's history -
    // not either endpoint's own activity.
    expect(screen.queryByTestId("comm-graph-agent-panel")).toBeNull();
  });

  it("does not open anything on a cancelled pointer", () => {
    // A cancel is not a click - the browser took the pointer mid-press, and
    // `handlePointerCancel` only clears the drag and releases capture. It
    // must not fall through to either open path a `pointerUp` at the same
    // spot would take.
    const both = new Set([ORCHESTRATOR.id, REVIEWER.id]);
    const view = render(
      withQueryClient(officeElement(both, STATIC_OFFICE, {})),
    );
    view.rerender(withQueryClient(officeElement(both, IN_FLIGHT, {})));
    const rect = envelopeRect(both);
    const surface = screen.getByRole("img", {
      name: "Office view of the communication graph",
    });

    const point = {
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2,
    };
    fireEvent.pointerDown(surface, { pointerId: 1, ...point });
    fireEvent.pointerCancel(surface, { pointerId: 1, ...point });

    expect(screen.queryByTestId("comm-graph-thread-panel")).toBeNull();
    expect(screen.queryByTestId("comm-graph-agent-panel")).toBeNull();
  });

  it("stays mounted and reachable while its frame loop is paused", () => {
    // The floor pauses when its tile is not being painted - an unselected
    // Traycer tab keeps its tiles mounted under `display:none`. What pauses is
    // the LOOP and nothing else: the tile is not unmounted, its agents stay
    // reachable, and the surface is still there to come back to. Only the
    // mounting half is observable here, since jsdom's missing 2d context means
    // the loop never started in the first place; the pausing half is
    // `office-frame-gate.test.ts`.
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    fireEvent(document, new Event("visibilitychange"));

    expect(screen.getByTestId("comm-graph-office-canvas")).toBeDefined();
    for (const agent of [ORCHESTRATOR, REVIEWER]) {
      expect(
        screen.getByTestId(`comm-graph-office-agent-${agent.id}`).textContent,
      ).toBe(agent.name);
    }
    // And still openable, not merely present in the tree.
    fireEvent.click(
      screen.getByTestId(`comm-graph-office-agent-${REVIEWER.id}`),
    );
    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
  });

  it("carries a zoom control set the pointer gestures are not the only route to", () => {
    renderOffice(new Set([ORCHESTRATOR.id]));

    expect(screen.getByTestId("comm-graph-office-zoom-in")).toBeDefined();
    expect(screen.getByTestId("comm-graph-office-zoom-out")).toBeDefined();
    expect(screen.getByTestId("comm-graph-office-fit")).toBeDefined();
  });

  it("shows no cursor chip when there is no cursor", () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    expect(screen.queryByTestId("comm-graph-office-cursor-chip")).toBeNull();
  });

  it("shows a Paused chip once the epic's cursor is set", () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    act(() => {
      useCommGraphTimelineStore
        .getState()
        .setCursor("epic-1", { timestamp: 1_000, hostId: "host-1", id: 1 });
    });

    const chip = screen.getByTestId("comm-graph-office-cursor-chip");
    expect(chip.textContent).toMatch(/^Paused at/);
  });

  it("shows a Replaying chip when the cursor is set and playback is running", () => {
    render(
      withQueryClient(
        officeElement(
          new Set([ORCHESTRATOR.id, REVIEWER.id]),
          { ...STATIC_OFFICE, playing: true },
          {},
        ),
      ),
    );

    act(() => {
      useCommGraphTimelineStore
        .getState()
        .setCursor("epic-1", { timestamp: 1_000, hostId: "host-1", id: 1 });
    });

    const chip = screen.getByTestId("comm-graph-office-cursor-chip");
    expect(chip.textContent).toMatch(/^Replaying/);
  });

  it("suspends its scene while ineligible and resumes it exactly once on return", () => {
    const both = new Set([ORCHESTRATOR.id, REVIEWER.id]);
    const view = render(
      withQueryClient(officeElement(both, STATIC_OFFICE, {})),
    );
    // Eligible first, so a scene exists to be suspended - a canvas that has
    // never been eligible has no scene at all, and a transition onto one
    // would go through the bare `sync` branch, not `resume`.
    setIntersecting(true);

    const syncSpy = vi.spyOn(OfficeScene.prototype, "sync");
    const resumeSpy = vi.spyOn(OfficeScene.prototype, "resume");

    setIntersecting(false);

    for (let change = 0; change < 20; change += 1) {
      view.rerender(
        withQueryClient(
          officeElement(
            both,
            { ...STATIC_OFFICE, pulseKey: `row-${change}` },
            {},
          ),
        ),
      );
    }
    expect(syncSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();

    setIntersecting(true);

    // The eligibility effect runs before the sync effect, so a commit that
    // flips both together takes the resume branch. `resume` is itself
    // implemented as one `sync` call with the suppressed pulse key adopted
    // first (`OfficeScene.resume`), so a `resume` call carries exactly one
    // `sync` call with it - the count that would tell resume apart from the
    // bare-sync branch is `resume`'s own, not `sync`'s.
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it("carries a glyph on its lod 0 pip for attention, failure, awaiting and archived", () => {
    // jsdom draws nothing, so this reads the same answer the canvas's own
    // scene would give at overview zoom, the way `envelopeRect` already does
    // for the envelope box - a parallel scene fed the identical statuses.
    const attention = agent("agent-attn", "Attention");
    const failure = agent("agent-fail", "Failure");
    const awaiting = agent("agent-wait", "Awaiting");
    const archived = agent("agent-arch", "Archived");
    const roster = [attention, failure, awaiting, archived];
    const ids = new Set(roster.map((one) => one.id));

    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    const agents = roster.map(officeAgentInput);
    const statusById = new Map<string, OfficeAgentStatus>([
      [attention.id, "attention"],
      [failure.id, "failure"],
      [awaiting.id, "awaiting"],
      [archived.id, "archived"],
    ]);
    scene.sync({
      agents,
      visibleAgentIds: ids,
      statusById,
      partition: partitionOfficePopulation({
        agents,
        statusById,
        previous: null,
      }),
      activityById: new Map(),
      viewport: { width: 0, height: 0 },
      pulse: null,
      pulseKey: null,
      stepMs: BASE_STEP_MS,
      cursorMs: null,
      clockMs: 0,
      openRequestsByReceiver: new Map(),
      playing: false,
      reducedMotion: false,
    });

    const pips = scene.frame(0, WHOLE_WORLD).actors;
    function glyphOf(agentId: string): string {
      const pip = pips.find(
        (drawable) => drawable.kind === "pip" && drawable.agentId === agentId,
      );
      if (pip === undefined || pip.kind !== "pip") {
        throw new Error(`no pip for ${agentId}`);
      }
      return pip.glyph;
    }

    expect(glyphOf(attention.id)).toBe("bang");
    expect(glyphOf(failure.id)).toBe("bang");
    expect(glyphOf(awaiting.id)).toBe("ring");
    expect(glyphOf(archived.id)).toBe("hollow");
  });

  it("renders the given view picker inside its chrome, beside the mode toggle", () => {
    // The office is the ONLY mode this canvas draws - the graph canvas
    // (`CommGraphCanvas`) has no `viewPicker` prop at all, so there is no
    // runtime toggle to exercise on that side; this pins the positive half,
    // that whatever picker the tile hands over is rendered where it belongs.
    const marker = <div data-testid="marker-view-picker">Marker</div>;
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {
          viewPicker: marker,
        }),
      ),
    );

    const surface = screen.getByTestId("comm-graph-office-canvas");
    expect(surface.contains(screen.getByTestId("marker-view-picker"))).toBe(
      true,
    );
  });

  it("shows Auto's chip text for the decision it was given", () => {
    const decision: OfficeAutoDecision = {
      view: "towers",
      fits: [
        { view: "floor", zoom: 0.12 },
        { view: "towers", zoom: 0.83 },
      ],
      agents: 42,
    };
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {
          autoChip: <OfficeAutoChip decision={decision} restoredView={null} />,
        }),
      ),
    );

    expect(screen.getByTestId("comm-graph-office-auto-chip").textContent).toBe(
      "Auto · Towers · measured at 42 agents · Floor would be 0.12×",
    );
  });

  it("shows the measuring placeholder while Auto has not decided yet", () => {
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {
          autoChip: <OfficeAutoChip decision={null} restoredView={null} />,
        }),
      ),
    );

    expect(screen.getByTestId("comm-graph-office-auto-chip").textContent).toBe(
      "Auto · measuring…",
    );
  });

  it("reads the LOD chip as Office at 1x and Overview once zoomed out past 0.7x", () => {
    renderOffice(new Set([ORCHESTRATOR.id]));

    expect(screen.getByTestId("comm-graph-office-lod-chip").textContent).toBe(
      "Office",
    );

    // Two clicks: 1 / 1.25 / 1.25 = 0.64, below the 0.7x office-detail floor.
    fireEvent.click(screen.getByTestId("comm-graph-office-zoom-out"));
    fireEvent.click(screen.getByTestId("comm-graph-office-zoom-out"));

    expect(screen.getByTestId("comm-graph-office-lod-chip").textContent).toBe(
      "Overview",
    );
  });

  it("pans on a plain wheel and persists the camera after the debounce", () => {
    vi.useFakeTimers();
    const onCameraChange = vi.fn();
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {
          onCameraChange,
        }),
      ),
    );
    const surface = screen.getByTestId("comm-graph-office-canvas");

    fireEvent.wheel(surface, { deltaX: 40, deltaY: 25 });
    // Not yet - the write is debounced, so a still-pending pan must not have
    // reached the store.
    expect(onCameraChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(onCameraChange).toHaveBeenCalledWith({ x: -40, y: -25, zoom: 1 });
  });

  it("zooms about the cursor on ctrl-wheel instead of panning", () => {
    vi.useFakeTimers();
    const onCameraChange = vi.fn();
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {
          onCameraChange,
        }),
      ),
    );
    const surface = screen.getByTestId("comm-graph-office-canvas");

    // A pinch arrives as ctrl-wheel; a negative deltaY is a zoom IN.
    fireEvent.wheel(surface, {
      deltaY: -300,
      ctrlKey: true,
      clientX: 0,
      clientY: 0,
    });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(onCameraChange).toHaveBeenCalledTimes(1);
    const camera = onCameraChange.mock.calls[0][0] as { zoom: number };
    // Anchored at (0, 0) with the camera already at (0, 0), so only the zoom
    // moves - the pan half of the same gesture is covered above.
    expect(camera.zoom).toBeGreaterThan(1);
  });

  it("fits the whole floor to the tile on F, and persists it after the debounce", () => {
    vi.useFakeTimers();
    const onCameraChange = vi.fn();
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), STATIC_OFFICE, {
          onCameraChange,
        }),
      ),
    );
    // Eligible first, so a scene exists for `fitToFloor` to read a world size
    // from - `peekScene()` returns null otherwise and F would be a no-op.
    setIntersecting(true);
    // Big enough that the fit zoom hits its cap (6x) on this fixture's tiny
    // two-agent floor, which makes the expected camera an exact, round number
    // instead of a packing-dependent fraction.
    setCanvasSize({ width: 4200, height: 1900 });

    const surface = screen.getByRole("img", {
      name: "Office view of the communication graph",
    });
    fireEvent.keyDown(surface, { key: "F" });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(onCameraChange).toHaveBeenCalledWith({ x: 36, y: 38, zoom: 6 });
  });

  it("returns to 1x on 0, from the centre of the tile", () => {
    vi.useFakeTimers();
    const onCameraChange = vi.fn();
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {
          onCameraChange,
        }),
      ),
    );
    const surface = screen.getByRole("img", {
      name: "Office view of the communication graph",
    });

    fireEvent.keyDown(surface, { key: "+" });
    fireEvent.keyDown(surface, { key: "0" });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    const last = onCameraChange.mock.calls.at(-1)?.[0] as { zoom: number };
    expect(last.zoom).toBeCloseTo(1, 5);
  });

  it("cancels a pending camera persist on unmount, leaving no stale write behind", () => {
    // The same unmount a view pick's remount performs (T6's own claim: "the
    // unmount cancels the debounce"). A pan mid-flight when that happens must
    // not land after the fact.
    vi.useFakeTimers();
    const onCameraChange = vi.fn();
    const view = render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE, {
          onCameraChange,
        }),
      ),
    );
    const surface = screen.getByTestId("comm-graph-office-canvas");

    fireEvent.wheel(surface, { deltaX: 40, deltaY: 0 });
    view.unmount();

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(onCameraChange).not.toHaveBeenCalled();
  });

  it("renders directory rows from the partition and statusById", () => {
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    // Both agents are idle in this fixture (no hot signal is wired into this
    // suite's mocks), so nothing shows under Teams at work or the Bullpen.
    // The Quiet count is 1, not 2: the first root (Orchestrator) settles as
    // this host's HQ, and the HQ row is shown rather than counted into
    // Quiet - only Reviewer's solo goes there. The footer counts both,
    // straight off the partition this canvas derives.
    expect(
      screen.getByTestId("comm-graph-office-directory-quiet").textContent,
    ).toBe("Quiet · 1 idle or archived");
    expect(
      screen.getByTestId("comm-graph-office-directory-footer").textContent,
    ).toBe("2 agents · 0 at work");
  });

  it("gives the host's HQ its own directory row, selectable like any other", () => {
    // Orchestrator settles as host-1's HQ (the epic's root) - it used to be
    // in no team and no bullpen, and so had no row at all, which made it the
    // one agent this panel could not browse to.
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    fireEvent.click(
      screen.getByTestId(
        `comm-graph-office-directory-agent-${ORCHESTRATOR.id}`,
      ),
    );

    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
    expect(screen.getAllByText("Orchestrator").length).toBeGreaterThan(0);
  });

  it("pans to an agent found in the directory search through scene.locate, not a pixel result", () => {
    // jsdom never runs the animation loop that would actually move the
    // camera (no 2d context), so the observable claim here is that the pan
    // is AIMED FROM THE SEAT BOOK - `scene.locate` - not that a pixel moved.
    const locateSpy = vi.spyOn(OfficeScene.prototype, "locate");
    const both = new Set([ORCHESTRATOR.id, REVIEWER.id, OFFSCREEN.id]);
    render(
      withQueryClient(
        officeElement(both, STATIC_OFFICE, {
          agents: [ORCHESTRATOR, REVIEWER, OFFSCREEN],
        }),
      ),
    );
    // A scene has to exist before there is anything for `locate` to read.
    setIntersecting(true);

    fireEvent.change(screen.getByTestId("comm-graph-office-directory-search"), {
      target: { value: "Offscreen" },
    });
    fireEvent.click(
      screen.getByTestId(`comm-graph-office-directory-agent-${OFFSCREEN.id}`),
    );

    expect(locateSpy).toHaveBeenCalledWith(OFFSCREEN.id);
    // The same click also selects the agent, which is the other half of
    // "select AND take the camera to it" the panel's own contract promises.
    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
  });

  it("filters the directory to the visible set, dropping a host section with nothing left in it", () => {
    // The partition seats every agent the epic ever had, but the floor only
    // draws the as-of-cursor set - so a host whose only VISIBLE agent has not
    // been revealed yet must not leave a heading over nothing. Host B's lead
    // settles as that host's HQ and, being invisible, gets no row of its own
    // either - the filter applies to the HQ row exactly like any other; its
    // member is the real solo row that would otherwise have kept the section
    // alive. Host C stays fully visible so a SECOND section survives - with
    // only one section left, headers are omitted entirely ("one host needs
    // no header"), which would make host-1's own heading absent too and hide
    // the difference between "filtered out" and "there's only one host".
    const visible = new Set([
      ORCHESTRATOR.id,
      REVIEWER.id,
      HOST_C_LEAD.id,
      HOST_C_MEMBER.id,
    ]);
    render(
      withQueryClient(
        officeElement(visible, STATIC_OFFICE, {
          agents: [
            ORCHESTRATOR,
            REVIEWER,
            HOST_B_LEAD,
            HOST_B_MEMBER,
            HOST_C_LEAD,
            HOST_C_MEMBER,
          ],
        }),
      ),
    );

    // The negative, with a positive control beside it: host-2's heading is
    // gone, not merely quiet, while host-1's (and host-3's) are still there.
    expect(screen.queryByText("host-2")).toBeNull();
    expect(screen.getByText("host-1")).toBeDefined();
    expect(screen.getByText("host-3")).toBeDefined();
    // Host B's HQ row is gone too - the same visible-set filter that removes
    // any other row.
    expect(
      screen.queryByTestId(
        `comm-graph-office-directory-agent-${HOST_B_LEAD.id}`,
      ),
    ).toBeNull();
    expect(screen.queryByText(HOST_B_MEMBER.name)).toBeNull();
    expect(
      screen.getByTestId("comm-graph-office-directory-footer").textContent,
    ).toBe("4 agents · 0 at work");

    fireEvent.change(screen.getByTestId("comm-graph-office-directory-search"), {
      target: { value: "Bay member" },
    });
    expect(
      screen.queryByTestId(
        `comm-graph-office-directory-agent-${HOST_B_MEMBER.id}`,
      ),
    ).toBeNull();
    expect(screen.getByText("Nobody here by that name.")).toBeDefined();
  });

  it("never sends a directory row click to a removed team lead (F5)", () => {
    const fixture = makeTestEpic("one-team", 12, 1);
    const statusById = new Map(
      fixture.agents.map((a) => [a.id, "working" as const]),
    );
    const previous = partitionOfficePopulation({
      agents: fixture.agents,
      statusById,
      previous: null,
    });
    const teams = previous.hosts.flatMap((h) => h.teams);
    if (teams.length === 0) throw new Error("fixture has no team");
    const team = teams[0];
    // The lead is removed AFTER the first partition, and the team is
    // repartitioned against that same previous partition - the exact
    // sequence that keeps a frozen team's survivors together.
    const agents = fixture.agents.filter((a) => a.id !== team.leadAgentId);
    const ids = new Set(agents.map((a) => a.id));
    const partition = partitionOfficePopulation({
      agents,
      statusById,
      previous,
    });
    // A typed recorder rather than `select.mock.calls[0]?.[0]`, whose
    // elements are `any` and are compared against a real id below.
    const dispatched: { agentId: string | null } = { agentId: null };
    const select = (agentId: string) => {
      dispatched.agentId = agentId;
    };
    render(
      <OfficeDirectoryPanel
        partition={partition}
        visibleAgentIds={ids}
        statusById={statusById}
        nameById={new Map(agents.map((a) => [a.id, a.name]))}
        hostNameById={new Map()}
        selectedAgentId={null}
        onSelectAgent={select}
        onHoverAgent={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const row = screen.getByTestId(
      `comm-graph-office-directory-team-${team.teamId}`,
    );

    fireEvent.click(row);

    const target = dispatched.agentId;
    if (target === null) throw new Error("the row dispatched nothing");
    // Not the raw id of an agent that no longer exists - never rendered on
    // the row, never dispatched from it.
    expect(row.textContent).not.toContain(team.leadAgentId);
    expect(target).not.toBe(team.leadAgentId);
    expect(ids.has(target)).toBe(true);
  });

  it("zooms about a real hovered agent on double-click, same as it does an empty floor (F6)", () => {
    const { step } = installCanvas();
    const frames = vi.spyOn(OfficeScene.prototype, "frame");
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), STATIC_OFFICE, {
          // A non-default view keeps auto-fit off, so the camera stays
          // exactly what was authored: a hit region's rect (sprite space)
          // can then be fed straight in as a screen coordinate, which an
          // auto-fitted camera would otherwise move out from under it.
          view: { ...OFFICE_VIEW, x: 1 },
        }),
      ),
    );
    setIntersecting(true);
    step();

    const hit = lastHitRegions(frames).find(
      (r) => r.agentId === ORCHESTRATOR.id,
    );
    if (hit === undefined) throw new Error("no real agent hit region");
    const canvas = screen.getByRole("img", {
      name: "Office view of the communication graph",
    });
    const x = hit.rect.x + hit.rect.width / 2 + 1;
    const y = hit.rect.y + hit.rect.height / 2;
    fireEvent.pointerMove(canvas, { clientX: x, clientY: y });
    const trigger = screen.getByTestId(
      `comm-graph-office-hover-trigger-${ORCHESTRATOR.id}`,
    );

    fireEvent.doubleClick(trigger, { clientX: x, clientY: y });
    step();

    const afterAgent = lastFramedRect(frames);
    // The same zoom-in a double-click over empty floor performs - the
    // hover trigger sits ON the floor, not ahead of its gesture.
    expect(afterAgent?.width).toBeCloseTo(1040 / 1.25);
  });

  /**
   * Double-clicks empty floor and the agent hit target from the SAME starting
   * camera, in two SEPARATE renders - never the same one, one after another.
   * Two double-clicks in one render compound (the second zooms on top of the
   * first: `1040 / 1.25²`, not `1040 / 1.25`), which is exactly how the
   * reviewer's own probe encoded the defect it was meant to catch: its
   * agent-then-empty "control" only agreed with the agent gesture while the
   * agent gesture was broken and did nothing. Pinning both against EACH
   * OTHER, not each against the bare constant, is what makes this a parity
   * claim rather than two coincidental readings of `ZOOM_BUTTON_FACTOR`.
   */
  function worldWidthAfterDoubleClick(target: "empty" | "agent"): number {
    const { step } = installCanvas();
    const frames = vi.spyOn(OfficeScene.prototype, "frame");
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), STATIC_OFFICE, {
          view: { ...OFFICE_VIEW, x: 1 },
        }),
      ),
    );
    setIntersecting(true);
    step();
    const canvas = screen.getByRole("img", {
      name: "Office view of the communication graph",
    });
    if (target === "empty") {
      fireEvent.doubleClick(canvas, { clientX: 900, clientY: 600 });
    } else {
      const hit = lastHitRegions(frames).find(
        (r) => r.agentId === ORCHESTRATOR.id,
      );
      if (hit === undefined) throw new Error("no real agent hit region");
      const x = hit.rect.x + hit.rect.width / 2 + 1;
      const y = hit.rect.y + hit.rect.height / 2;
      fireEvent.pointerMove(canvas, { clientX: x, clientY: y });
      const trigger = screen.getByTestId(
        `comm-graph-office-hover-trigger-${ORCHESTRATOR.id}`,
      );
      fireEvent.doubleClick(trigger, { clientX: x, clientY: y });
    }
    step();
    const after = lastFramedRect(frames);
    if (after === null) throw new Error("no frame");
    const width = after.width;
    cleanup();
    // Only what THIS call's `installCanvas()` stubbed (the 2d context, the
    // bounding rect, `OfficeScene.prototype.frame`) - never the outer
    // `beforeEach`'s `IntersectionObserver` stub, which the second render
    // still needs. `vi.unstubAllGlobals()` would take that down too.
    vi.restoreAllMocks();
    return width;
  }

  it("zooms the agent hit target and the empty floor by the same amount (F6)", () => {
    const emptyWidth = worldWidthAfterDoubleClick("empty");
    const agentWidth = worldWidthAfterDoubleClick("agent");

    // Parity is the claim - each against the OTHER, not just each against
    // the bare constant, which a compounded double zoom would satisfy too.
    expect(agentWidth).toBeCloseTo(emptyWidth);
    expect(agentWidth).toBeCloseTo(1040 / 1.25);
  });

  it("actually pans an off-screen directory agent into the real rendered frame (F7)", () => {
    const { step } = installCanvas();
    const frames = vi.spyOn(OfficeScene.prototype, "frame");
    const locate = vi.spyOn(OfficeScene.prototype, "locate");
    const fixture = makeTestEpic("triage", 309, 1);
    const agents = fixture.agents.map(canvasAgent);
    const target = agents.at(-1);
    if (target === undefined) throw new Error("fixture empty");
    render(
      withQueryClient(
        officeElement(new Set(agents.map((a) => a.id)), STATIC_OFFICE, {
          agents,
          view: { ...OFFICE_VIEW, x: -10000, y: -10000 },
        }),
      ),
    );
    setIntersecting(true);
    step();
    const before = lastFramedRect(frames);

    fireEvent.change(screen.getByTestId("comm-graph-office-directory-search"), {
      target: { value: target.name },
    });
    fireEvent.click(
      screen.getByTestId(`comm-graph-office-directory-agent-${target.id}`),
    );
    // Guarded at the boundary: a spy's results are `any`, and this rect is
    // read field by field.
    const seat: unknown = locate.mock.results.at(-1)?.value;
    if (!isOfficeRect(seat)) throw new Error("target not located");
    const located = seat;
    const center = {
      x: located.x + located.width / 2,
      y: located.y + located.height / 2,
    };
    for (let index = 0; index < 5; index += 1) step();
    const after = lastFramedRect(frames);
    if (after === null || before === null) {
      throw new Error("no frames");
    }

    // Genuinely off-screen before the pan - not merely "locate was called".
    expect(
      center.x < before.x ||
        center.x > before.x + before.width ||
        center.y < before.y ||
        center.y > before.y + before.height,
    ).toBe(true);
    // And genuinely on-screen after it: the target's own centre sits inside
    // the frame the real animation loop produced, camera moves and all.
    expect(center.x).toBeGreaterThanOrEqual(after.x);
    expect(center.x).toBeLessThanOrEqual(after.x + after.width);
    expect(center.y).toBeGreaterThanOrEqual(after.y);
    expect(center.y).toBeLessThanOrEqual(after.y + after.height);
    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
  });
});

/**
 * A recording 2D context: every call is captured as `{method, args}` rather
 * than executed against a real surface - jsdom has no canvas backend, and the
 * point of this harness is the ARGUMENTS a draw call was made with (a sign's
 * projected x, a name tag's call count), never a pixel. `measureText` and
 * `createImageData` get real-shaped answers because callers read their
 * return value; everything else is a recorder.
 */
/**
 * `measureText`, modelled on the face the caller actually set.
 *
 * jsdom has no text shaping, so a width has to be computed rather than
 * measured - but it can be computed from the SAME two properties a browser
 * would use. Every face in the monospace stack advances 0.6em a character, and
 * `ctx.letterSpacing` is applied by `measureText` as well as by `fillText`, so
 * a sign plate (bold 10px, tracked 0.08em) comes out 13% wider a character
 * than a name tag (10px, untracked) - which is the whole reason the board
 * ladder is picked by measurement and not by counting characters.
 */
const MONOSPACE_ADVANCE_EM = 0.6;

function modelledTextWidth(
  text: string,
  font: string,
  letterSpacing: string,
): number {
  const px = /(\d+(?:\.\d+)?)px/.exec(font);
  const tracking = /(-?\d+(?:\.\d+)?)em/.exec(letterSpacing);
  const size = px === null ? 10 : Number(px[1]);
  const spacing = tracking === null ? 0 : Number(tracking[1]);
  return text.length * size * (MONOSPACE_ADVANCE_EM + spacing);
}

interface RecordedCall {
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

function createRecordingContext(calls: RecordedCall[]): unknown {
  const backing: Record<string, unknown> = {};
  return new Proxy(backing, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "measureText") {
        // The recorder already stores every assignment, so the face a caller
        // set is readable straight off the backing object.
        return (text: string) => ({
          width: modelledTextWidth(
            text,
            typeof backing.font === "string" ? backing.font : "10px monospace",
            typeof backing.letterSpacing === "string"
              ? backing.letterSpacing
              : "0px",
          ),
        });
      }
      if (prop === "createImageData") {
        return (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        });
      }
      if (prop === "canvas") return document.createElement("canvas");
      return (...args: ReadonlyArray<unknown>): void => {
        calls.push({ method: prop, args });
      };
    },
    set(_target, prop, value) {
      if (typeof prop === "string") {
        backing[prop] = value;
        calls.push({ method: `set:${prop}`, args: [value] });
      }
      return true;
    },
  });
}

/** Installs a `getContext` stub and returns its undo. */
function stubGetContext(factory: () => unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: factory,
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
      return;
    }
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", original);
  };
}

/**
 * Deliberately NOT `DEFAULT_COMM_GRAPH_VIEW` (`{x:0,y:0,zoom:1}`) - a view
 * equal to the default enables auto-fit, which frames the floor and leaves
 * the camera at whatever position that produced rather than the identity
 * camera this suite's expected coordinates are computed against.
 */
const FIXED_CAMERA_VIEW: CommGraphTileViewState = {
  x: 5,
  y: 0,
  zoom: 1,
  mode: "office",
  officeView: null,
  officeAutoView: null,
  officeCameraView: null,
};

function officeElementWithView(
  officeView: OfficeView,
  visibleIds: ReadonlySet<string>,
  agents: ReadonlyArray<CommGraphAgentNode>,
  overrides: Partial<CommGraphOfficeCanvasProps>,
) {
  return (
    <CommGraphOfficeCanvas
      epicId="epic-1"
      tileInstanceId="comm-graph-instance-renderer"
      agents={agents}
      agentIds={visibleIds}
      events={[]}
      hosts={[]}
      initialHistoryCaughtUp={false}
      playing={false}
      pulse={null}
      pulseKey={null}
      modeToggle={null}
      view={FIXED_CAMERA_VIEW}
      officeView={officeView}
      // The tile has settled which view this is; these cases are about where
      // the renderer puts things, not about Auto still deciding.
      ready
      onAutoProbe={vi.fn()}
      viewPicker={null}
      autoChip={null}
      onCameraChange={vi.fn()}
      canOpenAgentForEvent={() => true}
      canJump={() => false}
      onJump={vi.fn()}
      canJumpToSender={() => false}
      onJumpToSender={vi.fn()}
      canJumpToCreated={() => false}
      onJumpToCreated={vi.fn()}
      onOpenAgent={vi.fn()}
      {...overrides}
    />
  );
}

const BOUNDING_RECT_STUB: DOMRect = {
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
  top: 0,
  left: 0,
  right: 1200,
  bottom: 800,
  toJSON: () => ({}),
};

describe("CommGraphOfficeCanvas fixups 1 and 2 - renderer projection, semantic zoom and board width (F5, F10, F11)", () => {
  let rafQueue: Array<{
    readonly id: number;
    readonly callback: FrameRequestCallback;
  }> = [];
  let nextRafId = 1;
  let canceledRafIds = new Set<number>();
  let calls: RecordedCall[] = [];
  let restoreGetContext: (() => void) | null = null;
  let frameClockMs = 0;

  /**
   * One drawn frame per flush, on a clock of this suite's own.
   *
   * The loop is rate-capped at 30fps off the timestamp rAF hands it, and a
   * suite runs many frames inside one wall-clock millisecond - so handing it
   * `performance.now()` makes "how many frames did I flush" depend on how
   * fast the machine got here, and every frame after the first in a batch
   * silently draws nothing. A synthetic clock that steps past the interval
   * each time is what makes a flush mean a frame.
   */
  function flushRaf(times: number): void {
    for (let step = 0; step < times; step += 1) {
      frameClockMs += OFFICE_FRAME_INTERVAL_MS + 1;
      const pending = rafQueue;
      rafQueue = [];
      act(() => {
        for (const queued of pending) {
          if (!canceledRafIds.has(queued.id)) queued.callback(frameClockMs);
        }
      });
    }
  }

  beforeEach(() => {
    activeObserverCallbacks = [];
    vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
    calls = [];
    rafQueue = [];
    canceledRafIds = new Set();
    nextRafId = 1;
    frameClockMs = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextRafId;
      nextRafId += 1;
      rafQueue.push({ id, callback: cb });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      canceledRafIds.add(id);
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      BOUNDING_RECT_STUB,
    );
    restoreGetContext = stubGetContext(() => createRecordingContext(calls));
  });

  afterEach(() => {
    cleanup();
    restoreGetContext?.();
    restoreGetContext = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useCommGraphTimelineStore.setState({ stateByEpicId: {} });
  });

  const RENDERER_BOUNDS: OfficeTileRect = {
    col: 0,
    row: 0,
    cols: 16,
    rows: 16,
  };

  function emptyFloor(): OfficeFloor {
    return {
      hostId: null,
      bounds: RENDERER_BOUNDS,
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      receptionTile: { col: 0, row: 2 },
      receptionQueueTiles: [],
      queueFacing: "down",
      corridorTiles: [],
      clockTile: { col: 15, row: 0 },
      stairsTile: null,
      errandSpots: [],
      cafeteria: null,
      gameRoom: null,
      areaSigns: [],
      amenities: [],
    };
  }

  function allWalkable(
    rows: number,
    cols: number,
  ): ReadonlyArray<ReadonlyArray<boolean>> {
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => true),
    );
  }

  /** A projector that shifts every projected x by +2048px - the review's own F5 recipe. */
  const SHIFTED_PROJECTOR_X = 2048;

  it("F5: carries the projected sign anchor to the board's label text, not raw tile math", () => {
    const boardSign: OfficeSign = {
      kind: "board",
      tile: { col: 2, row: 2 },
      widthTiles: 8,
      text: "",
      ownerAgentId: null,
      hostId: null,
      agentIds: [],
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map(),
      seats: new Map(),
      signs: [boardSign],
      rooms: [],
      floors: [emptyFloor()],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        projector: () => ({
          project: (col: number, row: number) => ({
            x: SHIFTED_PROJECTOR_X + col * OFFICE_TILE,
            y: row * OFFICE_TILE,
          }),
          bounds: { x: 0, y: 0, width: 4096, height: 4096 },
          seatLift: () => 0,
        }),
      },
    };

    render(
      withQueryClient(officeElementWithView(view, new Set<string>(), [], {})),
    );
    setIntersecting(true);
    flushRaf(3);

    const fillTextCalls = calls.filter((call) => call.method === "fillText");
    // An EIGHT-tile board is 128 screen pixels, which the abbreviated reading
    // fits and the spelt-out one does not. Matched on the abbreviation rather
    // than on a word, because what this case is about is WHERE the text lands,
    // not which rung the width picked. It used to be two tiles, which is
    // thirty-two pixels - below every reading of a roster, so the board fell
    // to a bare total and there was no "0D" on the canvas to find.
    const boardTextCall = fillTextCalls.find(
      (call) =>
        typeof call.args[0] === "string" && call.args[0].startsWith("0D"),
    );
    expect(boardTextCall).toBeDefined();
    // Fixed camera (zoom 1, x=5, y=0): the projected anchor for tile (2,2)
    // with an eight-tile board centred on it is
    // x = 2048 + 2*16 + (8*16)/2 = 2144, screenX = 2144 * 1 + 5 = 2149. The
    // unfixed renderer instead multiplies the raw tile by OFFICE_TILE with no
    // projector at all, landing four figures short at screenX = 101.
    expect(boardTextCall?.args[1]).toBe(2149);
  });

  it("F10: an unhovered, unselected, unmatched agent's name tag draws nothing at LOD 1", () => {
    const seat = {
      seatId: "h/0/worker",
      kind: "desk" as const,
      deskTile: { col: 4, row: 4 },
      chairTile: { col: 4, row: 5 },
      facing: "down" as const,
      hitTiles: { width: 1, height: 1 },
      hitBox: null,
      floorIndex: 0,
      roomId: null,
      hostId: null,
      manager: false,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["worker", { ...seat, agentId: "worker" }]]),
      seats: new Map([["h/0/worker", seat]]),
      signs: [],
      rooms: [],
      floors: [emptyFloor()],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const view: OfficeView = { ...OFFICE_VIEWS.floor, plan: () => layout };
    const worker = agent("worker", "Worker");

    render(
      withQueryClient(
        officeElementWithView(view, new Set(["worker"]), [worker], {}),
      ),
    );
    setIntersecting(true);
    flushRaf(3);

    const nameTextCalls = calls.filter(
      (call) =>
        call.method === "fillText" &&
        typeof call.args[0] === "string" &&
        call.args[0].includes("Worker"),
    );
    // Required rule: at LOD 1, a name tag is drawn only for a hovered,
    // selected, or search-matched agent. This one is none of those, so it
    // must produce zero text calls; the unfixed renderer draws it regardless.
    expect(nameTextCalls).toHaveLength(0);
  });

  /** The same camera, zoomed past the 1.6 threshold into the close-up band. */
  const CLOSE_UP_CAMERA_VIEW: CommGraphTileViewState = {
    ...FIXED_CAMERA_VIEW,
    zoom: 2,
  };

  function seatAt(args: {
    readonly seatId: string;
    readonly col: number;
    readonly row: number;
  }): OfficeSeat {
    return {
      seatId: args.seatId,
      kind: "desk",
      deskTile: { col: args.col, row: args.row },
      chairTile: { col: args.col, row: args.row + 1 },
      facing: "down",
      hitTiles: { width: 1, height: 1 },
      hitBox: null,
      floorIndex: 0,
      roomId: null,
      hostId: null,
      manager: false,
    };
  }

  /**
   * A floor with a chair far from its door, and the view that plans it.
   *
   * Far on purpose: an agent REVEALED while playback is running walks in from
   * the door rather than appearing in its chair, so a long walk is a walker
   * that stays a walker for as many frames as a case needs.
   */
  function walkInView(): OfficeView {
    const host = seatAt({ seatId: "h/0/host", col: 2, row: 2 });
    const worker = seatAt({ seatId: "h/0/worker", col: 12, row: 12 });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([
        ["host", { ...host, agentId: "host" }],
        ["worker", { ...worker, agentId: "worker" }],
      ]),
      seats: new Map([
        ["h/0/host", host],
        ["h/0/worker", worker],
      ]),
      signs: [],
      rooms: [],
      floors: [emptyFloor()],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    return { ...OFFICE_VIEWS.floor, plan: () => layout };
  }

  // One shared first word, so a single query matches both and the seated one
  // becomes the control for the walking one.
  const HOST_AGENT = agent("host", "Alpha Sitter");
  const WALKER_AGENT = agent("worker", "Alpha Walker");

  /**
   * Renders the office, then reveals the walker on a second commit.
   *
   * The first sync seats everybody silently - that is what a first sync is -
   * so the walker has to arrive on a later one, with playback running, to be
   * announced as a walk-in rather than simply appearing in its chair.
   */
  function renderWithWalker(args: {
    readonly view: OfficeView;
    readonly camera: CommGraphTileViewState;
  }): RenderResult {
    const { camera, view } = args;
    const rendered = render(
      withQueryClient(
        officeElementWithView(view, new Set(["host"]), [HOST_AGENT], {
          view: camera,
        }),
      ),
    );
    setIntersecting(true);
    flushRaf(2);
    rendered.rerender(
      withQueryClient(
        officeElementWithView(
          view,
          new Set(["host", "worker"]),
          [HOST_AGENT, WALKER_AGENT],
          { view: camera, playing: true },
        ),
      ),
    );
    flushRaf(3);
    return rendered;
  }

  /** Every string this frame actually painted. */
  function paintedText(): ReadonlyArray<string> {
    const painted: string[] = [];
    for (const call of calls) {
      if (call.method !== "fillText") continue;
      const [text] = call.args;
      if (typeof text === "string") painted.push(text);
    }
    return painted;
  }

  it("F10 fixture control: revealing an agent during playback really does leave it out of its chair", () => {
    // A PARALLEL SCENE, the trick this suite already uses for the lod-0 pips:
    // jsdom draws nothing, so the fixture's own claim - that the worker is a
    // walker and not somebody sitting down - is checked against the same view
    // fed the same two syncs, rather than assumed.
    const view = walkInView();
    const scene = new OfficeScene(view, null);
    const both = [HOST_AGENT, WALKER_AGENT].map(officeAgentInput);
    const first = [officeAgentInput(HOST_AGENT)];
    function syncInput(args: {
      readonly agents: ReadonlyArray<OfficeAgentInput>;
      readonly ids: ReadonlySet<string>;
      readonly playing: boolean;
    }): OfficeSceneInput {
      return {
        agents: args.agents,
        visibleAgentIds: args.ids,
        statusById: new Map(),
        partition: partitionOfficePopulation({
          agents: args.agents,
          statusById: new Map(),
          previous: null,
        }),
        activityById: new Map(),
        viewport: { width: 1200, height: 800 },
        pulse: null,
        pulseKey: null,
        stepMs: BASE_STEP_MS,
        cursorMs: null,
        clockMs: 0,
        openRequestsByReceiver: new Map(),
        playing: args.playing,
        reducedMotion: false,
      };
    }
    scene.sync(
      syncInput({ agents: first, ids: new Set(["host"]), playing: false }),
    );
    scene.sync(
      syncInput({
        agents: both,
        ids: new Set(["host", "worker"]),
        playing: true,
      }),
    );

    const away = scene.frame(2, WHOLE_WORLD).awayAgentIds;
    expect(away.has("worker")).toBe(true);
    expect(away.has("host")).toBe(false);
  });

  it("F10: names a SELECTED walker at LOD 1", () => {
    renderWithWalker({ view: walkInView(), camera: FIXED_CAMERA_VIEW });
    // The floor's own accessible list is how a reader opens an agent without
    // a pointer, and it is the same selection the pointer sets.
    act(() => {
      screen.getByTestId("comm-graph-office-agent-worker").click();
    });
    calls.length = 0;
    flushRaf(2);
    expect(paintedText()).toContain("Alpha Walker");
    // The control that makes it a walker case: the other agent is seated,
    // unselected and unhovered, so the middle band leaves it unnamed.
    expect(paintedText()).not.toContain("Alpha Sitter");
  });

  it("F10: names a SEARCH-MATCHED walker at LOD 1", async () => {
    renderWithWalker({ view: walkInView(), camera: FIXED_CAMERA_VIEW });
    await act(async () => {
      await latestFindAdapter().search({
        requestId: 7,
        query: "alpha",
        matchCase: false,
      });
    });
    calls.length = 0;
    flushRaf(2);

    // BOTH are matched, and the seated one is the control: a match ring
    // paints its agent's name itself, so counting occurrences of one name
    // alone cannot tell a name tag from a ring. What can is that a matched
    // WALKER is painted exactly as often as a matched sitter - the same ring,
    // and the same tag. Drop the tag for walkers and the walker's count falls
    // short of the sitter's by one label's worth of calls.
    const walker = paintedText().filter((text) => text === "Alpha Walker");
    const sitter = paintedText().filter((text) => text === "Alpha Sitter");
    expect(sitter.length).toBeGreaterThan(0);
    expect(walker.length).toBe(sitter.length);
  });

  it("F10: names an ordinary walker at LOD 2", () => {
    renderWithWalker({ view: walkInView(), camera: CLOSE_UP_CAMERA_VIEW });
    calls.length = 0;
    flushRaf(2);

    // Close-up names everything. Nobody is hovered, selected or matched here;
    // at this zoom that is not a question anybody asks.
    const painted = paintedText();
    expect(painted).toContain("Alpha Walker");
    expect(painted).toContain("Alpha Sitter");
  });

  it("F11: names all five of an eight-tile HQ board's hottest, inside the board's own pixels", () => {
    // The reviewer's own fixture: ordinary two-word names, and a board wide
    // enough that a character budget called four of them a comfortable fit
    // while the plate they actually needed was 356px across a 128px board.
    const roster = ["a", "b", "c", "d", "e", "f"];
    const names = [
      "Alpha Build",
      "Beta Queue",
      "Gamma Store",
      "Delta Auth",
      "Epsilon Docs",
      "Zeta Idle",
    ];
    const hqBoard: OfficeSign = {
      kind: "hq-board",
      tile: { col: 2, row: 2 },
      widthTiles: 8,
      text: "",
      ownerAgentId: null,
      hostId: null,
      agentIds: roster,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map(),
      seats: new Map(),
      signs: [hqBoard],
      rooms: [],
      floors: [emptyFloor()],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const view: OfficeView = { ...OFFICE_VIEWS.floor, plan: () => layout };
    const agents = roster.map((id, index) => agent(id, names[index]));

    render(
      withQueryClient(officeElementWithView(view, new Set(roster), agents, {})),
    );
    setIntersecting(true);
    flushRaf(3);

    // Found by the second-hottest either way, so a failure prints the plate
    // that WAS painted rather than `undefined`.
    const plate = paintedText().find(
      (text) => text.includes("AB") || text.includes("ALPHA"),
    );
    // FIVE ENTRIES. The sixth (Zeta Idle) is outside the five hottest and
    // stays off; the fifth is the one the old character budget dropped.
    expect(plate).toBe("AB BQ GS DA ED");
    // And it fits. This canvas answers `measureText` in the face the caller
    // set, so a tracked bold 10px plate advances 6.8px a character: the plate
    // is 14*6.8 + 8 = 103.2px on a board 8 tiles * 16px * zoom 1 = 128px wide.
    const measured = (plate?.length ?? 0) * 6.8 + 8;
    expect(measured).toBeLessThanOrEqual(8 * OFFICE_TILE);
  });

  it("F11: gives an HQ board a different summary than an ordinary board over the same roster", () => {
    const roster = ["a", "b", "c", "d", "e"];
    // EIGHT tiles each, the width a real board has. At two the pair is not
    // comparable: 32px is below every reading of this roster, so both fall to
    // the same bare total and "5" is a true thing to say about five agents
    // whether or not the board names them.
    const ordinaryBoard: OfficeSign = {
      kind: "board",
      tile: { col: 2, row: 2 },
      widthTiles: 8,
      text: "",
      ownerAgentId: null,
      hostId: null,
      agentIds: roster,
    };
    const hqBoard: OfficeSign = {
      kind: "hq-board",
      tile: { col: 8, row: 2 },
      widthTiles: 8,
      text: "",
      ownerAgentId: null,
      hostId: null,
      agentIds: roster,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map(),
      seats: new Map(),
      signs: [ordinaryBoard, hqBoard],
      rooms: [],
      floors: [emptyFloor()],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const view: OfficeView = { ...OFFICE_VIEWS.floor, plan: () => layout };
    const agents = roster.map((id) => agent(id, id));

    render(
      withQueryClient(officeElementWithView(view, new Set(roster), agents, {})),
    );
    setIntersecting(true);
    flushRaf(3);

    // Every sign plate is exactly one `fillText`, and at this zoom nothing
    // else writes text: name tags are suppressed at lod 1 for an agent that is
    // neither hovered, selected nor matched, and a single-floor building draws
    // no storey label. So these two strings ARE the two boards.
    const plateTexts = calls
      .filter((call) => call.method === "fillText")
      .map((call) => call.args[0])
      .filter((text): text is string => typeof text === "string");
    expect(plateTexts).toHaveLength(2);
    // Required rule: the HQ board ranks its five hottest agents; an ordinary
    // board reports the doing/waiting/idle buckets. They must not read the
    // same over an identical roster - the unfixed renderer gives both boards
    // the same officeBoardSummary text.
    expect(plateTexts[0]).not.toBe(plateTexts[1]);
  });

  describe("CommGraphOfficeCanvas fixup 3 - N1 Find annotates an agent, not its parts", () => {
    /**
     * The reviewer's reproduction: a real City office, everybody working, Find
     * matching the first agent. City builds its agents out of many parts, and
     * since F4 each part is separately hit-testable - so this is the scene where
     * "one region, one label" and "one agent, one label" differ by thirty.
     */
    /**
     * One agent is given a name no other agent shares a substring with, so the
     * query matches exactly one. The fixture's own names run "Agent 1",
     * "Agent 10", ... - searching one of those matches several agents and the
     * counts below stop being about one agent's parts.
     */
    const ONLY_MATCH = "Quilfeather";
    /** Long enough that the ordinary tag truncates it; same first word. */
    const LONG_MATCH = "Quilfeather Zarrowmere";

    function realCity(name: string) {
      const fixture = makeTestEpic("one-team", 12, 9);
      const agents = fixture.agents.map(canvasAgent);
      const matched = { ...agents[0], name };
      return {
        agents: [matched, ...agents.slice(1)],
        matched,
        ids: new Set(agents.map((a) => a.id)),
      };
    }

    /** One `drawScreenLabel` is four backing passes plus one text pass. */
    const PASSES_PER_LABEL = 5;

    function renderCity(zoom: number, name: string) {
      const { agents, ids, matched } = realCity(name);
      render(
        withQueryClient(
          cloneElement(
            officeElementWithView(OFFICE_VIEWS.city, ids, agents, {}),
            { view: { ...FIXED_CAMERA_VIEW, zoom } },
          ),
        ),
      );
      setIntersecting(true);
      flushRaf(3);
      return matched;
    }

    async function findFor(query: string) {
      await act(async () => {
        await latestFindAdapter().search({
          requestId: 1,
          query,
          matchCase: false,
        });
      });
    }

    /**
     * Every `fillText` pass that NAMES this agent, truncation included.
     *
     * The ordinary tag cuts a long name to fit - "Quilfeather Zarrowmere" is
     * painted "Quilfeather Z…" - so counting exact matches misses the very
     * label this case is about. That is how the shipped fixup-3 case passed
     * while two names were being drawn: the long name hid the truncated tag,
     * and only Find's untruncated copy was counted.
     *
     * Case-sensitive on purpose. A cabin's own plate is set in capitals
     * ("QUILFEATHER…"), and that is signage naming a room, not a name tag.
     */
    function namePaints(name: string): number {
      return paintedText().filter(
        (text) =>
          text === name ||
          (text.endsWith("…") && name.startsWith(text.slice(0, -1))),
      ).length;
    }

    it("paints a matched agent's name once, not once per hit region", async () => {
      const matched = renderCity(1, ONLY_MATCH);
      await findFor(matched.name);
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      // ONE label. The old path walked `frame.hitRegions` and drew a label for
      // every entry, which on a real City building is its roof, its windows,
      // its body and its seat backstop - thirty-two labels stacked four pixels
      // apart, 160 passes where the reviewer allowed ten.
      expect(namePaints(matched.name)).toBe(PASSES_PER_LABEL);
    });

    it("keeps one name when the ordinary tag TRUNCATES it", async () => {
      const matched = renderCity(1, LONG_MATCH);
      await findFor(matched.name);
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      // The control this case exists to be. A long name is painted
      // "Quilfeather Z…" by the tag path and in full by Find, so the two
      // strings differ and an exact-match count sees only one of them - which
      // is exactly how the fixup-3 case passed while two names were on screen.
      expect(namePaints(matched.name)).toBe(PASSES_PER_LABEL);
      // And the one that survived is the tag's, truncated to fit its
      // neighbours - not Find's untruncated copy over the top of it.
      const painted = paintedText().filter((text) => text.endsWith("…"));
      expect(painted).toContain("Quilfeather Z…");
      expect(paintedText()).not.toContain(LONG_MATCH);
    });

    it("keeps one name on a matched agent whose anchor is moving", async () => {
      const matched = renderCity(1, ONLY_MATCH);
      await findFor(matched.name);

      // Several consecutive frames of a live office. A duplicate that tracks
      // the same anchor is invisible to a single still frame - both copies sit
      // on top of each other - so the count has to hold while the anchor moves.
      const anchors: number[] = [];
      for (let frame = 0; frame < 6; frame += 1) {
        calls.length = 0;
        flushRaf(1);
        expect(namePaints(matched.name)).toBe(PASSES_PER_LABEL);
        const painted = calls.find(
          (call) =>
            call.method === "fillText" &&
            typeof call.args[0] === "string" &&
            call.args[0].startsWith(ONLY_MATCH.slice(0, 6)),
        );
        if (painted !== undefined && typeof painted.args[1] === "number") {
          anchors.push(painted.args[1]);
        }
      }
      // The office really did move under it, so the frames above were not six
      // copies of one still picture.
      expect(anchors.length).toBeGreaterThan(0);
      expect(new Set(anchors).size).toBeGreaterThan(1);
    });

    it("draws no Find name at overview, where the office draws no names at all", async () => {
      const matched = renderCity(0.5, ONLY_MATCH);
      await findFor(matched.name);
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      // Overview bans name tags outright - a name there is a smear over a
      // five-pixel pip. Find used to print straight past that rule.
      expect(namePaints(matched.name)).toBe(0);
      // The ring is not a name and stays: at this zoom it is the only thing
      // that can say where the match is.
      const rings = calls.filter((call) => call.method === "strokeRect");
      expect(rings.length).toBeGreaterThan(0);
    });

    it("paints nothing for an empty match", async () => {
      const matched = renderCity(1, ONLY_MATCH);
      await findFor("no-such-agent-anywhere");
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      // The control: unhovered, unselected and unmatched, this agent has no
      // name on the canvas at all, so the positive above is Find's doing.
      expect(namePaints(matched.name)).toBe(0);
    });

    it("rings a matched agent once over all of its parts", async () => {
      const matched = renderCity(1, ONLY_MATCH);
      await findFor(matched.name);
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      // One ring an agent, not one a part. F4's regions are untouched - the
      // pointer still resolves to whichever part was clicked - but an agent is
      // annotated as the one thing a reader is looking for.
      const rings = calls.filter((call) => call.method === "strokeRect");
      expect(rings).toHaveLength(1);
    });
  });

  /**
   * `drawNameTags` reports the agents it PLACED a tag for, not the agents it
   * OFFERED one to: `layoutNameTags` is greedy and drops a tag with nowhere
   * free rather than drawing it over a neighbour, so an agent can qualify for
   * a tag, be offered one, and still end up unnamed by that path. Find is
   * supposed to fill in for exactly that agent - never for one whose tag was
   * actually drawn, which would just be a second name at the same anchor.
   *
   * Real desks are not close enough for this on their own: Towers, Building,
   * Mission Control, Campus and City all space a room's chairs several tiles
   * apart (checked directly against `layoutNameTags`, fed the real projected
   * anchors of a real `one-team(12)` office in every registered view, with
   * every candidate's name forced to the 14-character cap `truncate` allows
   * - nothing ever collided). So this cluster is a small HAND-BUILT Floor
   * layout, the same pattern `F5`/`F10`/`walkInView` above already use to get
   * exact control over tile positions - real `OfficeScene`, real
   * `drawNameTags`, real `layoutNameTags`, real `drawFindOverlay`, nothing
   * stubbed - just four desks one tile apart instead of a real plan's wider
   * spacing.
   */
  describe("CommGraphOfficeCanvas fixup 4 - a tag DROPPED for collision still gets exactly one name, from Find", () => {
    /**
     * Four desks, one tile apart, all in the same row. Each name is well
     * past `MAX_LABEL_CHARS` (14), so every tag truncates to the same
     * 14-character width - the exact shape `office-name-tags.test.ts`'s own
     * "skips a tag with nowhere free" case uses, just reached through the
     * real renderer instead of `layoutNameTags` directly. `layoutNameTags`
     * places in ascending `centerX` order and has three slots (the anchor
     * plus two shifts); a one-tile pitch at zoom 1.6 puts even the two
     * FARTHEST apart of these four within the tag's own width, so all six
     * pairs overlap and the fourth (rightmost) is the one left with nowhere
     * to go.
     */
    const CLUSTER_NAMES: ReadonlyArray<string> = [
      "Zebra Overflow Name",
      "Yellow Clutter Agent",
      "Xenon Packed Mesh Name",
      "Walrus Dense Tag Name",
    ];
    const CLUSTER_CAMERA_VIEW: CommGraphTileViewState = {
      ...FIXED_CAMERA_VIEW,
      zoom: 1.6,
    };
    /** One `drawScreenLabel` is four backing passes plus one text pass. */
    const PASSES_PER_LABEL = 5;

    function clusterLayout(): OfficeLayout {
      const seats = CLUSTER_NAMES.map((_, index) =>
        seatAt({ seatId: `h/0/cluster-${index}`, col: 4 + index, row: 5 }),
      );
      return {
        view: "floor",
        cols: 16,
        rows: 16,
        desks: new Map(
          seats.map((seat, index) => [
            `cluster-${index}`,
            { ...seat, agentId: `cluster-${index}` },
          ]),
        ),
        seats: new Map(seats.map((seat) => [seat.seatId, seat])),
        signs: [],
        rooms: [],
        floors: [emptyFloor()],
        doorTile: { col: 0, row: 0 },
        lobbyTile: { col: 0, row: 1 },
        props: [],
        walkable: allWalkable(16, 16),
        frozen: null,
        shiftFromPrevious: null,
        stable: true,
      };
    }

    function clusterAgents(): ReadonlyArray<CommGraphAgentNode> {
      return CLUSTER_NAMES.map((name, index) =>
        agent(`cluster-${index}`, name),
      );
    }

    function renderCluster(): void {
      const layout = clusterLayout();
      const view: OfficeView = { ...OFFICE_VIEWS.floor, plan: () => layout };
      const clusterAgentNodes = clusterAgents();
      render(
        withQueryClient(
          cloneElement(
            officeElementWithView(
              view,
              new Set(clusterAgentNodes.map((person) => person.id)),
              clusterAgentNodes,
              {},
            ),
            { view: CLUSTER_CAMERA_VIEW },
          ),
        ),
      );
      setIntersecting(true);
      flushRaf(3);
    }

    async function findFor(query: string): Promise<void> {
      await act(async () => {
        await latestFindAdapter().search({
          requestId: 1,
          query,
          matchCase: false,
        });
      });
    }

    /**
     * Every `fillText` pass that NAMES this agent, truncation included - the
     * same shape as N1's `namePaints`, reused here because the tag path
     * truncates a long name while Find does not, and an exact-match count
     * would miss the truncated tag exactly as it did before N1's fixup.
     */
    function namePaints(name: string): number {
      return paintedText().filter(
        (text) =>
          text === name ||
          (text.endsWith("…") && name.startsWith(text.slice(0, -1))),
      ).length;
    }

    it("names the DROPPED agent through Find, exactly once", async () => {
      renderCluster();
      // The rightmost desk (highest centerX): `layoutNameTags` sorts
      // ascending and has exhausted both shifts on its three neighbours by
      // the time it is reached, so its ordinary tag never gets a slot.
      const dropped = "Walrus Dense Tag Name";
      await findFor(dropped);
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      expect(namePaints(dropped)).toBe(PASSES_PER_LABEL);
    });

    it("control: a PLACED agent's tag is not doubled by Find", async () => {
      renderCluster();
      // The leftmost desk takes the first slot at its own anchor and is
      // never displaced - `drawNameTags` reports it as placed, so Find must
      // stay silent for it.
      const placed = "Zebra Overflow Name";
      await findFor(placed);
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      expect(namePaints(placed)).toBe(PASSES_PER_LABEL);
    });
  });

  /**
   * The render loop's effect used to list `applyCanvasSize`, `peekScene` and
   * `syncLodBand` as dependencies beside `officeView`, `resolvedTheme` and
   * `runtime` - three callbacks whose own identity is stable across every
   * interaction below, so the listing cost nothing YET. But an identity
   * change in any one of them tears the whole loop down, and the cleanup
   * calls `staticLayer.release()`, throwing away the floor's baked bitmap -
   * the most expensive thing the tile holds. These cases pin the loop's
   * actual restart count through real interactions, which is the fix's
   * point: a callback identity change should not be able to cost the office
   * its floor, whether or not one happens to change today.
   */
  describe("CommGraphOfficeCanvas fixup 5 - the render loop restarts only for a view pick or a theme flip", () => {
    /**
     * `getContext` is also how the floor's static layer bakes an offscreen
     * chunk - a fresh `document.createElement("canvas")` per bake, never
     * inserted into the document - so counting every call would drown the
     * one this suite cares about in bakes that have nothing to do with the
     * render loop restarting. Only a CONNECTED canvas is the one the loop's
     * own `get2dContext` opened on mount, once per effect activation - a
     * START. A restart is a START of a new loop AND a RELEASE of the old
     * layer's bitmap, so `OfficeStaticLayer.prototype.release` is spied on
     * too: a case that only checked one of the two could not tell "the loop
     * never restarted" from "the loop restarted without releasing anything",
     * which is its own way of losing a floor's memory.
     */
    let mainCanvasContextCalls = 0;
    let totalCanvasContextCalls = 0;
    let restoreMainCanvasGetContext: (() => void) | null = null;
    let releaseSpy: MockInstance<() => void>;

    beforeEach(() => {
      mainCanvasContextCalls = 0;
      totalCanvasContextCalls = 0;
      restoreMainCanvasGetContext = stubGetContext(
        function (this: HTMLCanvasElement) {
          if (this.isConnected) mainCanvasContextCalls += 1;
          totalCanvasContextCalls += 1;
          return createRecordingContext(calls);
        },
      );
      releaseSpy = vi.spyOn(OfficeStaticLayer.prototype, "release");
    });

    afterEach(() => {
      restoreMainCanvasGetContext?.();
      restoreMainCanvasGetContext = null;
      vi.useRealTimers();
      // The custom-theme case writes to the REAL theme library store (it is
      // not mocked, deliberately) to move a REAL revision - put back so a
      // later test in this file does not inherit a non-default contrast.
      useThemeLibraryStore.setState({ contrast: 100 });
    });

    const RESTART_VIEW: CommGraphTileViewState = { ...FIXED_CAMERA_VIEW };

    // REQUIRED, with `{}` written out at every caller that wants nothing.
    // A parameter default is the same ban as an optional parameter: the root
    // AGENTS list has both, and neither linter carries either.
    function renderLoop(overrides: Partial<CommGraphOfficeCanvasProps>): {
      readonly result: RenderResult;
      readonly officeView: OfficeView;
    } {
      const officeView = walkInView();
      const result = render(
        withQueryClient(
          officeElementWithView(
            officeView,
            new Set(["host", "worker"]),
            [HOST_AGENT, WALKER_AGENT],
            { view: RESTART_VIEW, ...overrides },
          ),
        ),
      );
      setIntersecting(true);
      flushRaf(1);
      // The mount itself opened the canvas's one context; only what happens
      // AFTER this point is an "interaction" for the cases below.
      mainCanvasContextCalls = 0;
      releaseSpy.mockClear();
      return { result, officeView };
    }

    /**
     * Runs frames until the floor stops drawing, and PROVES it stopped.
     *
     * The office `renderLoop` builds is idle: despite the helper's name the
     * first sync seats both agents, so nothing walks and `isAnimating` is
     * false from the start. The gate still paints the first frame - its
     * last-drawn minute begins at -1 - and only then refuses, so a case that
     * measures straight after mount is measuring the settling frames, not a
     * parked office.
     *
     * "Draws nothing" has to mean the DRAW PATH did not run, not merely that
     * nothing got ALLOCATED: a frame built from an already-cached bitmap and
     * already-cached sprites allocates zero canvases either way, so
     * `totalCanvasContextCalls` alone cannot tell "refused" from "drew, had
     * nothing new to bake." `OfficeScene.prototype.frame` is the proxy for an
     * actual drawn frame - this suite's own `lastFramedRect` already commits
     * to that reading ("the world rect of the most recent frame, or `null` if
     * NONE WAS DRAWN"), and the call site sits at the one spot between the
     * gate's refusal and every downstream draw call that nothing skips: the
     * gate's `if (!draw) { … return; }` returns before camera work, shift,
     * auto-fit, `advanceCamera`, `trackLodBand` and `worldRectOf` - all of
     * which run unconditionally on a drawn frame, ending in this one call.
     * `scene.isAnimating` is NOT this proxy: it is read as an argument to
     * `shouldDraw` itself, so it runs on a REFUSED frame too.
     *
     * The spy is the CALLER's, not this helper's: a shared helper that owned
     * its own spy would need either a fresh one per call (restored how?) or
     * one that outlives the office it was taken on, and a caller comparing
     * against the wrong office's call count would never know. Passed in, the
     * caller reads a `calls.length` DELTA across exactly the frames it cares
     * about - which is also why the returned allocation count is a courtesy
     * for callers that still want it, never a thing this helper asserts on
     * its own: mount already drew and baked before this runs.
     */
    function settleUntilParked(frames: SpiedCalls): number {
      for (let settle = 0; settle < 8; settle += 1) {
        flushRaf(1);
      }
      const parked = totalCanvasContextCalls;
      const drawnBeforeSettling = frames.mock.calls.length;
      flushRaf(1);
      expect(totalCanvasContextCalls).toBe(parked);
      expect(frames.mock.calls.length - drawnBeforeSettling).toBe(0);
      return parked;
    }

    /**
     * A native wheel WITHOUT a modifier key pans; the camera it moves lives
     * on `runtime`, a `useState` initial value the render loop's effect does
     * not depend on, so this is a case where the real interaction and the
     * question "did the loop restart" are provably about two different
     * things - unlike a `view` prop rerender, which changes nothing the
     * component actually reads for panning and would only ever measure
     * itself.
     */
    it("a pan does not restart the loop", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const onCameraChange = vi.fn();
      renderLoop({ onCameraChange });
      const surface = screen.getByTestId("comm-graph-office-canvas");

      fireEvent.wheel(surface, { deltaX: 40, deltaY: 25 });
      act(() => {
        vi.advanceTimersByTime(150);
      });

      // Precondition: the camera actually moved. `panBy` subtracts the wheel
      // delta from the mounted view's (5, 0).
      expect(onCameraChange).toHaveBeenCalledWith({ x: -35, y: -25, zoom: 1 });

      expect(mainCanvasContextCalls).toBe(0);
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    /**
     * A native wheel WITH a modifier key zooms about the cursor, and
     * `zoomAbout` calls `syncLodBand` synchronously - so the chip is the
     * precondition, not a flushed frame.
     */
    it("a lod-band change does not restart the loop", () => {
      renderLoop({});
      const surface = screen.getByTestId("comm-graph-office-canvas");
      const chip = screen.getByTestId("comm-graph-office-lod-chip");
      expect(chip.textContent).toBe("Office");

      // factor = exp(-300 / 300) = exp(-1) ≈ 0.368, below the 0.7 floor.
      fireEvent.wheel(surface, {
        deltaY: 300,
        ctrlKey: true,
        clientX: 0,
        clientY: 0,
      });
      expect(chip.textContent).toBe("Overview");

      // factor = exp(600 / 300) = exp(2) ≈ 7.39; 0.368 * 7.39 ≈ 2.72, above
      // the 1.6 ceiling.
      fireEvent.wheel(surface, {
        deltaY: -600,
        ctrlKey: true,
        clientX: 0,
        clientY: 0,
      });
      expect(chip.textContent).toBe("Close-up");

      expect(mainCanvasContextCalls).toBe(0);
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    /**
     * `applyCanvasSize` reads the CONTAINER's measured rect, so the real
     * trigger is that rect actually reporting a new size before the resize
     * listener runs - the stubbed `getBoundingClientRect` this whole describe
     * installs never changes on its own, which is exactly why a bare
     * `dispatchEvent` proves nothing without it.
     */
    it("a resize does not restart the loop", () => {
      renderLoop({});
      const canvas = document.querySelector("canvas");
      if (canvas === null) throw new Error("canvas did not render");
      expect(canvas.width).toBe(1200);
      expect(canvas.height).toBe(800);

      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        ...BOUNDING_RECT_STUB,
        width: 1600,
        height: 900,
        right: 1600,
        bottom: 900,
      });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });

      // Precondition: the bitmap actually resized.
      expect(canvas.width).toBe(1600);
      expect(canvas.height).toBe(900);

      expect(mainCanvasContextCalls).toBe(0);
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it("a view pick restarts the loop exactly once", () => {
      const { result } = renderLoop({});
      act(() => {
        result.rerender(
          withQueryClient(
            // A distinct `OfficeView` identity - the picker's own contract -
            // rather than a mutation of the one already mounted.
            officeElementWithView(
              OFFICE_VIEWS.towers,
              new Set(["host", "worker"]),
              [HOST_AGENT, WALKER_AGENT],
              { view: RESTART_VIEW },
            ),
          ),
        );
      });

      expect(mainCanvasContextCalls).toBe(1);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("a theme flip restarts the loop exactly once", () => {
      const { result, officeView } = renderLoop({});
      resolvedThemeMock.current = "dark";
      act(() => {
        result.rerender(
          withQueryClient(
            officeElementWithView(
              officeView,
              new Set(["host", "worker"]),
              [HOST_AGENT, WALKER_AGENT],
              { view: RESTART_VIEW },
            ),
          ),
        );
      });

      expect(mainCanvasContextCalls).toBe(1);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    /**
     * `peekScene` closes over `epicId` alone, so an `epicId` change is the
     * one thing that makes it return null for what `ensureScene` then treats
     * as a fresh epic - and that is exactly the case the render loop must
     * restart for: a scene swapped out from under a stale bitmap, with
     * nothing else about the effect's own dependencies moving.
     *
     * ONE `OfficeView` object, reused for both renders - its `plan` reads a
     * mutable flag rather than closing over a fixed layout, so `officeView`
     * keeps one identity across the swap. `officeView` is already, correctly,
     * a dependency of the render loop's effect; if the case handed it a new
     * object per epic (the obvious way to get a "different roster"), a
     * restart would prove nothing about `epicId` - the officeView change
     * alone would explain it, on the buggy code same as the fixed one.
     */
    function inPlaceEpicSwapView(): {
      readonly officeView: OfficeView;
      readonly useOtherLayout: () => void;
    } {
      const firstHost = seatAt({ seatId: "h/0/first-host", col: 2, row: 2 });
      const firstWorker = seatAt({
        seatId: "h/0/first-worker",
        col: 12,
        row: 12,
      });
      const firstLayout: OfficeLayout = {
        view: "floor",
        cols: 16,
        rows: 16,
        desks: new Map([
          ["host", { ...firstHost, agentId: "host" }],
          ["worker", { ...firstWorker, agentId: "worker" }],
        ]),
        seats: new Map([
          ["h/0/first-host", firstHost],
          ["h/0/first-worker", firstWorker],
        ]),
        signs: [],
        rooms: [],
        floors: [emptyFloor()],
        doorTile: { col: 0, row: 0 },
        lobbyTile: { col: 0, row: 1 },
        props: [],
        walkable: allWalkable(16, 16),
        frozen: null,
        shiftFromPrevious: null,
        stable: true,
      };
      const otherHost = seatAt({ seatId: "h/0/other-host", col: 6, row: 6 });
      const otherWorker = seatAt({
        seatId: "h/0/other-worker",
        col: 10,
        row: 10,
      });
      // A DIFFERENT roster of the same size, seated at different tiles - the
      // floor drawables genuinely differ, so this is a stale bitmap that
      // would otherwise survive the swap, not an empty scene that would hide
      // the bug either way.
      const otherLayout: OfficeLayout = {
        ...firstLayout,
        desks: new Map([
          ["other-host", { ...otherHost, agentId: "other-host" }],
          ["other-worker", { ...otherWorker, agentId: "other-worker" }],
        ]),
        seats: new Map([
          ["h/0/other-host", otherHost],
          ["h/0/other-worker", otherWorker],
        ]),
      };
      let layout = firstLayout;
      return {
        officeView: { ...OFFICE_VIEWS.floor, plan: () => layout },
        useOtherLayout: () => {
          layout = otherLayout;
        },
      };
    }

    const OTHER_EPIC_HOST = agent("other-host", "Beta Sitter");
    const OTHER_EPIC_WORKER = agent("other-worker", "Beta Walker");

    it("an in-place epicId change restarts the loop exactly once", () => {
      const { officeView, useOtherLayout } = inPlaceEpicSwapView();
      const result = render(
        withQueryClient(
          officeElementWithView(
            officeView,
            new Set(["host", "worker"]),
            [HOST_AGENT, WALKER_AGENT],
            { view: RESTART_VIEW },
          ),
        ),
      );
      setIntersecting(true);
      flushRaf(1);
      // The mount itself opened the canvas's one context; only what happens
      // AFTER this point is an "interaction" for the case below.
      mainCanvasContextCalls = 0;
      releaseSpy.mockClear();

      useOtherLayout();
      act(() => {
        result.rerender(
          withQueryClient(
            // Same `officeView` object as the mount - only `epicId` and the
            // roster move.
            officeElementWithView(
              officeView,
              new Set(["other-host", "other-worker"]),
              [OTHER_EPIC_HOST, OTHER_EPIC_WORKER],
              { view: RESTART_VIEW, epicId: "epic-2" },
            ),
          ),
        );
      });

      expect(mainCanvasContextCalls).toBe(1);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    /**
     * A CUSTOM theme repaints the whole cascade without moving the mode or
     * the preset - `resolvedTheme` (the mocked hook above) never sees it, so
     * the ONLY signal that a repaint happened is `useThemeRevision()`, which
     * runs for real against the real applier (nothing in this file mocks it).
     * Verified directly before building this on it: a real
     * `useThemeLibraryStore.setState({ contrast: … })` does move
     * `getThemeRevision()` under jsdom.
     *
     * `themeRevision` sits in the static layer's KEY, read through
     * `useEffectEvent`, so the loop's own effect never restarts for it - the
     * rebuild happens inside the SAME effect instance, on the next drawn
     * frame's `sync()` call. That means neither of the two counters this
     * describe already has can see it directly:
     * `mainCanvasContextCalls` only counts `getContext` on the CONNECTED
     * canvas (the loop's own, opened once per effect activation), and
     * `releaseSpy` watches the PUBLIC `OfficeStaticLayer.release()`, which is
     * only ever called at effect cleanup - a key mismatch inside `sync()`
     * drops chunks through the class's PRIVATE `releaseChunks()` instead
     * (confirmed by reading `office-static-layer.ts`), so neither fires here
     * even on a genuine rebuild.
     *
     * What DOES change, confirmed empirically first: a dropped chunk with no
     * held survivor is baked fresh on the next `hold()`, which allocates a
     * brand-new offscreen canvas - one more `getContext` call, on a
     * DISCONNECTED canvas this time. `totalCanvasContextCalls` (every
     * `getContext` call, connected or not) is what makes that visible from
     * outside the component: a delta of exactly 1 there, with
     * `mainCanvasContextCalls` still 0, is "the layer rebuilt once and the
     * loop did not restart" - the actual pair this case has to prove, not
     * the release-spy pair the other positives use, since those restart the
     * whole effect and this deliberately does not.
     */
    it("a custom-theme change rebuilds the layer exactly once and leaves the loop alone", () => {
      renderLoop({});
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const totalBefore = settleUntilParked(frames);
      const drawnBefore = frames.mock.calls.length;

      act(() => {
        // In the schema's own range (70-130), so this is a contrast a user
        // can really pick - `setState` would take an out-of-range one, but
        // then the case would rest on a state the store rejects.
        useThemeLibraryStore.setState({ contrast: 120 });
      });
      flushRaf(1);

      // Precondition: the revision actually moved, and not because of a
      // mode change - `resolvedTheme` stays mocked to "light" throughout.
      expect(resolvedThemeMock.current).toBe("light");
      expect(totalCanvasContextCalls - totalBefore).toBe(1);
      // The draw path itself ran exactly once for the bump - the allocation
      // count alone cannot distinguish "drew and rebuilt" from "drew and had
      // nothing to rebuild", and a gate defeated into always drawing would
      // still show a delta of 1 on the allocation count here by coincidence.
      expect(frames.mock.calls.length - drawnBefore).toBe(1);
      expect(mainCanvasContextCalls).toBe(0);
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    /**
     * The control that stops the fix being "always draw".
     *
     * `invalidateFrame` on a revision change buys ONE frame. Nothing else may
     * buy any: if a parked office drew even one frame per rAF without a reason,
     * the case above would pass for the wrong reason and the tile would be
     * burning a bake a frame forever. Deliberately several flushes, not one.
     *
     * The allocation assertion is kept alongside the draw-path one, not in
     * place of it: a gate planted to always draw still allocates nothing once
     * the bitmap and sprites are cached, so the allocation count alone cannot
     * fail here even though the defect it is meant to guard would be live -
     * the draw-path delta is the one that actually carries this case.
     */
    it("an idle office draws nothing while the revision holds still", () => {
      renderLoop({});
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      const parked = settleUntilParked(frames);
      const drawnAtPark = frames.mock.calls.length;

      flushRaf(6);

      expect(totalCanvasContextCalls).toBe(parked);
      expect(frames.mock.calls.length - drawnAtPark).toBe(0);
      expect(mainCanvasContextCalls).toBe(0);
      expect(releaseSpy).not.toHaveBeenCalled();
    });
  });
});

describe("CommGraphOfficeCanvas fixup 2 - real Towers semantic zoom", () => {
  let rafQueue: Array<{
    readonly id: number;
    readonly callback: FrameRequestCallback;
  }> = [];
  let nextRafId = 1;
  let canceledRafIds = new Set<number>();
  let calls: RecordedCall[] = [];
  let restoreGetContext: (() => void) | null = null;

  function flushRaf(times: number): void {
    for (let step = 0; step < times; step += 1) {
      const pending = rafQueue;
      rafQueue = [];
      act(() => {
        for (const queued of pending) {
          if (!canceledRafIds.has(queued.id))
            queued.callback(performance.now());
        }
      });
    }
  }

  beforeEach(() => {
    activeObserverCallbacks = [];
    vi.stubGlobal("IntersectionObserver", ControllableIntersectionObserver);
    calls = [];
    rafQueue = [];
    canceledRafIds = new Set();
    nextRafId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextRafId;
      nextRafId += 1;
      rafQueue.push({ id, callback });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      canceledRafIds.add(id);
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      BOUNDING_RECT_STUB,
    );
    restoreGetContext = stubGetContext(() => createRecordingContext(calls));
  });

  afterEach(() => {
    cleanup();
    restoreGetContext?.();
    restoreGetContext = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const REAL_TOWERS_AGENTS = [
    ORCHESTRATOR,
    REVIEWER,
    HOST_B_LEAD,
    HOST_B_MEMBER,
  ];

  function realTowersAtZoom(zoom: number) {
    return cloneElement(
      officeElementWithView(
        OFFICE_VIEWS.towers,
        new Set(REAL_TOWERS_AGENTS.map((person) => person.id)),
        REAL_TOWERS_AGENTS,
        {},
      ),
      { view: { ...FIXED_CAMERA_VIEW, zoom } },
    );
  }

  function realTowersFocusedAtZoom(zoom: number) {
    const agents = REAL_TOWERS_AGENTS.map(officeAgentInput);
    const statusById = new Map<string, OfficeAgentStatus>();
    const scene = new OfficeScene(OFFICE_VIEWS.towers, null);
    scene.sync({
      agents,
      visibleAgentIds: new Set(agents.map((person) => person.id)),
      statusById,
      partition: partitionOfficePopulation({
        agents,
        statusById,
        previous: null,
      }),
      activityById: new Map(),
      viewport: { width: 1200, height: 800 },
      pulse: null,
      pulseKey: null,
      stepMs: BASE_STEP_MS,
      cursorMs: null,
      clockMs: 0,
      openRequestsByReceiver: new Map(),
      playing: false,
      reducedMotion: false,
    });
    const focus = scene.locate(ORCHESTRATOR.id);
    if (focus === null) throw new Error("expected a real Towers character");
    return cloneElement(
      officeElementWithView(
        OFFICE_VIEWS.towers,
        new Set(REAL_TOWERS_AGENTS.map((person) => person.id)),
        REAL_TOWERS_AGENTS,
        {},
      ),
      {
        view: {
          ...FIXED_CAMERA_VIEW,
          zoom,
          x: 600 - (focus.x + focus.width / 2) * zoom,
          y: 400 - (focus.y + focus.height / 2) * zoom,
        },
      },
    );
  }

  function realAgentNameCalls(): ReadonlyArray<RecordedCall> {
    return calls.filter(
      (call) =>
        call.method === "fillText" &&
        REAL_TOWERS_AGENTS.some((person) => call.args[0] === person.name),
    );
  }

  it("draws no host or agent text for real two-host Towers at LOD 0", () => {
    render(withQueryClient(realTowersAtZoom(0.5)));
    setIntersecting(true);
    flushRaf(4);
    expect(calls.filter((call) => call.method === "fillText")).toHaveLength(0);
  });

  it("draws a qualified real Towers name at LOD 1 when selected", () => {
    render(withQueryClient(realTowersFocusedAtZoom(1)));
    fireEvent.click(
      screen.getByTestId(`comm-graph-office-agent-${ORCHESTRATOR.id}`),
    );
    setIntersecting(true);
    flushRaf(4);
    expect(
      calls.filter(
        (call) =>
          call.method === "fillText" && call.args[0] === ORCHESTRATOR.name,
      ),
    ).not.toHaveLength(0);
  });

  it("draws a qualified real Towers name at LOD 1 when hovered", () => {
    render(withQueryClient(realTowersFocusedAtZoom(1)));
    fireEvent.pointerEnter(
      screen.getByTestId(
        `comm-graph-office-directory-agent-${ORCHESTRATOR.id}`,
      ),
    );
    setIntersecting(true);
    flushRaf(4);
    expect(
      realAgentNameCalls().some((call) => call.args[0] === ORCHESTRATOR.name),
    ).toBe(true);
  });

  it("draws a qualified real Towers name when Find matches it", async () => {
    render(withQueryClient(realTowersFocusedAtZoom(1)));
    await act(async () => {
      await latestFindAdapter().search({
        requestId: 101,
        query: ORCHESTRATOR.name,
        matchCase: true,
      });
    });
    setIntersecting(true);
    flushRaf(4);
    expect(
      calls.filter(
        (call) =>
          call.method === "fillText" && call.args[0] === ORCHESTRATOR.name,
      ),
    ).not.toHaveLength(0);
  });

  it("draws every visible real Towers name at LOD 2", () => {
    render(withQueryClient(realTowersAtZoom(2)));
    setIntersecting(true);
    flushRaf(4);
    const names = new Set(realAgentNameCalls().map((call) => call.args[0]));
    for (const person of REAL_TOWERS_AGENTS)
      expect(names.has(person.name)).toBe(true);
  });

  it("does not draw unqualified real Towers name tags at office lod", () => {
    const agents = [ORCHESTRATOR, REVIEWER, HOST_B_LEAD, HOST_B_MEMBER];
    const visibleIds = new Set(agents.map((person) => person.id));
    render(
      withQueryClient(
        officeElementWithView(OFFICE_VIEWS.towers, visibleIds, agents, {}),
      ),
    );
    setIntersecting(true);
    flushRaf(4);

    const nameCalls = calls.filter(
      (call) =>
        call.method === "fillText" &&
        agents.some((person) => call.args[0] === person.name),
    );
    expect(nameCalls).toHaveLength(0);
  });
});

describe("CommGraphOfficeCanvas fixup 5 - the directory's quiet tally", () => {
  it("counts every cold team's members and the quiet solos in the footer's quiet total", () => {
    // `buildSections` used to compute the quiet tally as
    // `teams.filter((team) => !live.includes(team))` - a membership test
    // inside a filter over every team, quadratic in the team count and
    // re-run on every render including every keystroke in the search box
    // (react-doctor's `js-set-map-lookups`, T7's acceptance pass). The fix
    // decides liveness once per team and reads it twice; this pins the
    // OUTCOME of that read, not the mechanism, so it stays green across a
    // rewrite that keeps the number right.
    //
    // The existing "renders directory rows from the partition and
    // statusById" case only ever asserts the quiet count against a fixture
    // with NO TEAMS AT ALL - the team half of the sum (`quietTeamMembers`)
    // is `0` there and dropping it entirely still leaves that case green.
    // This fixture has teams, all of them cold, specifically to close that
    // gap: it goes red if the team tally is ever dropped back to just the
    // quiet solos.
    const fixture = makeTestEpic("triage", 15, 1);
    // Every member idle: `isOfficeHotStatus` is true for `working`,
    // `awaiting`, `attention`, `failure` and `background`, and false only for
    // `idle` and `archived` - so this makes every team on the floor cold and
    // every solo quiet, with nobody left to populate a bullpen.
    const statusById = new Map(
      fixture.agents.map((agent) => [agent.id, "idle" as const]),
    );
    const partition = partitionOfficePopulation({
      agents: fixture.agents,
      statusById,
      previous: null,
    });
    const teams = partition.hosts.flatMap((host) => host.teams);
    // Asserted rather than assumed: if `makeTestEpic`'s shape ever changes
    // and stops producing more than one team at this count, this case must
    // fail loudly instead of quietly degrading into the zero-team situation
    // the existing case already covers.
    expect(teams.length).toBeGreaterThanOrEqual(2);
    expect(teams.every((team) => !team.live)).toBe(true);

    const visibleAgentIds = new Set(fixture.agents.map((agent) => agent.id));
    const coldTeamMembers = teams.reduce(
      (total, team) => total + team.memberAgentIds.length,
      0,
    );
    const quietSolos = partition.hosts
      .flatMap((host) => host.solos)
      .filter(
        (solo) => !isOfficeHotStatus(statusById.get(solo.agentId)),
      ).length;
    // The host's HQ (`agent-root` here) gets its own row and is never folded
    // into Quiet - the existing F5-adjacent case's own comment makes the
    // same point about why a visible HQ does not inflate this count.
    const expectedQuiet = coldTeamMembers + quietSolos;

    render(
      <OfficeDirectoryPanel
        partition={partition}
        visibleAgentIds={visibleAgentIds}
        statusById={statusById}
        nameById={
          new Map(fixture.agents.map((agent) => [agent.id, agent.name]))
        }
        hostNameById={new Map()}
        selectedAgentId={null}
        onSelectAgent={vi.fn()}
        onHoverAgent={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("comm-graph-office-directory-quiet").textContent,
    ).toBe(
      `Quiet · ${expectedQuiet} idle or archived · ${teams.length} cold ` +
        `${teams.length === 1 ? "team" : "teams"}`,
    );
  });
});

describe("CommGraphOfficeCanvas fixup 8 - the caught-up feed is not an input to the canvas's own first plan (H1)", () => {
  it("plans its first scene while ready and the feed is behind - the flag never reaches this seam", () => {
    // `officeElement`'s own defaults already carry `ready` and an
    // uncaught-up feed (`initialHistoryCaughtUp={false}`) - passed
    // explicitly here so the case reads as the fact under test rather than
    // an accident of the helper's defaults. Before fixup 8 the canvas
    // itself gated its first plan on `ready`, which the TILE computed from
    // `inputsReady` (feed included); this seam proves the canvas's own plan
    // no longer needs the feed at all, only `ready` and eligibility.
    const plan = vi.spyOn(OFFICE_VIEWS.floor, "plan");
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), STATIC_OFFICE, {
          ready: true,
          initialHistoryCaughtUp: false,
        }),
      ),
    );
    setIntersecting(true);
    setCanvasSize({ width: 1040, height: 700 });

    expect(plan).toHaveBeenCalled();
  });

  it("shows the catching-up chip while ready and the feed is behind", () => {
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), STATIC_OFFICE, {
          ready: true,
          initialHistoryCaughtUp: false,
        }),
      ),
    );

    expect(
      screen.getByTestId("comm-graph-office-catching-up-chip"),
    ).toBeDefined();
  });

  it("hides the catching-up chip once the feed has caught up", () => {
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), STATIC_OFFICE, {
          ready: true,
          initialHistoryCaughtUp: true,
        }),
      ),
    );

    expect(
      screen.queryByTestId("comm-graph-office-catching-up-chip"),
    ).toBeNull();
  });

  it("hides the catching-up chip while not ready, even with the feed behind", () => {
    render(
      withQueryClient(
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), STATIC_OFFICE, {
          ready: false,
          initialHistoryCaughtUp: false,
        }),
      ),
    );

    expect(
      screen.queryByTestId("comm-graph-office-catching-up-chip"),
    ).toBeNull();
  });
});
