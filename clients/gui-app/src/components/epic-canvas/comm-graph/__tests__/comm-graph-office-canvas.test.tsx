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
  return { ...actual, useEpicAgentActivityTiers: () => new Map() };
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CommGraphOfficeCanvas } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import {
  commGraphPairId,
  type CommGraphAgentNode,
} from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { BASE_STEP_MS } from "@/components/epic-canvas/comm-graph/use-comm-graph-transport";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { officeModelTier } from "@/lib/comm-graph/office/office-model-tier";
import type {
  OfficeAgentInput,
  OfficeRect,
  OfficeSceneInput,
} from "@/lib/comm-graph/office/office-types";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import type { TileFindAdapter } from "@/stores/tile-find";

const OFFICE_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
  mode: "office",
};

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

interface OfficeRenderOptions {
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly pulse: CommGraphPulse | null;
  readonly pulseKey: string | null;
}

const STATIC_OFFICE: OfficeRenderOptions = {
  events: [],
  pulse: null,
  pulseKey: null,
};

function officeElement(
  visibleIds: ReadonlySet<string>,
  options: OfficeRenderOptions,
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
      playing={false}
      pulse={options.pulse}
      pulseKey={options.pulseKey}
      modeToggle={null}
      view={OFFICE_VIEW}
      onViewChange={vi.fn()}
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

function renderOffice(visibleIds: ReadonlySet<string>) {
  return render(withQueryClient(officeElement(visibleIds, STATIC_OFFICE)));
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
  const scene = new OfficeScene(layoutOffice);
  const agents = [ORCHESTRATOR, REVIEWER].map(officeAgentInput);
  const base: OfficeSceneInput = {
    agents,
    visibleAgentIds: visibleIds,
    statusById: new Map(),
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
  const regions = scene.frame().envelopeHitRegions;
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
});
