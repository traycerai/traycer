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

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

// `useEpicAgentActivityTiers` resolves the open-epic session handle, which this
// suite has no use for: the office statuses it feeds are covered in
// `lib/comm-graph/office/__tests__/office-status.test.ts`. PARTIAL, because the
// detail panel this suite opens reaches other selectors in the same module.
vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return {
    ...actual,
    useEpicAgentActivityTiers: () => new Map(),
    // The office reads every agent's role claims in one bulk selector for the
    // door plates; like the activity tiers above, it resolves an epic session
    // this suite deliberately renders without.
    useEpicAgentRoleClaimsByAgentId: () => ({}),
  };
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { officeModelTier } from "@/lib/comm-graph/office/office-model-tier";
import {
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSign,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import type { TileFindAdapter } from "@/stores/tile-find";
import type { CommGraphOfficeCanvasProps } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";

const OFFICE_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
  mode: "office",
  officeView: null,
  officeAutoView: null,
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
  overrides: Partial<CommGraphOfficeCanvasProps> = {},
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
  return render(withQueryClient(officeElement(visibleIds, STATIC_OFFICE)));
}

/** Stubs the office canvas container's measured box and re-triggers the resize path that reads it. */
function setCanvasSize(size: { width: number; height: number }): void {
  const container = screen.getByTestId("comm-graph-office-canvas");
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect(size),
  );
  fireEvent(window, new Event("resize"));
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
    const view = render(withQueryClient(officeElement(both, STATIC_OFFICE)));

    fireEvent.click(
      screen.getByTestId(`comm-graph-office-agent-${REVIEWER.id}`),
    );
    expect(screen.getByTestId("comm-graph-agent-panel")).toBeDefined();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);

    // The cursor moves back before Reviewer existed: it drops out of
    // agentIds, so the surface is handed the as-of set rather than the full
    // present-day roster.
    view.rerender(
      withQueryClient(officeElement(new Set([ORCHESTRATOR.id]), STATIC_OFFICE)),
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
    const view = render(withQueryClient(officeElement(both, STATIC_OFFICE)));
    setIntersecting(true);
    // A first render with no pulse, then the row: the scene deliberately does
    // not replay the row its very first sync arrives on.
    view.rerender(withQueryClient(officeElement(both, IN_FLIGHT)));
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
    const view = render(withQueryClient(officeElement(both, STATIC_OFFICE)));
    view.rerender(withQueryClient(officeElement(both, IN_FLIGHT)));
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
        officeElement(new Set([ORCHESTRATOR.id, REVIEWER.id]), {
          ...STATIC_OFFICE,
          playing: true,
        }),
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
    const view = render(withQueryClient(officeElement(both, STATIC_OFFICE)));
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
          officeElement(both, { ...STATIC_OFFICE, pulseKey: `row-${change}` }),
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
          autoChip: <OfficeAutoChip decision={decision} />,
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
          autoChip: <OfficeAutoChip decision={null} />,
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
});

/**
 * A recording 2D context: every call is captured as `{method, args}` rather
 * than executed against a real surface - jsdom has no canvas backend, and the
 * point of this harness is the ARGUMENTS a draw call was made with (a sign's
 * projected x, a name tag's call count), never a pixel. `measureText` and
 * `createImageData` get real-shaped answers because callers read their
 * return value; everything else is a recorder.
 */
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
        return (text: string) => ({ width: text.length * 6 });
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
};

function officeElementWithView(
  officeView: OfficeView,
  visibleIds: ReadonlySet<string>,
  agents: ReadonlyArray<CommGraphAgentNode>,
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

describe("CommGraphOfficeCanvas fixup 1 - renderer projection and semantic zoom (F5, F10)", () => {
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
      widthTiles: 2,
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

    render(withQueryClient(officeElementWithView(view, new Set<string>(), [])));
    setIntersecting(true);
    flushRaf(3);

    const fillTextCalls = calls.filter((call) => call.method === "fillText");
    // Found by the separator every board reading carries, at any width. A
    // TWO-tile board abbreviates by rule ("0D · 0W · 0I") rather than spelling
    // the buckets out, so matching on the word "DOING" would pin F11's layout
    // rule into a case that is only about WHERE the text lands.
    const boardTextCall = fillTextCalls.find(
      (call) =>
        typeof call.args[0] === "string" && call.args[0].includes(" · "),
    );
    expect(boardTextCall).toBeDefined();
    // Fixed camera (zoom 1, x=5, y=0): the projected anchor for tile (2,2)
    // with a two-tile board centred on it is x = 2048 + (2+1)*16 = 2096,
    // screenX = 2096 * 1 + 5 = 2101. The unfixed renderer instead multiplies
    // the raw tile by OFFICE_TILE with no projector at all, landing at
    // screenX = 3 * 16 + 5 = 53.
    expect(boardTextCall?.args[1]).toBe(2101);
  });

  it("F10: an unhovered, unselected, unmatched agent's name tag draws nothing at LOD 1", () => {
    const seat = {
      seatId: "h/0/worker",
      kind: "desk" as const,
      deskTile: { col: 4, row: 4 },
      chairTile: { col: 4, row: 5 },
      facing: "down" as const,
      hitTiles: { width: 1, height: 1 },
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
        officeElementWithView(view, new Set(["worker"]), [worker]),
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

  it("F11: gives an HQ board a different summary than an ordinary board over the same roster", () => {
    const roster = ["a", "b", "c", "d", "e"];
    const ordinaryBoard: OfficeSign = {
      kind: "board",
      tile: { col: 2, row: 2 },
      widthTiles: 2,
      text: "",
      ownerAgentId: null,
      hostId: null,
      agentIds: roster,
    };
    const hqBoard: OfficeSign = {
      kind: "hq-board",
      tile: { col: 8, row: 2 },
      widthTiles: 2,
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
      withQueryClient(officeElementWithView(view, new Set(roster), agents)),
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
});
