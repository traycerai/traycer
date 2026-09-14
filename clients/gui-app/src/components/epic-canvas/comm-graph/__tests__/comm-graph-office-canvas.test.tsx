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
import {
  useAppLocalNotificationsStore,
  type AppLocalNotificationEntry,
} from "@/stores/notifications/app-local-notifications-store";
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
  type OfficeBlockFill,
  type OfficeDrawable,
  type OfficeFloor,
  type OfficeHitRegion,
  type OfficeLayout,
  type OfficeLod,
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeCivicTally,
  type OfficeSign,
  type OfficeSpriteName,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import {
  officePalette,
  officeSpriteColors,
  officeSpriteMaps,
  officeSpriteSize,
  rasterizeSpriteMap,
  type RasterizedSprite,
} from "@/lib/comm-graph/office/office-pixel-art";
import * as OfficePixelArt from "@/lib/comm-graph/office/office-pixel-art";
import {
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_MONOSPACE_STACK,
  OFFICE_SIGN_PADDING_X,
  OFFICE_SIREN_FRAME_MS,
  officeSignsToDraw,
} from "@/lib/comm-graph/office/office-signs";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import type { TileFindAdapter } from "@/stores/tile-find";
import type { CommGraphOfficeCanvasProps } from "@/components/epic-canvas/comm-graph/office/comm-graph-office-canvas";
import { OfficeDirectoryPanel } from "@/components/epic-canvas/comm-graph/office/office-directory-panel";
import { OfficeStaticLayer } from "@/components/epic-canvas/comm-graph/office/office-static-layer";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";
import {
  OFFICE_LOD_CLOSEUP_ZOOM,
  OFFICE_LOD_OFFICE_ZOOM,
  officeLodForZoom,
} from "@/lib/comm-graph/office/office-lod";
import { NAME_TAG_LINE_HEIGHT } from "@/components/epic-canvas/comm-graph/office/office-name-tags";

const OFFICE_VIEW: CommGraphTileViewState = {
  x: 0,
  y: 0,
  zoom: 1,
  mode: "office",
  officeView: null,
  officeAutoView: null,
  officeCameraView: null,
  // Unread by this canvas, which is handed the PROJECTION the tile builds
  // (D68): `x`, `y` and `zoom` above are this suite's camera, and the office
  // canvas has no idea the field exists.
  officeCamera: null,
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

/**
 * PUTS A STATUS ON THE RENDERED POPULATION - the thing this suite could not do.
 *
 * Every Building and Floor office here rendered COLD, so every storey was
 * cubbies and every seat one tile: `canvasAgent` builds a `CommGraphAgentNode`,
 * which carries no status, and the canvas derives `statusById` itself from
 * sources none of these cases reached. `partitionOfficePopulation` then found
 * nothing live and nothing hot, `quietIds` returned every member, and the
 * civic layer - which IS status-driven placement - had nothing to draw.
 *
 * The canvas reads three sources, and two of them are reachable from a test
 * with no production change at all:
 *
 * - `awaiting` comes from `awaitingSenderIds(events, …)`, so it rides the
 *   `events` prop these cases already pass;
 * - `failure` comes from an unread, non-terminal app-local notification whose
 *   payload addresses the agent - which is this helper. The row has to be
 *   unread (`readAt: null`), carry the agent's own host, and NOT be one of the
 *   `terminal.*` kinds, which the indicator reads as a terminal failure and
 *   which `officeFlagKind` would then call `attention` rather than `failure`;
 * - `attention` additionally comes from the host indicator context, which is
 *   not needed here and is left alone.
 *
 * Deliberately the real selector path rather than a stubbed `statusById`: what
 * these cases are worth depends on the canvas deriving the status the way it
 * does in the app, and a stub would pass against a canvas that had stopped
 * reading the store at all.
 */
function seedFailure(agentId: string, hostId: string | null): void {
  // Annotated rather than inferred: an unannotated literal spread into
  // `setState` reports its mismatch against the whole store shape, which
  // buries the one field that is actually wrong under a page of union text.
  // Named here, a bad row points at itself.
  const row: AppLocalNotificationEntry = {
    id: `local-failure-${agentId}`,
    originHostId: hostId,
    updatedAt: 1,
    readAt: null,
    kind: "stream.transport.error",
    sourceRef: null,
    // `kind: "chat"` is the payload union's discriminant, not decoration:
    // `NotificationPayload` is a union over nine entity kinds and this is the
    // one that addresses an agent by `{epicId, chatId}`.
    payload: { kind: "chat", epicId: "epic-1", chatId: agentId },
    message: "stream failed",
    detail: null,
    displayedUpdatedAt: 1,
  };
  useAppLocalNotificationsStore.setState((state) => ({
    byId: { ...state.byId, [row.id]: row },
  }));
}

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

/**
 * `fitCamera`'s own formula, reproduced here because the function itself is
 * module-private - `comm-graph-office-canvas.tsx` never exports it. The
 * available box shrinks by `FIT_PADDING` (24px) on every side, the zoom that
 * fits what is left is capped at `MAX_FIT_ZOOM` (6x), and the camera centres
 * the floor inside the padded box. Both constants come straight off the
 * fixup 10 ticket's citation of the source, not a guess.
 */
function fitCameraLike(
  floor: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number; readonly zoom: number } {
  const FIT_PADDING = 24;
  const MAX_FIT_ZOOM = 6;
  const availableWidth = viewport.width - FIT_PADDING * 2;
  const availableHeight = viewport.height - FIT_PADDING * 2;
  const zoom = Math.min(
    MAX_FIT_ZOOM,
    Math.min(availableWidth / floor.width, availableHeight / floor.height),
  );
  return {
    zoom,
    x: (viewport.width - floor.width * zoom) / 2,
    y: (viewport.height - floor.height * zoom) / 2,
  };
}

/**
 * The two-agent fixture's floor (`ORCHESTRATOR` + `REVIEWER`), back-derived
 * from the existing "fits the whole floor to the tile on F" case just above:
 * at a 4400x2500 viewport it expects camera `{x: 88, y: 50, zoom: 6}`, and
 * that fit is SATURATED (zoom is pinned at `MAX_FIT_ZOOM`), so inverting
 * `fitCameraLike`'s own formula for zoom===6 gives
 * `floor.width = (4400 - 2*88) / 6 = 704` and
 * `floor.height = (2500 - 2*50) / 6 = 400`.
 *
 * GEOMETRY, RE-MEASURED: 688x304 while the Floor planned no civic rooms;
 * 704x400 now that the infirmary and the lounge stand in its amenity columns,
 * which widened the storey by one column and deepened it by six rows.
 */
const TWO_AGENT_FLOOR = { width: 704, height: 400 };

/**
 * Recovers the camera a frame was drawn with, given the viewport it was
 * drawn at - the inverse of the component's own private `worldRectOf`
 * (`x: -camera.x/zoom, y: -camera.y/zoom, width: viewport.width/zoom,
 * height: viewport.height/zoom`). Nothing in this suite holds a reference to
 * the runtime's camera object directly, so reading it back through the one
 * thing that IS observed - what the scene was asked to frame - is what lets
 * a case pin the exact camera a resize left behind, or prove it never moved.
 */
function cameraFromFrame(
  spy: SpiedCalls,
  viewport: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number; readonly zoom: number } | null {
  const rect = lastFramedRect(spy);
  if (rect === null || rect.width === 0) return null;
  const zoom = viewport.width / rect.width;
  return { zoom, x: -rect.x * zoom, y: -rect.y * zoom };
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
    feedSettled: false,
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
  // A STATE STACK for `save`/`restore`, same reason as `createRecordingContext`
  // above: `face` is otherwise a flat bag every assignment overwrites forever,
  // so a sign plate's `save()` … `letterSpacing = "0.08em"` … `restore()`
  // would leave THIS stub still answering 0.08em to whatever measures text
  // afterward - not a property of the renderer (a real browser unwinds it),
  // but of a double that never modeled `save`/`restore` at all. That single
  // shared `measuredWidths` cache in production is keyed by text alone, so a
  // leak here does not stay local to this test: it poisons the width any
  // LATER test in this file gets back for the same string, forever.
  const stack: Array<{ font: string; letterSpacing: string }> = [];
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
      if (key === "save") {
        return () => {
          stack.push({ ...face });
        };
      }
      if (key === "restore") {
        return () => {
          const previous = stack.pop();
          if (previous !== undefined) {
            face.font = previous.font;
            face.letterSpacing = previous.letterSpacing;
          }
        };
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
  useAppLocalNotificationsStore.setState({ byId: {} });
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
      feedSettled: false,
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
    //
    // GEOMETRY, RE-MEASURED: this was 4200x1900 expecting
    // `{x: 36, y: 38, zoom: 6}` while the two-agent Floor was 688x304px. The
    // civic rooms joined that plan's amenity columns and the storey grew to
    // 704x400px, at which 1900px of height no longer saturates the cap - so
    // the viewport is enlarged until it does again and the camera is the fit
    // formula's own answer for the new floor. The claim is unchanged: F fits
    // the whole floor, and persists after the debounce.
    setCanvasSize({ width: 4400, height: 2500 });

    const surface = screen.getByRole("img", {
      name: "Office view of the communication graph",
    });
    fireEvent.keyDown(surface, { key: "F" });

    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(onCameraChange).toHaveBeenCalledWith({ x: 88, y: 50, zoom: 6 });
  });

  /**
   * Fixup 10 (L5, live sitting): pressing Fit used to be a one-off the moment
   * a person had touched the camera even once beforehand, because
   * `takeManualControl` (which every path into `fitToFloor` calls on the way
   * in, to abandon a playback pan in flight) cleared auto-fit for good and
   * the old `fitToFloor` never re-armed it. So zoom in, press Fit, then
   * shrink the tile, and the camera kept the pre-shrink framing with the
   * floor cropped off-screen. These three cases drive the runtime the same
   * way `F`, the zoom buttons and a resize event do, and read the camera
   * back through the drawn frame (`cameraFromFrame`) rather than through
   * `onCameraChange`, because the claim under test is about the AUTOMATIC
   * re-fit a resize triggers, and that re-fit deliberately does not persist -
   * see the third case.
   */
  describe("fixup 10 - a Fit re-arms auto-fit for the next resize (L5)", () => {
    // Both viewports are chosen large enough to saturate `fitCamera`'s zoom
    // cap (6x) against this fixture's floor, which is what makes each
    // expected camera an exact, packing-independent number instead of a
    // fraction that would also have to reproduce `fitCamera`'s own packing
    // choice. `RESIZE_VIEWPORT` also isn't the SAME aspect ratio as
    // `FIT_VIEWPORT`, so a re-fit against it lands at a genuinely different
    // camera - a same-ratio resize would move `x`/`y` by a common scale
    // factor and could pass by coincidence even reading the wrong camera.
    //
    // GEOMETRY, RE-MEASURED: 4200x1900 and 4400x2000 saturated the cap while
    // the two-agent Floor was 688x304px; it is 704x400px now that its civic
    // rooms stand in the amenity columns, and neither old viewport clears
    // 6x400px of height. Both are enlarged until the cap is saturated again,
    // and they still differ in aspect ratio.
    const FIT_VIEWPORT = { width: 4400, height: 2500 };
    const RESIZE_VIEWPORT = { width: 5000, height: 2600 };

    it("re-fits on a resize after Fit, even though a zoom took manual control first", () => {
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      render(
        withQueryClient(
          officeElement(
            new Set([ORCHESTRATOR.id, REVIEWER.id]),
            STATIC_OFFICE,
            {},
          ),
        ),
      );
      // Eligible first, so a scene exists for `fitToFloor` to read a world
      // size from - `peekScene()` returns null otherwise and Fit would be a
      // no-op.
      setIntersecting(true);
      setCanvasSize(FIT_VIEWPORT);
      step();

      // The zoom is what takes manual control BEFORE the Fit - the sitting's
      // own sequence, and the ordering that pins the requirement rather than
      // a weaker version of it. `handleFit` takes manual control on the way
      // in whatever the camera was doing, so a plain Fit-then-resize is red
      // at `a73c629ba` as well; but that weaker sequence is also GREEN
      // against a "fix" that merely stopped the Fit button from taking
      // control at all - which would leave a playback pan in flight to
      // overwrite the framing a frame later, and would still crop after a
      // zoom. Only a Fit that re-arms auto-fit AFTER the take passes here.
      fireEvent.click(screen.getByTestId("comm-graph-office-zoom-in"));
      step();

      fireEvent.click(screen.getByTestId("comm-graph-office-fit"));
      step();

      // The resize itself never touches the camera - only `applyAutoFit`,
      // running inside the very next frame, does. Nothing repaints without a
      // `step()` here: jsdom's canvas has no 2d context of its own, so
      // `installCanvas` is what lets the frame loop run at all.
      setCanvasSize(RESIZE_VIEWPORT);
      step();

      const camera = cameraFromFrame(frames, RESIZE_VIEWPORT);
      if (camera === null) throw new Error("no frame drawn after the resize");
      const expected = fitCameraLike(TWO_AGENT_FLOOR, RESIZE_VIEWPORT);
      expect(camera.zoom).toBeCloseTo(expected.zoom);
      expect(camera.x).toBeCloseTo(expected.x);
      expect(camera.y).toBeCloseTo(expected.y);
    });

    it("leaves the camera exactly where a resize found it when the camera was taken again after Fit (guard on the standing rule; green before and after this fixup)", () => {
      const { step } = installCanvas();
      const frames = vi.spyOn(OfficeScene.prototype, "frame");
      render(
        withQueryClient(
          officeElement(
            new Set([ORCHESTRATOR.id, REVIEWER.id]),
            STATIC_OFFICE,
            {},
          ),
        ),
      );
      setIntersecting(true);
      setCanvasSize(FIT_VIEWPORT);
      step();

      fireEvent.click(screen.getByTestId("comm-graph-office-fit"));
      step();

      // The zoom lands AFTER the Fit this time, so it is what takes manual
      // control last - auto-fit stays off from here on, exactly as it always
      // has, fixup 10 or not. This is the guard: nothing about re-arming Fit
      // is supposed to touch a camera a person deliberately moved afterward.
      fireEvent.click(screen.getByTestId("comm-graph-office-zoom-in"));
      step();
      const afterZoom = cameraFromFrame(frames, FIT_VIEWPORT);
      if (afterZoom === null) throw new Error("no frame drawn after the zoom");

      setCanvasSize(RESIZE_VIEWPORT);
      step();
      const afterResize = cameraFromFrame(frames, RESIZE_VIEWPORT);
      if (afterResize === null) {
        throw new Error("no frame drawn after the resize");
      }

      expect(afterResize.zoom).toBeCloseTo(afterZoom.zoom);
      expect(afterResize.x).toBeCloseTo(afterZoom.x);
      expect(afterResize.y).toBeCloseTo(afterZoom.y);
    });

    it("persists the camera once for the Fit, and not again when the resize re-fits it automatically", () => {
      // `installCanvas` (which stubs `requestAnimationFrame` wholesale via
      // `vi.stubGlobal`) is set up BEFORE fake timers, and the fake timers
      // are restricted to `setTimeout`/`clearTimeout` - the same combination
      // the "a pan does not restart the loop" case above uses - so the rAF
      // stub `step()` drives stays untouched, and only the debounce
      // (`window.setTimeout` in `persistView`) is faked.
      const { step } = installCanvas();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const onCameraChange = vi.fn();
      render(
        withQueryClient(
          officeElement(
            new Set([ORCHESTRATOR.id, REVIEWER.id]),
            STATIC_OFFICE,
            { onCameraChange },
          ),
        ),
      );
      setIntersecting(true);
      setCanvasSize(FIT_VIEWPORT);
      step();

      fireEvent.click(screen.getByTestId("comm-graph-office-zoom-in"));
      step();

      fireEvent.click(screen.getByTestId("comm-graph-office-fit"));
      step();
      act(() => {
        vi.advanceTimersByTime(150);
      });
      // The zoom's own persist and the Fit's own persist share one debounce
      // timer (`persistView` clears whatever it last scheduled), so this is
      // the ONE write either of them makes - not a claim about the zoom
      // never persisting on its own.
      expect(onCameraChange).toHaveBeenCalledTimes(1);
      onCameraChange.mockClear();

      // `applyAutoFit` runs inside the frame loop and never calls
      // `persistView` - only `fitToFloor` (Fit itself) does. So the
      // automatic re-fit this resize triggers must leave `onCameraChange`
      // silent, debounce included.
      setCanvasSize(RESIZE_VIEWPORT);
      step();
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(onCameraChange).not.toHaveBeenCalled();
    });
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

  it("seats a real status on the rendered population, which this suite could not do before", () => {
    // THE PREREQUISITE'S OWN CASE. Every office here rendered cold, so the
    // footer below read "0 at work" whatever the epic was doing and no case
    // could put an agent anywhere but a cubby. `seedFailure` writes the one
    // thing the canvas actually reads - an unread, non-terminal, app-local
    // failure addressed to that agent - and the status arrives through the
    // real selector rather than through a stubbed `statusById`, which is what
    // makes it evidence about the canvas rather than about the fixture.
    //
    // The footer is the observable because it counts STATUSES and nothing
    // else - `office-directory-panel`'s `atWork` is
    // `everyone.filter((m) => isOfficeHotStatus(m.status)).length`, the shared
    // hot/cold predicate applied to the status each member arrived with. So if
    // the seed did not reach `officeAgentStatuses`, this reads exactly as the
    // cold control below it. The bed itself is NOT observable from here: this
    // suite mocks `AgentHoverTooltip` down to its bare trigger, so the hover
    // card that would name the infirmary never renders, and sprites go through
    // `drawImage`, which `paintedText` cannot see. Where the agent ends up is
    // pinned in `office-scene.test.ts`; what this case owes is that the status
    // gets here at all.
    seedFailure(REVIEWER.id, REVIEWER.hostId);
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));

    expect(
      screen.getByTestId("comm-graph-office-directory-footer").textContent,
    ).toBe("2 agents · 1 at work");
    // ...and the cold reading is still what an unseeded office gives, so the
    // line above is the seed and not the footer having changed meaning.
    cleanup();
    useAppLocalNotificationsStore.setState({ byId: {} });
    renderOffice(new Set([ORCHESTRATOR.id, REVIEWER.id]));
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

/** The face's em size in CSS pixels, as the caller set it. */
function modelledFontPx(font: string): number {
  const px = /(\d+(?:\.\d+)?)px/.exec(font);
  return px === null ? 10 : Number(px[1]);
}

function modelledTextWidth(
  text: string,
  font: string,
  letterSpacing: string,
): number {
  const tracking = /(-?\d+(?:\.\d+)?)em/.exec(letterSpacing);
  const spacing = tracking === null ? 0 : Number(tracking[1]);
  return text.length * modelledFontPx(font) * (MONOSPACE_ADVANCE_EM + spacing);
}

/**
 * A call as the renderer made it, before the recorder has said anything
 * about where it landed. The stepper below reads calls in this shape while
 * a recording is still being built, which is why it is not
 * {@link RecordedCall}: the matrix a call is stamped with is computed FROM
 * the call, so it cannot be an input to reading it.
 */
interface CanvasCall {
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

/**
 * Canvas 2D current transform as `[a, b, c, d, e, f]`.
 *
 * `x' = a*x + c*y + e`, `y' = b*x + d*y + f`. Identity is
 * `[1, 0, 0, 1, 0, 0]`. Screen-space chrome is `[dpr, 0, 0, dpr, 0, 0]`;
 * the camera's world transform is `[dpr*zoom, 0, 0, dpr*zoom, dpr*x, dpr*y]`.
 */
type CanvasTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

const CANVAS_IDENTITY: CanvasTransform = [1, 0, 0, 1, 0, 0];

function multiplyCanvasTransform(
  left: CanvasTransform,
  right: CanvasTransform,
): CanvasTransform {
  const [a, b, c, d, e, f] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

function applyCanvasTransform(
  transform: CanvasTransform,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return {
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  };
}

function sixNumberTransform(
  args: ReadonlyArray<unknown>,
): CanvasTransform | null {
  if (args.length < 6) return null;
  const a = args[0];
  const b = args[1];
  const c = args[2];
  const d = args[3];
  const e = args[4];
  const f = args[5];
  if (
    typeof a !== "number" ||
    typeof b !== "number" ||
    typeof c !== "number" ||
    typeof d !== "number" ||
    typeof e !== "number" ||
    typeof f !== "number"
  ) {
    return null;
  }
  return [a, b, c, d, e, f];
}

/**
 * EVERY 2D-context method that moves the CTM. The stepper below must have a
 * rule for each one, and throws rather than shrugging when it does not.
 *
 * The list is the tripwire: a context op added here without a branch, or an
 * argument shape the branch cannot read, stops the replay loudly instead of
 * returning the previous matrix and letting a case assert a transform that
 * was never in force. That silence is what let a rotation around the beacon
 * through - the recorder logged `rotate`, the stepper ignored it, and the
 * reconstructed CTM stayed the DPR-only one while the real paint turned.
 *
 * `reset` is listed WITHOUT a rule on purpose, so the stepper refuses it.
 * See {@link stepCanvasTransform} for why it is not modelled.
 */
const TRANSFORM_AFFECTING_METHODS: ReadonlySet<string> = new Set([
  "save",
  "restore",
  "setTransform",
  "resetTransform",
  "scale",
  "translate",
  "transform",
  "rotate",
  "reset",
]);

/** The six numbers a matrix op was called with, or a throw naming the op. */
function requiredTransformArgs(call: CanvasCall): CanvasTransform {
  const six = sixNumberTransform(call.args);
  if (six !== null) return six;
  // The `DOMMatrix` / `DOMMatrix2DInit` overload is VALID and is REJECTED
  // rather than modelled, deliberately. A reader for it would have to pull
  // `a`…`f` off the argument, and those are prototype getters on a real
  // `DOMMatrix` - so the obvious implementation is right for a plain init
  // object and silently the identity for an actual matrix, which is the
  // same silence this commit exists to remove, moved one level down.
  // Nothing in the office renderer uses the form; if something ever does,
  // this throw is the prompt to model it properly rather than to guess.
  throw new Error(
    `stepCanvasTransform: ${call.method} was not called with six numbers ` +
      "(the DOMMatrix form is not modelled)",
  );
}

/** Two numeric arguments, or a throw naming the op that wanted them. */
function requiredNumberPair(call: CanvasCall): readonly [number, number] {
  const first = call.args[0];
  const second = call.args[1];
  if (typeof first !== "number" || typeof second !== "number") {
    throw new Error(`stepCanvasTransform: ${call.method} needs two numbers`);
  }
  return [first, second];
}

/**
 * The ops that COMPOSE with the matrix already in force, rather than
 * replacing it - which is what a real context does with each of them.
 */
function composeCanvasTransform(
  current: CanvasTransform,
  call: CanvasCall,
): CanvasTransform {
  if (call.method === "scale") {
    const [sx, sy] = requiredNumberPair(call);
    return multiplyCanvasTransform(current, [sx, 0, 0, sy, 0, 0]);
  }
  if (call.method === "translate") {
    const [tx, ty] = requiredNumberPair(call);
    return multiplyCanvasTransform(current, [1, 0, 0, 1, tx, ty]);
  }
  if (call.method === "rotate") {
    const radians = call.args[0];
    if (typeof radians !== "number") {
      throw new Error("stepCanvasTransform: rotate needs a number");
    }
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return multiplyCanvasTransform(current, [cos, sin, -sin, cos, 0, 0]);
  }
  if (call.method === "transform") {
    return multiplyCanvasTransform(current, requiredTransformArgs(call));
  }
  if (TRANSFORM_AFFECTING_METHODS.has(call.method)) {
    throw new Error(
      `stepCanvasTransform models no rule for ${call.method}, which moves the CTM`,
    );
  }
  return current;
}

/**
 * The matrix after one call.
 *
 * `reset` is deliberately NOT modelled here, and is listed in
 * {@link TRANSFORM_AFFECTING_METHODS} so that this throws on it. Modelling
 * the matrix half would be easy - identity CTM, empty stack - and would be a
 * worse answer than refusing, because a real `reset()` also ERASES THE
 * BITMAP. This recorder's whole premise is that the stream IS what was
 * painted; after a `reset()` every call before it has been wiped and no
 * reader models that. Handling only the matrix would close the obvious
 * escape (a `reset()` before a draw, leaving its recorded coordinates
 * unchanged while the real paint lands under identity) and open a quieter
 * one in its place: every earlier call still reading as painted. The
 * oracle already states it does not reconstruct a raster - the beacon's
 * clearance case carries that scope ruling - so erasure is out of its reach
 * by construction, and the honest reply is to stop rather than to model half
 * of it. If the renderer ever calls `reset()`, this throw is the prompt to
 * decide what a recorded stream means across one, not to guess.
 */
function stepCanvasTransform(
  current: CanvasTransform,
  stack: CanvasTransform[],
  call: CanvasCall,
): CanvasTransform {
  if (call.method === "save") {
    stack.push(current);
    return current;
  }
  if (call.method === "restore") {
    const previous = stack.pop();
    return previous ?? current;
  }
  if (call.method === "setTransform") return requiredTransformArgs(call);
  if (call.method === "resetTransform") return CANVAS_IDENTITY;
  return composeCanvasTransform(current, call);
}

/** A coordinate pair. In {@link RecordedCall.screen}, device pixels. */
interface Point2D {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned box, in whichever space the value that carries it names. */
interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * EVERY COORDINATE A CALL TOOK, projected through the matrix in force when
 * it was made.
 *
 * `points` are the (x, y) pairs, in argument order, with a rect expanded to
 * its four corners (see {@link rectGeometry}). `lengths` are the scalars a
 * call carries that are distances rather than positions - a radius, a
 * `maxWidth` - scaled by the same matrix.
 *
 * Units are DEVICE pixels, which is what a CTM maps into: a caller that
 * wants CSS pixels divides by `devicePixelRatio`, as the renderer's own
 * screen-space reset multiplies by it.
 */
interface CallGeometry {
  readonly points: ReadonlyArray<Point2D>;
  readonly lengths: ReadonlyArray<number>;
}

const NO_CALL_GEOMETRY: CallGeometry = { points: [], lengths: [] };

/**
 * A call the renderer made, with WHERE IT LANDED already worked out.
 *
 * `args` is the raw argument list, and stays the right thing to read for
 * everything that is not a position: a string, a sprite ref, a colour, an
 * arity. `screen` is the same call's coordinates after the CTM, and is the
 * right thing to read for every position and size. See
 * {@link createRecordingContext} for why that split is the default.
 */
interface RecordedCall extends CanvasCall {
  /** The CTM in force when this call was made - before it, for a matrix op. */
  readonly transform: CanvasTransform;
  /** `args`' coordinates, projected through {@link transform}. */
  readonly screen: CallGeometry;
}

/** Reads a call's coordinates IN ITS OWN SPACE, for the recorder to project. */
type CallGeometryReader = (call: CanvasCall) => CallGeometry;

/** One numeric argument, or a throw naming the slot that wanted one. */
function requiredCoordinate(call: CanvasCall, index: number): number {
  const value = call.args[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `recordCallGeometry: ${call.method} argument ${index} is ` +
        `${String(value)}, not a finite number, so the coordinate it is ` +
        "meant to carry cannot be projected",
    );
  }
  return value;
}

/** The coordinate pairs sitting at these argument index pairs. */
function coordinatesAt(
  call: CanvasCall,
  ...slots: ReadonlyArray<readonly [number, number]>
): ReadonlyArray<Point2D> {
  return slots.map(([xIndex, yIndex]) => ({
    x: requiredCoordinate(call, xIndex),
    y: requiredCoordinate(call, yIndex),
  }));
}

function pointGeometry(
  call: CanvasCall,
  ...slots: ReadonlyArray<readonly [number, number]>
): CallGeometry {
  return { points: coordinatesAt(call, ...slots), lengths: [] };
}

/**
 * An `(x, y, width, height)` rect as its FOUR CORNERS, in perimeter order,
 * rather than an origin and a size.
 *
 * Under a rotated or skewed CTM a rect is not a box, and an origin plus a
 * scaled size cannot be turned back into what was actually painted. Four
 * projected corners always can; a consumer that wants a box takes their
 * bounding box, which is what {@link screenBoxOf} does.
 */
function rectGeometry(
  call: CanvasCall,
  /** The argument indices of `x`, `y`, `width` and `height`, in that order. */
  slots: readonly [number, number, number, number],
): CallGeometry {
  const x = requiredCoordinate(call, slots[0]);
  const y = requiredCoordinate(call, slots[1]);
  const width = requiredCoordinate(call, slots[2]);
  const height = requiredCoordinate(call, slots[3]);
  return {
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    lengths: [],
  };
}

const RECT_READER: CallGeometryReader = (call) =>
  rectGeometry(call, [0, 1, 2, 3]);

/** `fillText`/`strokeText`: the anchor, and `maxWidth` when it was passed. */
const TEXT_READER: CallGeometryReader = (call) => ({
  points: coordinatesAt(call, [1, 2]),
  lengths: call.args.length > 3 ? [requiredCoordinate(call, 3)] : [],
});

/** `arc`: the centre and the radius. The angles that follow are neither. */
const ARC_READER: CallGeometryReader = (call) => ({
  points: coordinatesAt(call, [0, 1]),
  lengths: [requiredCoordinate(call, 2)],
});

/** `arcTo`: the two tangent points, then the radius. */
const ARC_TO_READER: CallGeometryReader = (call) => ({
  points: coordinatesAt(call, [0, 1], [2, 3]),
  lengths: [requiredCoordinate(call, 4)],
});

/** `ellipse`: the centre, then both radii. The rotation is an angle. */
const ELLIPSE_READER: CallGeometryReader = (call) => ({
  points: coordinatesAt(call, [0, 1]),
  lengths: [requiredCoordinate(call, 2), requiredCoordinate(call, 3)],
});

/** `createRadialGradient`: a centre and a radius, twice over. */
const RADIAL_GRADIENT_READER: CallGeometryReader = (call) => ({
  points: coordinatesAt(call, [0, 1], [3, 4]),
  lengths: [requiredCoordinate(call, 2), requiredCoordinate(call, 5)],
});

/**
 * `roundRect`: the rect, plus a single numeric corner radius when one was
 * passed. The list-of-radii form is refused rather than guessed at - the
 * same call this file makes on the `DOMMatrix` form of `setTransform`.
 */
const ROUND_RECT_READER: CallGeometryReader = (call) => {
  const box = rectGeometry(call, [0, 1, 2, 3]);
  const radii = call.args[4];
  if (radii === undefined) return box;
  if (typeof radii === "number") {
    return { points: box.points, lengths: [radii] };
  }
  throw new Error(
    "recordCallGeometry: roundRect's list-of-radii form is not modelled",
  );
};

/**
 * `drawImage`, told apart by arity exactly as the API itself is.
 *
 * The nine-argument form's FIRST rect addresses the source image's own
 * pixels and is deliberately left alone; only the destination rect is on
 * this canvas.
 */
const DRAW_IMAGE_READER: CallGeometryReader = (call) => {
  if (call.args.length === 3) return pointGeometry(call, [1, 2]);
  if (call.args.length === 5) return rectGeometry(call, [1, 2, 3, 4]);
  if (call.args.length === 9) return rectGeometry(call, [5, 6, 7, 8]);
  throw new Error(
    `recordCallGeometry: drawImage took ${call.args.length} arguments, ` +
      "which is none of its three forms",
  );
};

/** This suite's own blit marker: `drawOfficeSprite(ref, at, theme)`. */
const OFFICE_SPRITE_READER: CallGeometryReader = (call) => {
  const at = call.args[1];
  if (typeof at !== "object" || at === null || !("x" in at) || !("y" in at)) {
    throw new Error(
      "recordCallGeometry: drawOfficeSprite was not given a point to blit at",
    );
  }
  const { x, y } = at;
  if (typeof x !== "number" || typeof y !== "number") {
    throw new Error(
      "recordCallGeometry: drawOfficeSprite's point is not numeric",
    );
  }
  return { points: [{ x, y }], lengths: [] };
};

/**
 * WHERE EACH METHOD'S COORDINATES SIT IN ITS ARGUMENT LIST.
 *
 * Together with {@link COORDINATE_FREE_METHODS} and
 * {@link TRANSFORM_AFFECTING_METHODS} this is a total classification of what
 * the renderer may call: {@link projectCallGeometry} throws on a method in
 * none of the three. That throw is the tripwire. A context op nobody
 * classified would otherwise be recorded with no geometry at all, which
 * reads exactly like an op that genuinely has none - and a position no case
 * can check is how the whole suite came to measure raw arguments and call
 * them screen pixels.
 *
 * Ten of these were measured against this renderer rather than guessed at
 * (`clearRect`, `fillRect`, `strokeRect`, `roundRect`, `fillText`, `moveTo`,
 * `lineTo`, `arc`, `drawImage`, `putImageData`, plus the sprite marker); the
 * rest are the remainder of the 2D API that takes coordinates, classified
 * ahead of the first caller rather than after it.
 */
const CALL_GEOMETRY_READERS: ReadonlyMap<string, CallGeometryReader> = new Map([
  ["clearRect", RECT_READER],
  ["fillRect", RECT_READER],
  ["strokeRect", RECT_READER],
  ["rect", RECT_READER],
  ["roundRect", ROUND_RECT_READER],
  ["fillText", TEXT_READER],
  ["strokeText", TEXT_READER],
  ["moveTo", (call) => pointGeometry(call, [0, 1])],
  ["lineTo", (call) => pointGeometry(call, [0, 1])],
  ["quadraticCurveTo", (call) => pointGeometry(call, [0, 1], [2, 3])],
  ["bezierCurveTo", (call) => pointGeometry(call, [0, 1], [2, 3], [4, 5])],
  ["arc", ARC_READER],
  ["arcTo", ARC_TO_READER],
  ["ellipse", ELLIPSE_READER],
  ["drawImage", DRAW_IMAGE_READER],
  ["createLinearGradient", (call) => pointGeometry(call, [0, 1], [2, 3])],
  ["createRadialGradient", RADIAL_GRADIENT_READER],
  ["putImageData", (call) => pointGeometry(call, [1, 2])],
  ["getImageData", RECT_READER],
  ["drawOfficeSprite", OFFICE_SPRITE_READER],
]);

/**
 * The two methods the 2D spec EXEMPTS from the current transform: they
 * address the backing bitmap directly, so their coordinates are already
 * device pixels and projecting them would invent a displacement the browser
 * does not apply.
 */
const DEVICE_SPACE_METHODS: ReadonlySet<string> = new Set([
  "putImageData",
  "getImageData",
]);

/**
 * Methods that mark the canvas or move its state without naming a position.
 * Listed rather than assumed, so that the classification is total.
 */
const COORDINATE_FREE_METHODS: ReadonlySet<string> = new Set([
  "beginPath",
  "closePath",
  "fill",
  "stroke",
  "clip",
  "setLineDash",
  "getLineDash",
  "createImageData",
  "createPattern",
]);

/** How a property assignment is recorded: `set:fillStyle`, `set:font`. */
const RECORDED_PROPERTY_PREFIX = "set:";

/** Relative slack for the similarity tests: a part in a billion, not a pixel. */
const SIMILARITY_TOLERANCE = 1e-9;

/**
 * The one factor a CTM applies to a LENGTH - a radius, a `maxWidth`, a
 * glyph's advance.
 *
 * A length has no direction, so there is a single answer only under a
 * SIMILARITY: the matrix's two columns must have the same norm AND be
 * perpendicular. Anything else scales a length differently depending on
 * which way it points, and the honest reply is a throw rather than a number
 * picked off one column.
 *
 * EVERY COMPARISON HERE IS RELATIVE TO THE COLUMNS' OWN SIZE. An absolute
 * floor reads as strictness and is the opposite near zero: at a scale of
 * 1e-5 a slack of 1e-9 is four orders of magnitude of freedom, enough for a
 * matrix whose columns are exactly PARALLEL to pass as perpendicular. The
 * magnitudes a CTM can take are not bounded below, so nothing absolute can
 * be a tolerance on this shape.
 */
function similarityScaleOf(transform: CanvasTransform, method: string): number {
  const [a, b, c, d] = transform;
  const firstColumn = Math.hypot(a, b);
  const secondColumn = Math.hypot(c, d);
  const largestColumn = Math.max(firstColumn, secondColumn);
  // THE ALL-ZERO MATRIX, said out loud rather than left to fall out of the
  // arithmetic below - which cannot judge it, since every test that follows
  // measures against a magnitude this matrix is the absence of, and "zero is
  // within a billionth of zero" would be an accident rather than a reason.
  // It paints nothing, and zero is the true length under it: not a shape
  // this helper cannot express. Refusing to credit that zero as something a
  // reader can SEE is `tagBoxesFrom`'s job, and it does it by area.
  if (largestColumn === 0) return 0;
  if (
    Math.abs(firstColumn - secondColumn) >
    SIMILARITY_TOLERANCE * largestColumn
  ) {
    throw new Error(
      `recordCallGeometry: ${method} carries a length under a CTM scaling x ` +
        `by ${firstColumn} and y by ${secondColumn}; a length under a ` +
        "non-uniform transform is not modelled",
    );
  }
  // PERPENDICULAR AND NON-DEGENERATE, IN ONE NUMBER. Lagrange's identity
  // gives det² + (c1·c2)² = ‖c1‖²‖c2‖², so |det| - the area the columns
  // actually span - equals ‖c1‖‖c2‖ exactly when they are perpendicular, and
  // falls away from it as they close up, reaching 0 when they are parallel
  // and the plane has collapsed onto a line. So one comparison rejects a
  // shear and a singular transform together, which is the right shape: a
  // rank-one collapse is not a separate defect, it is a shear taken to its
  // limit, and both are matrices under which a length has no one factor.
  // Testing the dot product instead would need a second test for the
  // collapse, and the two could disagree.
  const spannedByPerpendicular = firstColumn * secondColumn;
  const spanned = Math.abs(a * d - b * c);
  if (
    spannedByPerpendicular - spanned >
    SIMILARITY_TOLERANCE * spannedByPerpendicular
  ) {
    throw new Error(
      `recordCallGeometry: ${method} carries a length under a CTM that is ` +
        `not a similarity: its columns span ${spanned} where two ` +
        `perpendicular columns of the same norms would span ` +
        `${spannedByPerpendicular}. A shear scales a length by which way it ` +
        "points, and a collapse leaves it no area at all; neither is modelled",
    );
  }
  return firstColumn;
}

/** A call's coordinates, on screen. See {@link CALL_GEOMETRY_READERS}. */
function projectCallGeometry(
  call: CanvasCall,
  transform: CanvasTransform,
): CallGeometry {
  const reader = CALL_GEOMETRY_READERS.get(call.method);
  if (reader === undefined) {
    if (
      call.method.startsWith(RECORDED_PROPERTY_PREFIX) ||
      TRANSFORM_AFFECTING_METHODS.has(call.method) ||
      COORDINATE_FREE_METHODS.has(call.method)
    ) {
      return NO_CALL_GEOMETRY;
    }
    throw new Error(
      `recordCallGeometry: ${call.method} is classified neither as a call ` +
        "that takes coordinates nor as one that does not. Give it a reader " +
        "in `CALL_GEOMETRY_READERS` or list it in `COORDINATE_FREE_METHODS`.",
    );
  }
  const geometry = reader(call);
  if (DEVICE_SPACE_METHODS.has(call.method)) return geometry;
  const scale =
    geometry.lengths.length === 0
      ? 1
      : similarityScaleOf(transform, call.method);
  return {
    points: geometry.points.map((point) =>
      applyCanvasTransform(transform, point.x, point.y),
    ),
    lengths: geometry.lengths.map((length) => length * scale),
  };
}

/**
 * THE FIRST COORDINATE A CALL TOOK, on screen.
 *
 * Throws for a call that took none, which is the reader's half of the
 * tripwire: asking a `beginPath` or a `set:fillStyle` where it landed is a
 * question about the wrong call, and answering `undefined` would let an
 * assertion compare two nothings and pass.
 */
function screenPointOf(call: RecordedCall): Point2D {
  const { points } = call.screen;
  if (points.length === 0) {
    throw new Error(
      `screenPointOf: ${call.method} carries no coordinates to read`,
    );
  }
  return points[0];
}

/** The bounding box, on screen, of every coordinate a call took. */
function screenBoxOf(call: RecordedCall): ScreenBox {
  const { points } = call.screen;
  if (points.length === 0) {
    throw new Error(
      `screenBoxOf: ${call.method} carries no coordinates to read`,
    );
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}

/**
 * A screen point in CSS pixels - what a reader's own units are.
 *
 * `screen` is device pixels because that is what a CTM maps into; the
 * renderer's screen-space reset is `setTransform(dpr, …)`, so dividing it
 * back out is what turns a matrix result into the geometry a person sees.
 */
function cssOf(point: Point2D): Point2D {
  const dpr = window.devicePixelRatio || 1;
  return { x: point.x / dpr, y: point.y / dpr };
}

/** {@link screenBoxOf}, in CSS pixels. */
function cssBoxOf(call: RecordedCall): ScreenBox {
  const dpr = window.devicePixelRatio || 1;
  const box = screenBoxOf(call);
  return {
    left: box.left / dpr,
    top: box.top / dpr,
    width: box.width / dpr,
    height: box.height / dpr,
  };
}

/**
 * Whether this CTM is device-pixel-ratio scale and nothing else — no
 * camera zoom, no camera translation. That is the screen-space reset
 * `setTransform(dpr, 0, 0, dpr, 0, 0)`.
 */
function isDeviceScaleTransform(
  transform: CanvasTransform,
  dpr: number,
): boolean {
  return (
    transform[0] === dpr &&
    transform[1] === 0 &&
    transform[2] === 0 &&
    transform[3] === dpr &&
    transform[4] === 0 &&
    transform[5] === 0
  );
}

/**
 * ONE RECORDING CONTEXT'S LIVE MATRIX, stepped as the calls arrive.
 *
 * Kept beside the call list rather than reconstructed afterwards: a replay
 * that walks the stream from the start is O(n) per lookup and, worse, is
 * something a case has to remember to ask for.
 */
interface RecorderState {
  readonly calls: RecordedCall[];
  readonly matrixStack: CanvasTransform[];
  transform: CanvasTransform;
}

/**
 * Every live recording context, keyed by the proxy handed to the renderer.
 *
 * `drawOfficeSprite` is SPIED rather than called through (see
 * {@link recordDrawOfficeSprite}), so its marker is pushed from outside the
 * proxy - and a marker stamped with anything other than the CTM of the
 * context the blit was issued ON is exactly the fiction this path exists to
 * remove. This map is how the spy reaches that context's matrix.
 */
const RECORDING_CONTEXTS = new WeakMap<object, RecorderState>();

/**
 * Records one call, stamped with where it landed, and then steps the matrix.
 *
 * The stamp is the state BEFORE this call - what a `roundRect` or a blit
 * actually draws under - so a `setTransform` carries the matrix it replaced
 * rather than the one it installed.
 */
function recordCall(
  state: RecorderState,
  method: string,
  args: ReadonlyArray<unknown>,
): void {
  const call: CanvasCall = { method, args };
  const transform = state.transform;
  state.calls.push({
    method,
    args,
    transform,
    screen: projectCallGeometry(call, transform),
  });
  state.transform = stepCanvasTransform(transform, state.matrixStack, call);
}

/**
 * Pushes a `drawOfficeSprite` marker onto the recording stream of the
 * context the blit was issued on, in the order the real call ran - so it
 * carries the same CTM and the same screen point every other recorded call
 * does.
 *
 * Does NOT call through. `officeSpriteSurface` asks `getContext` on a
 * detached canvas; this suite's stub hands back a fresh recorder bound to
 * the SAME `calls` array, so a call-through would inject `createImageData`
 * / `putImageData` / an empty `drawImage` into the painted context's
 * stream. The marker's ORDER is the fact; the blit itself would be fiction.
 */
function recordDrawOfficeSprite(): MockInstance<
  typeof OfficePixelArt.drawOfficeSprite
> {
  const blitSpy = vi.spyOn(OfficePixelArt, "drawOfficeSprite");
  blitSpy.mockImplementation((ctx, ref, at, theme) => {
    const state = RECORDING_CONTEXTS.get(ctx);
    if (state === undefined) {
      throw new Error(
        "recordDrawOfficeSprite: this blit was issued on a context the suite " +
          "did not create, so there is no CTM to stamp its marker with",
      );
    }
    recordCall(state, "drawOfficeSprite", [ref, at, theme]);
  });
  return blitSpy;
}

/**
 * THE RECORDING 2D CONTEXT, and the default every case reads through.
 *
 * WHAT IT RECORDS. Each call is pushed as a {@link RecordedCall}: the method
 * name, the RAW `args` the renderer passed, the CTM in force at that moment,
 * and `screen` - the same call's coordinates projected through that CTM.
 *
 * WHICH ONE TO READ. `screen` for every POSITION and SIZE, through
 * {@link screenPointOf} / {@link screenBoxOf}. `args` for everything that is
 * not one: the string a `fillText` painted, a sprite ref, a colour, an arity.
 *
 * WHY IT IS THE DEFAULT, and not a helper a case opts into. This recorder
 * used to log `setTransform`/`scale`/`translate` faithfully and apply none of
 * them, so every case reading a draw argument's x/y was talking about
 * PRE-transform numbers while believing it had screen pixels. Deleting the
 * renderer's screen-space reset - which governs every sign label and name tag
 * in the office - disturbed no assertion in eighty cases. The measurement
 * that followed was reassuring about what had already landed (three cases
 * change verdict once the oracle transforms; the rest group, dedupe or
 * compare relatively, which a uniform affine preserves) and said nothing
 * about the next case: opt-in accuracy is accuracy nobody opts into, and the
 * next absolute-position assertion would have been born blind in exactly the
 * same way. So the projection is not something to reach for. It is what a
 * call arrives already carrying.
 *
 * WHY `args` SURVIVES BESIDE IT. The raw list is the renderer's INPUT and is
 * a fact in its own right - it is where the text, the sprite ref and the
 * colour live, and a case that means to pin a model-space coordinate can
 * still say so deliberately. Dropping it would not make the default clearer;
 * it would only push every case into unpacking `screen` for a string.
 *
 * WHAT CANNOT BE RECORDED BLIND. {@link projectCallGeometry} throws for any
 * method it has not been told about, and {@link screenPointOf} throws when
 * asked where a call with no coordinates landed. Between them, a new context
 * op cannot quietly arrive with an empty geometry that reads like an honest
 * absence.
 */
function createRecordingContext(calls: RecordedCall[]): unknown {
  const backing: Record<string, unknown> = {};
  // A STATE STACK for `save`/`restore`, the way a real 2D context works.
  // Without this, `backing` is a flat bag every assignment overwrites
  // forever: a plate's `save()` … `letterSpacing = "0.08em"` … `restore()`
  // leaves the RECORDER still reporting 0.08em to whatever measures text
  // after it, though a real browser has already unwound it. That is a
  // property of this double, not of the renderer - real production code
  // never leaked tracking across a save/restore pair - and it is exactly
  // what made an earlier pass over this file measure a name tag drawn after
  // a sign plate as if it were tracked. Restoring past the bottom of an
  // empty stack is a no-op, matching a real context's own behaviour.
  const stack: Array<Record<string, unknown>> = [];
  // The MATRIX stack is a second one, deliberately: `save`/`restore` unwind
  // the property bag above and the CTM together, but they are different
  // state, and `stepCanvasTransform` owns the matrix half.
  const state: RecorderState = {
    calls,
    matrixStack: [],
    transform: CANVAS_IDENTITY,
  };
  const context = new Proxy(backing, {
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
      if (prop === "save") {
        return (...args: ReadonlyArray<unknown>): void => {
          stack.push({ ...backing });
          recordCall(state, prop, args);
        };
      }
      if (prop === "restore") {
        return (...args: ReadonlyArray<unknown>): void => {
          const previous = stack.pop();
          if (previous !== undefined) {
            for (const key of Object.keys(backing)) delete backing[key];
            Object.assign(backing, previous);
          }
          recordCall(state, prop, args);
        };
      }
      return (...args: ReadonlyArray<unknown>): void => {
        recordCall(state, prop, args);
      };
    },
    set(_target, prop, value) {
      if (typeof prop === "string") {
        backing[prop] = value;
        recordCall(state, `${RECORDED_PROPERTY_PREFIX}${prop}`, [value]);
      }
      return true;
    },
  });
  RECORDING_CONTEXTS.set(context, state);
  return context;
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
 * THE RECORDER'S OWN CONTRACT, as cases rather than as comments.
 *
 * Both throws below exist for one reason: to stop a POSITION arriving that no
 * case can check. That is not a hypothetical failure mode here - it is the
 * history of this file, where an oracle that recorded transforms and applied
 * none of them let the renderer's screen-space reset be deleted without
 * disturbing a single assertion in eighty cases.
 *
 * Proving a throw by running a mutant once is evidence for that day. These
 * are the rule the next author trips over, and they sit beside the recorder
 * because that is what they describe.
 */
describe("the recording context's geometry classification", () => {
  let calls: RecordedCall[] = [];
  let restoreGetContext: (() => void) | null = null;

  /** The recording context itself, through the seam the renderer gets it by. */
  function recordingContext(): CanvasRenderingContext2D {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("expected a recording context");
    return context;
  }

  beforeEach(() => {
    calls = [];
    restoreGetContext = stubGetContext(() => createRecordingContext(calls));
  });

  afterEach(() => {
    restoreGetContext?.();
    restoreGetContext = null;
  });

  it("refuses to record a context method no classification names", () => {
    // `drawFocusIfNeeded` is a real 2D method the office never calls, and it
    // is absent from all three classifications DELIBERATELY - it is the probe
    // this case needs. Should the office ever draw a focus ring, list it in
    // `COORDINATE_FREE_METHODS` and point this case at another unclassified
    // method: what is under test is the refusal, not this particular name.
    const context = recordingContext();
    expect(() =>
      context.drawFocusIfNeeded(document.createElement("div")),
    ).toThrow(
      "drawFocusIfNeeded is classified neither as a call that takes " +
        "coordinates nor as one that does not",
    );
    // And nothing reached the stream: a call half-written before the throw
    // would carry exactly the unchecked geometry the throw exists to refuse.
    expect(calls).toEqual([]);
  });

  it("refuses to answer where a call with no coordinates landed", () => {
    const context = recordingContext();
    context.beginPath();
    const beginPath = calls.find((call) => call.method === "beginPath");
    if (beginPath === undefined) {
      throw new Error("expected a recorded beginPath");
    }
    // The absence is honest - `beginPath` really has no geometry, and its
    // `screen.points` really is empty. What must not happen is the READER
    // answering anyway: an `undefined` anchor lets an assertion compare two
    // nothings and pass, which is the silence one level down from the one
    // the classification above removes.
    expect(beginPath.screen.points).toEqual([]);
    expect(() => screenPointOf(beginPath)).toThrow(
      "beginPath carries no coordinates to read",
    );
  });
});

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
  // See `OFFICE_VIEW`: the canvas reads the three fields above, never this one.
  officeCamera: null,
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

interface FillTextRecord {
  readonly text: string;
  /** The anchor in CSS pixels ON SCREEN, not the argument the caller passed. */
  readonly x: number;
  readonly y: number;
  readonly font: string;
  readonly letterSpacing: string;
  /**
   * What the CTM does to a length here, relative to a CSS pixel. `1` while
   * the text is painted in screen space; the camera's zoom while it is not.
   * {@link tagBoxesFrom} needs it because a glyph's width comes from the FONT
   * STRING, which the matrix scales as surely as it scales the anchor.
   */
  readonly cssScale: number;
  readonly blockId: number;
}

/**
 * REPLAY the calls in order, keeping the canvas state a real context
 * would have at each `fillText` - `save`/`restore` bracket `set:font`
 * and `set:letterSpacing` the same way the fixed `createRecordingContext`
 * now tracks them, so this mirrors the fixed harness rather than
 * assuming a global, unwound state.
 *
 * The anchor comes off the recorded call's SCREEN geometry, so these records
 * describe where the text landed rather than what the renderer asked for.
 */
function replayFillText(
  recordedCalls: ReadonlyArray<RecordedCall>,
): ReadonlyArray<FillTextRecord> {
  let font = "10px monospace";
  let letterSpacing = "0px";
  const stateStack: Array<{
    readonly font: string;
    readonly letterSpacing: string;
  }> = [];
  const blockStack: number[] = [];
  let nextBlockId = 0;
  const records: FillTextRecord[] = [];
  for (const call of recordedCalls) {
    if (call.method === "save") {
      stateStack.push({ font, letterSpacing });
      nextBlockId += 1;
      blockStack.push(nextBlockId);
      continue;
    }
    if (call.method === "restore") {
      const previous = stateStack.pop();
      if (previous !== undefined) {
        font = previous.font;
        letterSpacing = previous.letterSpacing;
      }
      blockStack.pop();
      continue;
    }
    if (call.method === "set:font" && typeof call.args[0] === "string") {
      font = call.args[0];
      continue;
    }
    if (
      call.method === "set:letterSpacing" &&
      typeof call.args[0] === "string"
    ) {
      letterSpacing = call.args[0];
      continue;
    }
    if (call.method === "fillText") {
      const [text] = call.args;
      if (typeof text === "string") {
        const dpr = window.devicePixelRatio || 1;
        const anchor = screenPointOf(call);
        records.push({
          text,
          x: anchor.x / dpr,
          y: anchor.y / dpr,
          font,
          letterSpacing,
          cssScale: similarityScaleOf(call.transform, call.method) / dpr,
          blockId: blockStack[blockStack.length - 1] ?? 0,
        });
      }
    }
  }
  return records;
}

interface TagBox {
  readonly left: number;
  readonly right: number;
  readonly y: number;
  /**
   * The em box's height in CSS pixels on screen. A tag box is otherwise a
   * span at a baseline, and a span cannot say whether anything was actually
   * covered - see {@link tagBoxesFrom}'s refusal.
   */
  readonly height: number;
  readonly text: string;
}

/**
 * ONE ENTRY A TAG. `drawScreenLabel` paints a name tag five times inside
 * one save/restore pair - four backing offsets, then the true anchor -
 * and never draws anything else in between; a sign plate's own bold
 * face is a separate save/restore pair entirely. Group by block, keep
 * only blocks whose face is NOT bold (a tag, not a plate) - by the font
 * the call was made under, not by parsing the text - and take the LAST
 * fillText in each: the exact anchor, with no backing offset.
 *
 * DE-DUPLICATED by (text, x, y): the settling flushes redraw a STILL
 * scene identically frame after frame, so the same tag's block appears
 * several times over with the exact same anchor and reading - real
 * repeats of one frame, not several agents that coincide. Keeping every
 * copy would make an unmoved tag "collide" with its own earlier frame at
 * zero distance, which is not the finding this case checks.
 *
 * EVERY NUMBER HERE IS CSS PIXELS ON SCREEN. The anchor is the recorded
 * call's projected one; the width is modelled from the font string and then
 * scaled by what the CTM does to a length, because a real context magnifies
 * the glyphs by the same matrix that moves the anchor. Under the renderer's
 * screen-space reset that scale is 1 and the widths are the face's own - the
 * case that pins the reset itself is F5.
 *
 * A READING WITH NO AREA IS NOT A READING, and this throws on one rather
 * than reporting it. Every case here that counts boxes is claiming a tag was
 * PAINTED - "both desk tags actually painted, not zero/one of them" - and a
 * box of zero width or zero height satisfies a count while covering no pixel
 * at all. It is reachable: a CTM that collapses the plane onto a point is a
 * degenerate similarity, which {@link similarityScaleOf} answers honestly
 * with `0`, leaving every anchor where it was and every box an empty one at
 * it. `collisions` would then find nothing to report either, since it asks
 * for a strict overlap. Presence is the claim; area is what makes it one.
 */
function tagBoxesFrom(
  records: ReadonlyArray<FillTextRecord>,
): ReadonlyArray<TagBox> {
  const byBlock = new Map<number, FillTextRecord[]>();
  for (const record of records) {
    const list = byBlock.get(record.blockId);
    if (list === undefined) byBlock.set(record.blockId, [record]);
    else list.push(record);
  }
  const seen = new Set<string>();
  const boxes: TagBox[] = [];
  for (const list of byBlock.values()) {
    const last = list[list.length - 1];
    if (last.font.startsWith("bold ")) continue;
    const key = `${last.text}\0${last.x}\0${last.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const width =
      modelledTextWidth(last.text, last.font, last.letterSpacing) *
      last.cssScale;
    const height = modelledFontPx(last.font) * last.cssScale;
    if (width <= 0 || height <= 0) {
      throw new Error(
        `tagBoxesFrom: "${last.text}" was painted with no area on screen ` +
          `(${width} x ${height} CSS px), so no case can call it a tag that ` +
          "is there",
      );
    }
    boxes.push({
      left: last.x - width / 2,
      right: last.x + width / 2,
      y: last.y,
      height,
      text: last.text,
    });
  }
  return boxes;
}

/**
 * Two boxes count as colliding when their baselines are within one line
 * height of each other - INCLUSIVE, so the tag `layoutNameTags` stagger
 * drops exactly one line below a collision (`NAME_TAG_LINE_HEIGHT` away,
 * never less) still counts, which is the ticket's own "centre ±
 * measured width / 2" box test - AND their measured x-ranges overlap. A
 * cubby storey shares one baseline, so the ordinary case is caught at
 * `dy === 0`; the widened window is what still catches a stagger the
 * layout pass moved.
 */
function collisions(boxes: ReadonlyArray<TagBox>): ReadonlyArray<string> {
  const sorted = [...boxes].sort(
    (leftBox, rightBox) =>
      leftBox.y - rightBox.y || leftBox.left - rightBox.left,
  );
  const violations: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (sorted[j].y - sorted[i].y > NAME_TAG_LINE_HEIGHT) break;
      if (
        sorted[i].left < sorted[j].right &&
        sorted[j].left < sorted[i].right
      ) {
        violations.push(
          `${sorted[i].text}@(${sorted[i].left.toFixed(1)}-${sorted[i].right.toFixed(1)},${sorted[i].y}) overlaps ${sorted[j].text}@(${sorted[j].left.toFixed(1)}-${sorted[j].right.toFixed(1)},${sorted[j].y})`,
        );
      }
    }
  }
  return violations;
}

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
    useAppLocalNotificationsStore.getState().deactivateIdentity();
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
      civic: [],
      road: null,
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
      civicRoomId: null,
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

    // An EIGHT-tile board is 128 screen pixels, which the abbreviated reading
    // fits and the spelt-out one does not. Matched on the abbreviation rather
    // than on a word, because what this case is about is WHERE the text lands,
    // not which rung the width picked. It used to be two tiles, which is
    // thirty-two pixels - below every reading of a roster, so the board fell
    // to a bare total and there was no "0D" on the canvas to find.
    //
    // A FILTERED COPY IS FINE. The matrix a call was made under travels on
    // the call itself, so picking one out of the stream no longer loses it -
    // this used to have to take the index in the whole recording and replay
    // up to it.
    const boardText = calls.find(
      (call) =>
        call.method === "fillText" &&
        typeof call.args[0] === "string" &&
        call.args[0].startsWith("0D"),
    );
    if (boardText === undefined) {
      throw new Error("expected the board's abbreviated roster on the canvas");
    }

    // MEASURED WHERE IT LANDED, not off the raw argument. A board label is
    // drawn AFTER the screen-space reset, so its argument is already a screen
    // coordinate and the CTM is meant to be the device scale alone - which
    // makes the assertion below identical to the raw one while the renderer
    // is right, and different the moment it is not. Reading `args[1]` cannot
    // tell those apart: deleting the reset leaves every argument in this file
    // untouched and moves the paint, which is how it survived the whole suite.
    const dpr = window.devicePixelRatio || 1;
    expect(
      isDeviceScaleTransform(boardText.transform, dpr),
      "board lettering is drawn in screen space",
    ).toBe(true);

    // Fixed camera (zoom 1, x=5, y=0): the projected anchor for tile (2,2)
    // with an eight-tile board centred on it is
    // x = 2048 + 2*16 + (8*16)/2 = 2144, screenX = 2144 * 1 + 5 = 2149. The
    // unfixed renderer instead multiplies the raw tile by OFFICE_TILE with no
    // projector at all, landing four figures short at screenX = 101.
    expect(screenPointOf(boardText).x / dpr).toBe(2149);
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
      civicRoomId: null,
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
    /**
     * The seat's own tile width - a REQUIRED argument, not a default: fixup
     * 8 fits a seated tag to exactly this width, so a caller that means to
     * exercise that fit (the cluster below) has to say so, and every other
     * caller has to say it does not mean to.
     */
    readonly width: number;
  }): OfficeSeat {
    return {
      seatId: args.seatId,
      kind: "desk",
      deskTile: { col: args.col, row: args.row },
      chairTile: { col: args.col, row: args.row + 1 },
      facing: "down",
      hitTiles: { width: args.width, height: 1 },
      hitBox: null,
      floorIndex: 0,
      roomId: null,
      hostId: null,
      manager: false,
      civicRoomId: null,
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
    const host = seatAt({ seatId: "h/0/host", col: 2, row: 2, width: 1 });
    const worker = seatAt({ seatId: "h/0/worker", col: 12, row: 12, width: 1 });
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
        feedSettled: false,
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
    //
    // FIXUP 8: "Alpha Sitter" itself is no longer a possible reading at this
    // zoom - a 1-tile seat's 16px budget only ever admits its initials, "AS"
    // (the search-matched sibling case above proves that is exactly what a
    // QUALIFIED sitter paints here). Asserting the absence of a string the
    // fit ladder can never produce would pass whether or not the LOD-1
    // guard exists at all, so the control has to be the reading the ladder
    // WOULD paint if the guard were gone.
    expect(paintedText()).not.toContain("AS");
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
    //
    // FIXUP 8: the sitter's own tag is now fitted to `seatAt`'s one-tile seat
    // (16px at this zoom), and "Alpha Sitter" (12 chars) fits nothing past
    // its initials - "AS" - so the FULL "Alpha Sitter" string this case used
    // to count is gone from the canvas entirely. The walker keeps its
    // written name (`fitTiles: null`), so the count this case is actually
    // about - a matched walker named exactly as often as a matched sitter -
    // now has to compare the walker's WRITTEN reading against the sitter's
    // FITTED one, not the same string on both sides.
    const walker = paintedText().filter((text) => text === "Alpha Walker");
    const sitter = paintedText().filter((text) => text === "AS");
    expect(sitter.length).toBeGreaterThan(0);
    expect(walker.length).toBe(sitter.length);
  });

  it("F10: names an ordinary walker at LOD 2", () => {
    renderWithWalker({ view: walkInView(), camera: CLOSE_UP_CAMERA_VIEW });
    calls.length = 0;
    flushRaf(2);

    // Close-up names everything. Nobody is hovered, selected or matched here;
    // at this zoom that is not a question anybody asks - `drawNameTags` only
    // consults `isNameTagCalledFor` when `lod === 1`, so at LOD 2 there is no
    // guard left to be vacuous about. This negative is real: it is the FIT
    // ladder alone standing between "Alpha Sitter" and the canvas, and
    // removing the fit (the seated tag drawing its written name, as it did
    // before this fixup) paints it and reddens this line.
    //
    // FIXUP 8: the sitter's tag is fitted to its one-tile seat (32px at this
    // zoom), which admits "Alpha" (its first word) but not the written
    // "Alpha Sitter" (72px) or a clip that keeps the required six characters
    // in front of the ellipsis. The walker is unaffected (`fitTiles: null`).
    const painted = paintedText();
    expect(painted).toContain("Alpha Walker");
    expect(painted).toContain("Alpha");
    expect(painted).not.toContain("Alpha Sitter");
  });

  const SIX_CHAR_FLOOR_CAMERA_VIEW: CommGraphTileViewState = {
    ...FIXED_CAMERA_VIEW,
    zoom: 2.5,
  };

  it("fixup 8: a name that cannot clear the six-character clip floor lands on initials, not a shorter clip", () => {
    // NAME_TAG_MIN_CLIPPED_CHARS = 6 is a floor the clip rung enforces, not
    // a number any existing renderer case pins - moving it to 5 changes
    // zero expectations elsewhere in this file. This is the one boundary
    // case built to land exactly on it, through the real render path.
    //
    // budget = officePlateWidthPx(1, 2.5) = max(1, 1) * 16 * 2.5 = 40px.
    // 2.5 >= 1.6, so this is LOD 2 - everyone is named, no hover/select/
    // match needed. Tag face in this harness is untracked, 10px * 0.6em =
    // 6px/char.
    //
    // "Bartholomew Quigley" (19 chars = 114px) does not fit written. The
    // clip rung tries the longest kept-prefix-plus-ellipsis that fits,
    // stopping at the floor: kept=6 gives "Bartho…" (7 chars = 42px), which
    // is OVER the 40px budget - and 6 is the last kept-length the rung will
    // try, so the clip rung yields nothing rather than trying kept=5. The
    // first word, "Bartholomew" (11 chars = 66px), also misses. Only the
    // initials rung fits: "BQ" (2 chars = 12px).
    const seat = seatAt({ seatId: "h/0/floor-seat", col: 2, row: 2, width: 1 });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["floor-seat", { ...seat, agentId: "floor-seat" }]]),
      seats: new Map([["h/0/floor-seat", seat]]),
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
    const floorAgent = agent("floor-seat", "Bartholomew Quigley");
    render(
      withQueryClient(
        cloneElement(
          officeElementWithView(
            view,
            new Set(["floor-seat"]),
            [floorAgent],
            {},
          ),
          { view: SIX_CHAR_FLOOR_CAMERA_VIEW },
        ),
      ),
    );
    setIntersecting(true);
    flushRaf(2);

    const painted = paintedText();
    expect(painted).toContain("BQ");
    expect(painted).not.toContain("Barth…");
  });

  it("F11 fixup 7: names all five of a wide HQ board's hottest, spelt out rather than lettered to initials", () => {
    // The reviewer's own fixture: ordinary two-word names. Fixup 7 removes
    // the initials rung this case used to land on ("AB BQ GS DA ED" at eight
    // tiles) - below the first-names rung the HQ board now counts instead of
    // lettering, so pinning "all five named, none dropped" needs a board
    // wide enough for a name rung to actually fit. Forty-eight tiles is
    // 768px; the widest rung, the five names written out in full, is
    // sixty-six characters - 66 * 6.8 + 8 = 456.8px - comfortably inside it.
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
      widthTiles: 48,
      text: "",
      ownerAgentId: null,
      hostId: null,
      agentIds: roster,
      civicRoomId: null,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 64,
      rows: 64,
      desks: new Map(),
      seats: new Map(),
      signs: [hqBoard],
      rooms: [],
      floors: [emptyFloor()],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(64, 64),
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

    // Found by the first word either way, so a failure prints the plate that
    // WAS painted rather than `undefined`.
    const plate = paintedText().find((text) => text.includes("ALPHA"));
    // FIVE ENTRIES, spelt out in full and uppercased (`signPlateText` upper-
    // cases every plate). The sixth (Zeta Idle) is outside the five hottest
    // and stays off; the fifth is the one the old character budget used to
    // drop, and the one the old ladder's initials rung used to letter away.
    expect(plate).toBe(
      "ALPHA BUILD · BETA QUEUE · GAMMA STORE · DELTA AUTH · EPSILON DOCS",
    );
    // And it fits. This canvas answers `measureText` in the face the caller
    // set, so a tracked bold 10px plate advances 6.8px a character: the
    // plate is 66*6.8 + 8 = 456.8px on a board 48 tiles * 16px * zoom 1 =
    // 768px wide.
    const measured = (plate?.length ?? 0) * 6.8 + 8;
    expect(measured).toBeLessThanOrEqual(48 * OFFICE_TILE);
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
      civicRoomId: null,
    };
    const hqBoard: OfficeSign = {
      kind: "hq-board",
      tile: { col: 8, row: 2 },
      widthTiles: 8,
      text: "",
      ownerAgentId: null,
      hostId: null,
      agentIds: roster,
      civicRoomId: null,
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

  it("letters a civic sign with the scene's live occupancy, not the bare word", () => {
    // THE CANVAS HANDS THE SCENE'S TALLY TO THE RESOLVER. A hand-built
    // empty tally would letter `INFIRMARY · 0 OF n` at close-up; the
    // live count is what proves the seam. Close-up is
    // `OFFICE_LOD_CLOSEUP_ZOOM` (1.6), the band the counter exists at.
    const epic = makeTestEpic("one-team", 12, 9);
    const live = epic.agents.filter((person) => !person.archived);
    // `.at` rather than `live[0]`, so the guard below is a real check: an
    // index read is typed non-optional here and the throw would be dead code.
    const crashed = live.at(0);
    if (crashed === undefined) throw new Error("expected a live agent");
    const nodes: CommGraphAgentNode[] = epic.agents.map((person) => ({
      id: person.id,
      kind: person.kind,
      name: person.name,
      hostId: person.hostId,
      parentId: person.parentId,
      harnessId: person.harnessId,
      model: person.model,
      archived: person.archived,
      archivedAt: person.archivedAt,
      createdAt: person.createdAt,
    }));
    const store = useAppLocalNotificationsStore.getState();
    store.activateIdentity("k4-civic-sign");
    store.upsert({
      id: "k4-civic-fail",
      originHostId: crashed.hostId,
      updatedAt: 1,
      readAt: null,
      kind: "stream.transport.error",
      sourceRef: crashed.id,
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: crashed.id,
      },
      message: "crash",
      detail: null,
    });

    render(
      withQueryClient(
        cloneElement(
          officeElementWithView(
            OFFICE_VIEWS.floor,
            new Set(live.map((person) => person.id)),
            nodes,
            {},
          ),
          {
            view: {
              ...FIXED_CAMERA_VIEW,
              zoom: OFFICE_LOD_CLOSEUP_ZOOM,
            },
          },
        ),
      ),
    );
    setIntersecting(true);
    flushRaf(4);

    const plate = paintedText().find((text) => text.startsWith("INFIRMARY"));
    expect(plate).toBeDefined();
    const match = /^INFIRMARY · (\d+) OF (\d+)$/.exec(plate ?? "");
    expect(match).not.toBeNull();
    if (match === null) return;
    const taken = Number(match[1]);
    const beds = Number(match[2]);
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(beds);
  });

  /**
   * T5 fixup 5: the block map's new `quad` drawable actually reaches the
   * canvas as a filled path.
   *
   * D28/D58 rewrote what a lod-0 region emits - four PROJECTED corners
   * instead of an axis-aligned box - but nothing upstream of the renderer
   * proves the new `kind: "quad"` arm of `drawDrawableLayer` is wired at
   * all. A painter that started emitting `quad` and a canvas that had not
   * grown the case for it would drop every overview region silently: the
   * frame would carry the drawable, `officeBakesIntoStaticFloor` would let
   * it through same as today, and the screen would just show whatever was
   * there before. Driven through the same `officeElementWithView` +
   * `painter.floor` override F5 and F10 use above, rather than a real
   * isometric plan and camera zoom, because what is under test is the
   * SWITCH in `drawDrawableLayer` - `office-plan-perf.test.ts` and
   * `office-overview-coverage.test.ts` already cover the isometric painter
   * producing the right quads from a real Campus/City plan.
   */
  it("T5: paints a lod-0 quad drawable as one filled path, not a fillRect", () => {
    // An arbitrary, deliberately non-axis-aligned quadrilateral - if the
    // canvas silently fell back to treating this as a bounding box (as a
    // `block` would be), the traced path below would not match it.
    const quadPoints: readonly [
      OfficePoint,
      OfficePoint,
      OfficePoint,
      OfficePoint,
    ] = [
      { x: 120, y: 40 },
      { x: 168, y: 64 },
      { x: 120, y: 88 },
      { x: 72, y: 64 },
    ];
    const quadFill: OfficeBlockFill = "room";
    const quadDrawable: OfficeDrawable = {
      kind: "quad",
      points: quadPoints,
      fill: quadFill,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map(),
      seats: new Map(),
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
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        // The real floor painter never emits a `quad` (its projector is the
        // identity, so `block` is all it needs) - this stands in for an
        // isometric painter's lod-0 answer without standing up a real
        // isometric plan, and only at lod 0: at lod 1/2 it falls back to the
        // real painter so the case still exercises actual floor content
        // (walls, ground) rather than an empty frame either way.
        floor: (
          floorLayout: OfficeLayout,
          tiles: OfficeTileRect,
          lod: OfficeLod,
        ) =>
          lod === 0
            ? [quadDrawable]
            : OFFICE_VIEWS.floor.painter.floor(floorLayout, tiles, lod),
      },
    };

    // Below `OFFICE_LOD_OFFICE_ZOOM` (0.7): the camera this suite's other
    // cases hold at zoom 1 sits in the lod-1 band, which would route through
    // the real painter and never reach the override. Named, because the
    // screen corners asserted below are this zoom's own arithmetic.
    const QUAD_ZOOM = 0.5;
    render(
      withQueryClient(
        officeElementWithView(view, new Set<string>(), [], {
          view: { ...FIXED_CAMERA_VIEW, zoom: QUAD_ZOOM },
        }),
      ),
    );
    setIntersecting(true);
    flushRaf(3);

    // Anti-vacuity: a frame that drew nothing would leave this array empty
    // and every assertion below vacuously true.
    expect(calls.length).toBeGreaterThan(0);

    const drawCallIndex = calls.findIndex(
      (call) => call.method === "beginPath",
    );
    // `beginPath` is used only by the quad path and Find's ring/underline in
    // this frame; with no agents on screen and Find untouched, the block
    // map's own call is the one this frame can produce.
    expect(drawCallIndex).toBeGreaterThanOrEqual(0);
    const fillStyleBefore = [...calls]
      .slice(0, drawCallIndex)
      .reverse()
      .find((call) => call.method === "set:fillStyle");
    // `blockColor("room", palette)` resolves to `palette.wallLight` - proving
    // the fill the SCENE chose survives to the actual paint call, not just
    // that some path got filled.
    expect(fillStyleBefore?.args[0]).toBe(officePalette("light").wallLight);

    const traced = calls.slice(drawCallIndex, drawCallIndex + 6);
    expect(traced.map((call) => call.method)).toEqual([
      "beginPath",
      "moveTo",
      "lineTo",
      "lineTo",
      "lineTo",
      "closePath",
    ]);
    // The four corners, in the perimeter order `quadOf` builds them: the
    // opening `moveTo` at the first point, then a `lineTo` per remaining
    // corner - proving the renderer traces the drawable's own points rather
    // than deriving a shape from a bounding box.
    //
    // WHERE THEY LAND, not what was passed. A block map is painted under the
    // CAMERA's transform, so the screen corner of a drawable point is
    // `point * zoom + camera` in CSS pixels - the same arithmetic F5 spells
    // out for a sign anchor, one layer earlier. Asserting the raw arguments
    // proved the renderer read the drawable's points; asserting these proves
    // the quad it traced is also the quad the camera puts on the screen.
    const dpr = window.devicePixelRatio || 1;
    const onScreen = (point: OfficePoint): Point2D => ({
      x: (point.x * QUAD_ZOOM + FIXED_CAMERA_VIEW.x) * dpr,
      y: (point.y * QUAD_ZOOM + FIXED_CAMERA_VIEW.y) * dpr,
    });
    expect(traced[1]?.screen.points).toEqual([onScreen(quadPoints[0])]);
    expect(traced[2]?.screen.points).toEqual([onScreen(quadPoints[1])]);
    expect(traced[3]?.screen.points).toEqual([onScreen(quadPoints[2])]);
    expect(traced[4]?.screen.points).toEqual([onScreen(quadPoints[3])]);
    const fillAfter = calls
      .slice(drawCallIndex)
      .find((call) => call.method === "fill" || call.method === "fillRect");
    // The close is followed by a `fill()` of the traced path - not a
    // `fillRect`, which is what a `block` drawable (or a canvas that fell
    // back to one) would call instead.
    expect(fillAfter?.method).toBe("fill");

    // The whole point of a `quad` over the old equal-area `block`: nothing in
    // this frame paints a rectangle sized to the region. The one `fillRect`
    // this frame is allowed is the background clear at frame top, which
    // covers the full viewport and is unrelated to the quad's own bounds.
    const rectCalls = calls.filter((call) => call.method === "fillRect");
    expect(rectCalls).toHaveLength(1);
    // The clear starts at the viewport's own origin ON SCREEN - it runs under
    // the frame-top screen-space reset, before the camera transform goes in,
    // so the camera's `x: 5` must not reach it.
    expect(screenBoxOf(rectCalls[0])).toMatchObject({ left: 0, top: 0 });
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
      // ZOOM RAISED FOR FIXUP 8: a City lot is one tile, and a seated tag is
      // now fitted to that seat's own width. At zoom 1 the one-tile budget
      // (16px) admits nothing past initials ("QZ"), which drops this case's
      // own mechanism - a TRUNCATED tag, not an initialed or dropped one.
      // Rung 2 needs at least a 7-glyph clip ("Quilfe…") to fit, which needs
      // 42px; 2.7 clears that (43.2px) while staying well inside the zoom
      // range this suite's other City cases already use.
      const matched = renderCity(2.7, LONG_MATCH);
      await findFor(matched.name);
      calls.length = 0;
      // ONE frame. Every count below is per frame, and a flush is a frame.
      flushRaf(1);

      // The control this case exists to be. A long name is painted
      // "Quilfe…" by the tag path and in full by Find, so the two strings
      // differ and an exact-match count sees only one of them - which is
      // exactly how the fixup-3 case passed while two names were on screen.
      expect(namePaints(matched.name)).toBe(PASSES_PER_LABEL);
      // And the one that survived is the tag's, fitted to its own seat -
      // not Find's untruncated copy over the top of it.
      const painted = paintedText().filter((text) => text.endsWith("…"));
      expect(painted).toContain("Quilfe…");
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
        // WHERE THE NAME LANDED, not the anchor asked for: a tag that tracked
        // a moving character while the camera cancelled the motion is a name
        // that never moved on screen, and only the projected point can say so.
        if (painted !== undefined) anchors.push(screenPointOf(painted).x);
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
     *
     * FIXUP 8 fits a seated tag to its own seat, and requirement 4 there is
     * that two neighbours' tags then never overlap BY CONSTRUCTION - which
     * retires a one-tile-pitch collision as a real scenario: a seat that
     * narrow would have fitted its neighbour's tag down to initials long
     * before the pitch mattered. So each seat here is given `width: 4` -
     * 102.4px at this zoom, enough to hold a full 14-character tag (84px)
     * unfitted - while the desks stay one tile apart. A SEAT wider than its
     * own desk is spacing no real plan produces; it exists here only to let
     * this fixture keep proving what it always proved (a collision
     * `layoutNameTags` itself has to resolve) without also becoming a test
     * of the fit ladder, which the resolver's own suite already covers.
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
        seatAt({
          seatId: `h/0/cluster-${index}`,
          col: 4 + index,
          row: 5,
          width: 4,
        }),
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

  describe("CommGraphOfficeCanvas fixup 8 (name tags) - dense cubby rows never overprint their neighbours", () => {
    /**
     * THE SITTING'S OWN REGRESSION, replayed from the frame's recorded
     * `fillText` calls - POST-`layoutNameTags`, the placed output, not what
     * each tag asked for before layout touched it. That still catches the
     * finding: `layoutNameTags` resolves a collision by shifting the loser
     * down exactly one line height (`NAME_TAG_LINE_HEIGHT`) and checking the
     * strict `<` in `overlaps()`, which only asks whether the two boxes'
     * baselines coincide - a shift of exactly one line height already
     * clears that strict check, so the tag is PLACED rather than dropped,
     * still sitting horizontally on top of its neighbour. `collisions()`
     * below reopens exactly that gap: its baseline window is INCLUSIVE
     * (`dy <= NAME_TAG_LINE_HEIGHT`, not `<`), so a tag the layout pass
     * staggered one line down still counts as a neighbour rather than
     * reading as resolved. A case built from `layoutNameTags`' own strict
     * check would never see this - it would have to reimplement the exact
     * mechanism being tested, which begs the question - so this reads the
     * canvas's actual painted boxes and checks them under the ticket's
     * "centre ± measured width / 2" rule instead of the placer's own.
     *
     * ZOOM 3, not 2: at a one-tile budget of 16 px (zoom 2) the honest
     * ladder answer for this fixture's `team-N-lead` / `team-N-member-K`
     * names is `null` - they are single hyphenated words with no rung 3
     * (one word has no "first word" distinct from itself) and no rung 4
     * (one word's initials is one letter, which never qualifies) - so a
     * collision assertion at zoom 2 would be checking boxes that were never
     * drawn. At zoom 3 the one-tile budget is 48 px and every reading in
     * this fixture resolves, so the cubby rows the finding is about are
     * fully populated and a collision check means something. See the zoom-2
     * companion below for the "or nothing" half of the same finding.
     */
    function locateDensestCubbyCluster(
      agents: ReadonlyArray<OfficeAgentInput>,
    ): {
      readonly focus: OfficeRect;
      readonly awayIds: ReadonlySet<string>;
    } {
      const ids = new Set(agents.map((person) => person.id));
      const probe = new OfficeScene(OFFICE_VIEWS.building, null);
      const probeStatusById = new Map<string, OfficeAgentStatus>();
      probe.sync({
        agents,
        visibleAgentIds: ids,
        statusById: probeStatusById,
        partition: partitionOfficePopulation({
          agents,
          statusById: probeStatusById,
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
        feedSettled: false,
      });
      const probeFrame = probe.frame(2, WHOLE_WORLD);
      // LIVE ONLY: an away agent's seat prints "reserve", not its own name,
      // so it contributes no candidate tag and would only dilute the count.
      const cubbyDesks = Array.from(
        probe.layout()?.desks.entries() ?? [],
      ).filter(
        ([agentId, desk]) =>
          desk.hitTiles.width === 1 && !probeFrame.awayAgentIds.has(agentId),
      );
      if (cubbyDesks.length === 0) {
        throw new Error(
          "expected the 309-agent triage Building to seat at least one live cubby occupant",
        );
      }
      // THE DENSEST CUBBY, not merely the first one found: a lone occupied
      // cubby near the door proves nothing about a dense row.
      let bestAgentId = cubbyDesks[0][0];
      let bestNeighbourCount = -1;
      for (const [agentId, desk] of cubbyDesks) {
        const neighbours = cubbyDesks.filter(([, other]) => {
          if (other === desk) return false;
          const dCol = other.deskTile.col - desk.deskTile.col;
          const dRow = other.deskTile.row - desk.deskTile.row;
          return Math.abs(dCol) <= 6 && Math.abs(dRow) <= 6;
        }).length;
        if (neighbours > bestNeighbourCount) {
          bestNeighbourCount = neighbours;
          bestAgentId = agentId;
        }
      }
      const focus = probe.locate(bestAgentId);
      if (focus === null) {
        throw new Error(`expected a real seat for ${bestAgentId}`);
      }
      return { focus, awayIds: probeFrame.awayAgentIds };
    }

    function renderBuildingAtZoomOverCluster(
      agents: ReadonlyArray<CommGraphAgentNode>,
      probeAgents: ReadonlyArray<OfficeAgentInput>,
      zoom: number,
    ): void {
      const ids = new Set(agents.map((person) => person.id));
      const { focus } = locateDensestCubbyCluster(probeAgents);
      render(
        withQueryClient(
          cloneElement(
            officeElementWithView(OFFICE_VIEWS.building, ids, agents, {}),
            {
              view: {
                ...FIXED_CAMERA_VIEW,
                zoom,
                x: 600 - (focus.x + focus.width / 2) * zoom,
                y: 400 - (focus.y + focus.height / 2) * zoom,
              },
            },
          ),
        ),
      );
      setIntersecting(true);
      // A settled floor draws nothing new once nothing has changed (the
      // frame loop's own idle gate), so this reads the accumulated calls of
      // the settling flushes themselves rather than resetting and hoping
      // for one more - a STILL scene redraws the same frame identically,
      // and the de-duplication in `tagBoxesFrom` collapses those repeats
      // back to one. Nobody is revealed mid-flight (one sync, `playing`
      // stays false throughout `officeElementWithView`'s default render),
      // so every character here is seated and none is a walker staggering
      // the read.
      flushRaf(3);
    }

    it("keeps every seated character's placed tag box disjoint from its neighbours', post-layout (309 Building, zoom 3)", () => {
      const epic = makeTestEpic("triage", 309, 1);
      const agents = epic.agents.map(canvasAgent);
      const probeAgents = agents.map(officeAgentInput);

      renderBuildingAtZoomOverCluster(agents, probeAgents, 3);

      const records = replayFillText(calls);
      const boxes = tagBoxesFrom(records);
      // ANTI-VACUITY: a case that found nothing to check is not a case.
      expect(boxes.length).toBeGreaterThan(3);
      expect(collisions(boxes)).toEqual([]);
    });

    it("companion: at zoom 2 the same dense cubby cluster names nobody, rather than overprinting them", () => {
      const epic = makeTestEpic("triage", 309, 1);
      const agents = epic.agents.map(canvasAgent);
      const probeAgents = agents.map(officeAgentInput);

      renderBuildingAtZoomOverCluster(agents, probeAgents, 2);

      const records = replayFillText(calls);
      const boxes = tagBoxesFrom(records);
      // ANTI-VACUITY: the frame still has to have painted SOMETHING (a sign
      // plate, a reserved cubby) or a blank canvas would pass this for the
      // wrong reason. The occupant check below is what actually matters.
      expect(calls.some((call) => call.method === "fillText")).toBe(true);
      const occupantBoxes = boxes.filter((box) => box.text !== "reserve");
      expect(occupantBoxes).toEqual([]);
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
      const firstHost = seatAt({
        seatId: "h/0/first-host",
        col: 2,
        row: 2,
        width: 1,
      });
      const firstWorker = seatAt({
        seatId: "h/0/first-worker",
        col: 12,
        row: 12,
        width: 1,
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
      const otherHost = seatAt({
        seatId: "h/0/other-host",
        col: 6,
        row: 6,
        width: 1,
      });
      const otherWorker = seatAt({
        seatId: "h/0/other-worker",
        col: 10,
        row: 10,
        width: 1,
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
      feedSettled: false,
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
    // ZOOM RAISED FOR FIXUP 8: Orchestrator's desk is two tiles, and at
    // zoom 1 that budget (32px) admits nothing readable - not even initials,
    // since "Orchestrator" is one word - so its tag is DROPPED there rather
    // than qualified. 1.5 is still inside LOD 1 (below the 1.6 close-up
    // threshold) and gives 48px, which fits the clip rung's longest reading,
    // "Orchest…" (7 kept characters).
    render(withQueryClient(realTowersFocusedAtZoom(1.5)));
    fireEvent.click(
      screen.getByTestId(`comm-graph-office-agent-${ORCHESTRATOR.id}`),
    );
    setIntersecting(true);
    flushRaf(4);
    expect(
      calls.filter(
        (call) => call.method === "fillText" && call.args[0] === "Orchest…",
      ),
    ).not.toHaveLength(0);
  });

  it("draws a qualified real Towers name at LOD 1 when hovered", () => {
    // See the "when selected" case above for why this is 1.5, not 1.
    render(withQueryClient(realTowersFocusedAtZoom(1.5)));
    fireEvent.pointerEnter(
      screen.getByTestId(
        `comm-graph-office-directory-agent-${ORCHESTRATOR.id}`,
      ),
    );
    setIntersecting(true);
    flushRaf(4);
    expect(
      calls.some(
        (call) => call.method === "fillText" && call.args[0] === "Orchest…",
      ),
    ).toBe(true);
  });

  it("draws a qualified real Towers name when Find matches it", async () => {
    // PASSES FOR A DIFFERENT REASON since fixup 8: at zoom 1 Orchestrator's
    // own tag is fitted to its two-tile seat and finds nothing readable to
    // keep (not even initials - "Orchestrator" is one word), so the tag is
    // DROPPED here and it is Find's own untruncated copy that names the
    // agent, not a qualified ordinary tag any more.
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
    // Reviewer, Bay lead and Bay member all fit their two-tile seat (64px)
    // whole. Orchestrator (12 chars, 72px) does not, and comes down to its
    // own clip rung, "Orchestra…" (9 kept characters) - fitted to its seat,
    // not truncated at the scene's flat 14-character cap.
    expect(names.has(REVIEWER.name)).toBe(true);
    expect(names.has(HOST_B_LEAD.name)).toBe(true);
    expect(names.has(HOST_B_MEMBER.name)).toBe(true);
    expect(names.has(ORCHESTRATOR.name)).toBe(false);
    expect(
      calls.some(
        (call) => call.method === "fillText" && call.args[0] === "Orchestra…",
      ),
    ).toBe(true);
  });

  it("draws NO tag-face reading of an unqualified real Towers agent at office lod (plates still paint)", () => {
    // Filtering recorded `fillText` calls for the four agents' FULL names is
    // vacuous: at office lod (zoom 1, below the close-up threshold) every
    // one of these seats is two-tile (Towers has no cubbies at all - see
    // the anchor describe below), so even an UNGUARDED tag would ladder
    // down to something short of the written name - "Bay" for `Bay lead`/
    // `Bay member`, nothing at all for the single-word `Orchestrator`/
    // `Reviewer` - never the full name either filter checks for. Confirmed:
    // deleting the LOD-1 `isNameTagCalledFor` guard block from the renderer
    // left the whole suite (all 72 cases) passing. So this asserts over the
    // TAG FACE instead - every reading the ladder could produce for these
    // names, not just the written one - via the same replay/box machinery
    // A.3 uses, which already separates tags from plates by the font the
    // call was made under. THIS is what pins the guard: with it deleted,
    // `Bay lead`/`Bay member` ladder down to "Bay" at the 32px office-lod
    // budget and this case reddens on that reading; with the guard present,
    // it stays green because nothing paints at all.
    const agents = [ORCHESTRATOR, REVIEWER, HOST_B_LEAD, HOST_B_MEMBER];
    const visibleIds = new Set(agents.map((person) => person.id));
    render(
      withQueryClient(
        officeElementWithView(OFFICE_VIEWS.towers, visibleIds, agents, {}),
      ),
    );
    setIntersecting(true);
    flushRaf(4);

    // ANTI-VACUITY: the frame really rendered - some plate (bold face)
    // painted. An empty recording (a broken render, a wrong zoom) must not
    // pass this case by having nothing to check.
    const records = replayFillText(calls);
    expect(records.some((record) => record.font.startsWith("bold "))).toBe(
      true,
    );

    function isReadingOf(text: string, name: string): boolean {
      if (text === name) return true;
      if (text.endsWith("…") && name.startsWith(text.slice(0, -1))) {
        return true;
      }
      const firstWord = name.split(" ")[0] ?? name;
      if (text === firstWord && firstWord !== name) return true;
      const initials = name
        .split(" ")
        .filter((word) => word !== "")
        .map((word) => word.slice(0, 1))
        .join("");
      return text === initials && initials.length >= 2;
    }

    const boxes = tagBoxesFrom(records);
    const unqualifiedReadings = boxes.filter((box) =>
      agents.some((person) => isReadingOf(box.text, person.name)),
    );
    expect(unqualifiedReadings).toEqual([]);
  });

  describe("CommGraphOfficeCanvas fixup 8 (name tags) - a character anchored off its seat's centre still never reaches a neighbour's tag", () => {
    /**
     * `office-scene.ts`'s real oblique geometry anchors a seated character's
     * label on the CHARACTER, and every Towers desk is two tiles wide with
     * `deskTile.col === chairTile.col` (`oblique-plan.ts`) - the character
     * sits on the desk's LEFT column, not the two-tile box's centre. A
     * maximal reading, sized to the full two-tile budget but centred on
     * that off-centre anchor, reaches a little past the desk's own left
     * edge and a little short of its right edge - never onto a NEIGHBOUR's
     * tag, because every desk in a row carries the identical offset, so a
     * row shifts together rather than colliding.
     *
     * `HOST_B_LEAD` and `HOST_B_MEMBER` do not land on one storey by
     * themselves - the lead settles alone as host-2's HQ and the member is
     * the only solo, so it gets a bullpen storey to itself. Towers has no
     * quiet path at all (`quietIds` returns `[]` for `mode === "towers"`,
     * so every desk here is already the two-tile shape this case needs) -
     * what is missing is a NEIGHBOUR, not the geometry. One extra solo on
     * the same host is enough: the bullpen packs same-host solos into one
     * storey together, so a second one lands adjacent to `HOST_B_MEMBER` at
     * the real two-tile pitch. `REAL_TOWERS_AGENTS` itself is untouched -
     * four other cases in this describe assert over exactly those four -
     * this extra agent exists only inside this case.
     */
    const EXTRA_SOLO: CommGraphAgentNode = {
      ...agent("agent-6", "Bay overflow lead"),
      hostId: "host-2",
    };
    const ANCHOR_AGENTS: ReadonlyArray<CommGraphAgentNode> = [
      ...REAL_TOWERS_AGENTS,
      EXTRA_SOLO,
    ];

    function anchorPairFocusedAtZoom(zoom: number) {
      const agents = ANCHOR_AGENTS.map(officeAgentInput);
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
        feedSettled: false,
      });
      const focus = scene.locate(HOST_B_MEMBER.id);
      if (focus === null) throw new Error("expected a real Towers seat");
      const neighbour = scene.locate(EXTRA_SOLO.id);
      if (neighbour === null) throw new Error("expected a real Towers seat");
      return {
        element: cloneElement(
          officeElementWithView(
            OFFICE_VIEWS.towers,
            new Set(ANCHOR_AGENTS.map((person) => person.id)),
            ANCHOR_AGENTS,
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
        ),
        focus,
        neighbour,
      };
    }

    it("keeps two adjacent Towers desks' maximal readings disjoint (zoom 2)", () => {
      const { element, focus, neighbour } = anchorPairFocusedAtZoom(2);
      // GUARD, not a red of its own: this case's whole premise is that
      // `HOST_B_MEMBER` and `EXTRA_SOLO` land in CONSECUTIVE two-tile bullpen
      // slots. That is a fixture accident, not something this test controls
      // - a plan change that seats them apart would leave the collision
      // assertion below green with two tags that were never neighbours,
      // which is a pass for the wrong reason. Pin the premise directly: same
      // storey (identical `y` and `height`) and exactly one two-tile pitch
      // apart on `x`, so a future plan change that breaks the adjacency
      // reddens HERE rather than silently voiding the case beneath it.
      expect(neighbour.y).toBe(focus.y);
      expect(neighbour.height).toBe(focus.height);
      expect(Math.abs(neighbour.x - focus.x)).toBe(2 * OFFICE_TILE);

      render(withQueryClient(element));
      setIntersecting(true);
      flushRaf(4);

      const records = replayFillText(calls);
      const boxes = tagBoxesFrom(records).filter(
        (box) => box.text === "Bay member" || box.text.startsWith("Bay overf"),
      );
      // ANTI-VACUITY: both desk tags actually painted, not zero/one of them.
      expect(boxes.length).toBe(2);
      expect(collisions(boxes)).toEqual([]);
    });
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

/**
 * THE WARD'S BEACON, as painted. K4's signs suite pins the FRAME NUMBER;
 * K2's art pin pins the PIXEL MAPS; these cases are the seam that stops
 * either side being re-authored without the other noticing. The Floor is
 * the wrong witness: it has a road, so its ward carries no beacon at all.
 *
 * WHAT EACH CASE ACTUALLY PROVED, corrected. Against the unfixed source BOTH
 * cases fail in `chromeSirenOn`, on a lamp that is nowhere above the plate -
 * `captureChromeSiren` is the first thing either one does with a blit, so
 * `lensClearancePx` and its own throw are never reached. The red here is
 * PLACEMENT, and it is one red carried twice, not two.
 *
 * The clearance bound is therefore a FIXED-SOURCE PROPERTY: `LENS_CLEARANCE_PX`
 * is what makes the coverage claim testable from here on, not what proved the
 * fix. Both halves are worth having and the distinction is not pedantry - a
 * property pinned on fixed source holds the value against the NEXT change,
 * while a red is evidence about the last one, and only a red licenses the
 * claim that a defect was caught.
 *
 * It could be made a red only by loosening `chromeSirenOn` to accept any
 * siren blit, including the world-space one. That trades a precise failure
 * for a vague one and measures a position the fix deletes, so it is not done.
 * `3508373b9`'s body says "the FIRST case fails on a missing chrome
 * placement", which reads as a contrast with a second case that did something
 * else; it did not, and this comment is the correction.
 */
describe("CommGraphOfficeCanvas - Mission control ward beacon", () => {
  let rafQueue: Array<{
    readonly id: number;
    readonly callback: FrameRequestCallback;
  }> = [];
  let nextRafId = 1;
  let canceledRafIds = new Set<number>();
  let calls: RecordedCall[] = [];
  let restoreGetContext: (() => void) | null = null;
  let frameClockMs = 0;

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
    useAppLocalNotificationsStore.setState({ byId: {} });
  });

  const MISSION_CONTROL = OFFICE_VIEWS["mission-control"];
  /**
   * Unattributed on purpose. Mission control's civic seats are authored with
   * `hostId: null`, and `firstFreeSeat` will not hand a bed to a host-1
   * agent - the Floor roster would occupy nothing here and the beacon would
   * never leave frame 0.
   */
  const HALL_LEAD: CommGraphAgentNode = {
    ...agent("hall-lead", "Hall lead"),
    hostId: null,
  };
  const HALL_MEMBER: CommGraphAgentNode = {
    ...agent("hall-member", "Hall member"),
    hostId: null,
    parentId: HALL_LEAD.id,
  };
  const ROSTER = [HALL_LEAD, HALL_MEMBER];
  const ROSTER_IDS: ReadonlySet<string> = new Set(
    ROSTER.map((person) => person.id),
  );
  const LAMP_SIZE = officeSpriteSize({ name: "siren-light" });
  /**
   * How many flushes cross one siren period. Each successful frame after
   * the opening skip ticks `OFFICE_FRAME_INTERVAL_MS`; the +1 is that skip
   * plus a frame of slack so we are not sitting on the 250 ms boundary.
   */
  const FLUSHES_PER_SIREN_PERIOD =
    Math.ceil(OFFICE_SIREN_FRAME_MS / OFFICE_FRAME_INTERVAL_MS) + 1;

  /**
   * Measured: lowest differing lens pixel's bottom edge to the plate's
   * top, in CSS pixels (device coords from the CTM, then divided by dpr).
   * Screen-space chrome is exactly the dpr scale, so the round trip is
   * still 3 at both zooms; a world-space pair, or a local `scale(zoom)`
   * around the lamp alone, reports `3 × zoom`.
   */
  const LENS_CLEARANCE_PX = 3;

  interface SirenBlit {
    readonly name: "siren-light" | "siren-light-b";
    /**
     * The blit's top-left in the space the renderer drew it in, kept because
     * a LENS PIXEL is an offset from it - the lamp's own sprite grid, which
     * no recorded call ever names on its own.
     */
    readonly x: number;
    readonly y: number;
    readonly theme: "light" | "dark";
    readonly matrix: CanvasTransform;
    /** The same top-left, in CSS pixels on screen. */
    readonly screen: Point2D;
  }

  function mapNamed(name: OfficeSpriteName): ReadonlyArray<string> {
    const entry = officeSpriteMaps().find(
      (candidate) => candidate.name === name,
    );
    if (entry === undefined) {
      throw new Error(`no authored map for ${name}`);
    }
    return entry.map;
  }

  function pixelAt(
    sprite: RasterizedSprite,
    x: number,
    y: number,
  ): ReadonlyArray<number> {
    const offset = (y * sprite.width + x) * 4;
    return [
      sprite.pixels[offset],
      sprite.pixels[offset + 1],
      sprite.pixels[offset + 2],
      sprite.pixels[offset + 3],
    ];
  }

  function rasterNamed(
    name: "siren-light" | "siren-light-b",
    theme: "light" | "dark",
  ): RasterizedSprite {
    return rasterizeSpriteMap(
      mapNamed(name),
      officeSpriteColors({ name }, theme),
      false,
    );
  }

  function plateFont(): string {
    return `bold ${OFFICE_SIGN_FONT_PX}px ${OFFICE_SIGN_MONOSPACE_STACK}`;
  }

  function plateMeasure(text: string): number {
    return (
      modelledTextWidth(
        text,
        plateFont(),
        `${OFFICE_SIGN_LETTER_SPACING_EM}em`,
      ) +
      OFFICE_SIGN_PADDING_X * 2
    );
  }

  function missionControlLayout(): OfficeLayout {
    const agents = ROSTER.map(officeAgentInput);
    const statusById = new Map(
      agents.map((person) => [person.id, "idle" as const]),
    );
    return MISSION_CONTROL.plan({
      agents,
      partition: partitionOfficePopulation({
        agents,
        statusById,
        previous: null,
      }),
      occupancy: new Map(),
      needsCapacity: [],
      activityById: new Map(),
      viewport: {
        width: BOUNDING_RECT_STUB.width,
        height: BOUNDING_RECT_STUB.height,
      },
      previous: null,
    });
  }

  function resolveWardFrame(args: {
    readonly layout: OfficeLayout;
    readonly occupied: number;
    readonly nowMs: number;
    readonly reducedMotion: boolean;
    readonly zoom: number;
  }): 0 | 1 | null {
    const ward = args.layout.floors[0]?.civic.find(
      (room) => room.kind === "infirmary",
    );
    if (ward === undefined) {
      throw new Error("expected Mission control to plan a medbay");
    }
    const occupiedByRoom: OfficeCivicTally["occupiedByRoom"] =
      args.occupied === 0
        ? new Map()
        : new Map([[ward.civicRoomId, args.occupied]]);
    const tally: OfficeCivicTally = {
      occupiedByRoom,
      archivedByHost: new Map(),
    };
    const drawn = officeSignsToDraw({
      floors: args.layout.floors,
      civicTally: tally,
      clock: { nowMs: args.nowMs, reducedMotion: args.reducedMotion },
      signs: args.layout.signs,
      visibleAgentIds: ROSTER_IDS,
      statusById: new Map(),
      nameById: new Map(),
      hostNameById: new Map(),
      roleClaims: {},
      zoom: args.zoom,
      measure: plateMeasure,
      projector: MISSION_CONTROL.painter.projector(args.layout),
      lod: officeLodForZoom(args.zoom),
    });
    const beacon = drawn.find((entry) => entry.sirenFrame !== null);
    return beacon === undefined ? null : beacon.sirenFrame;
  }

  function installReducedMotion(matches: boolean): {
    readonly setMatches: (next: boolean) => void;
  } {
    let current = matches;
    const listeners: Array<() => void> = [];
    const media = {
      get matches(): boolean {
        return current;
      },
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: (_event: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: (_event: string, listener: () => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
    vi.stubGlobal("matchMedia", (query: string) => {
      if (query.includes("prefers-reduced-motion")) return media;
      return {
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    });
    return {
      setMatches: (next: boolean) => {
        current = next;
        act(() => {
          for (const listener of listeners) listener();
        });
      },
    };
  }

  function renderMissionControl(zoom: number): void {
    render(
      withQueryClient(
        officeElementWithView(MISSION_CONTROL, ROSTER_IDS, ROSTER, {
          view: { ...FIXED_CAMERA_VIEW, zoom },
        }),
      ),
    );
    setIntersecting(true);
  }

  function sirenNameOf(ref: unknown): "siren-light" | "siren-light-b" | null {
    if (typeof ref !== "object" || ref === null) return null;
    if (!("name" in ref)) return null;
    const name = ref.name;
    if (name === "siren-light" || name === "siren-light-b") return name;
    return null;
  }

  function sirenThemeOf(value: unknown): "light" | "dark" | null {
    if (value === "light" || value === "dark") return value;
    return null;
  }

  /**
   * The lamp right-aligned above this plate, matched IN SCREEN SPACE.
   *
   * Both the plate and the lamp are chrome, painted under the same
   * screen-space transform, so the alignment the reader sees is the one in
   * CSS pixels - and `LAMP_SIZE` is the sprite's own CSS size, which is what
   * that transform makes of it.
   */
  function chromeSirenOn(
    blits: ReadonlyArray<SirenBlit>,
    plate: ScreenBox,
  ): SirenBlit {
    const expectedX = plate.left + plate.width - LAMP_SIZE.width;
    const above = blits.filter(
      (blit) =>
        blit.screen.x === expectedX &&
        blit.screen.y + LAMP_SIZE.height <= plate.top,
    );
    if (above.length === 0) {
      throw new Error(
        `expected a chrome siren right-aligned above the plate at x=${expectedX}; saw ${JSON.stringify(blits)}`,
      );
    }
    return above[above.length - 1];
  }

  /**
   * ONE FRAME, ONE CONTEXT. Walks a single recording and pairs each MEDBAY
   * plate with the chrome blit that follows it, under the CTM in force at
   * each call. Returns the last pair so an earlier leftover frame cannot
   * supply the plate while a later one supplies the lamp. Callers clear
   * `calls` before the flush they measure; the pairing is what keeps that
   * property if they forget.
   */
  interface PlacedPlate {
    /** The plate's box in CSS pixels on screen. */
    readonly box: ScreenBox;
    readonly matrix: CanvasTransform;
  }

  interface SirenPair {
    /** The plate's box in CSS pixels on screen. */
    readonly plate: ScreenBox;
    readonly plateMatrix: CanvasTransform;
    readonly blit: SirenBlit;
  }

  /** Whether this call is the MEDBAY lettering that names a medbay plate. */
  function isMedbayLettering(call: RecordedCall): boolean {
    return (
      call.method === "fillText" &&
      typeof call.args[0] === "string" &&
      call.args[0].startsWith("MEDBAY")
    );
  }

  /**
   * One `drawOfficeSprite` marker read back as a siren blit, or `null` for
   * every call that is not one. Its own function so the narrowing of an
   * `unknown` point stays out of the walk below.
   */
  function sirenBlitFrom(call: RecordedCall): SirenBlit | null {
    if (call.method !== "drawOfficeSprite") return null;
    const name = sirenNameOf(call.args[0]);
    const theme = sirenThemeOf(call.args[2]);
    if (name === null || theme === null) return null;
    const at = call.args[1];
    if (typeof at !== "object" || at === null) return null;
    if (!("x" in at) || !("y" in at)) return null;
    if (typeof at.x !== "number" || typeof at.y !== "number") return null;
    return {
      name,
      x: at.x,
      y: at.y,
      theme,
      matrix: call.transform,
      screen: cssOf(screenPointOf(call)),
    };
  }

  function sirenPairOf(
    plate: PlacedPlate,
    blits: ReadonlyArray<SirenBlit>,
  ): SirenPair {
    return {
      plate: plate.box,
      plateMatrix: plate.matrix,
      blit: chromeSirenOn(blits, plate.box),
    };
  }

  /**
   * The LAST medbay plate in one recording, paired with the chrome blit that
   * follows it, each under the CTM in force at its own call.
   *
   * Pairing rather than taking the last of each independently: a plate from an
   * earlier frame and a lamp from a later one would measure two drawings
   * against each other and read as a clean result. Callers still clear `calls`
   * before the flush they measure, so in practice there is one frame here -
   * this makes that a property of the capture rather than of the caller.
   *
   * The pair is assigned in the loop body rather than by a nested helper on
   * purpose: an assignment inside a closure is invisible to the narrowing, and
   * the `null` check below would then be reported as comparing two literals -
   * a guard that is real at runtime and dead to the analyzer. Keeping the
   * write where the analyzer can see it keeps the guard honest.
   */
  function captureChromeSiren(frame: ReadonlyArray<RecordedCall>): SirenPair {
    let lastRect: PlacedPlate | null = null;
    let pendingPlate: PlacedPlate | null = null;
    let pendingBlits: SirenBlit[] = [];
    let pair: SirenPair | null = null;

    for (const call of frame) {
      if (call.method === "roundRect" || call.method === "rect") {
        lastRect = { box: cssBoxOf(call), matrix: call.transform };
      }
      if (isMedbayLettering(call)) {
        if (pendingPlate !== null) {
          pair = sirenPairOf(pendingPlate, pendingBlits);
        }
        pendingPlate = lastRect;
        pendingBlits = [];
        continue;
      }
      const blit = sirenBlitFrom(call);
      if (blit !== null) pendingBlits.push(blit);
    }
    if (pendingPlate !== null) {
      pair = sirenPairOf(pendingPlate, pendingBlits);
    }
    if (pair === null) {
      throw new Error(
        "expected a MEDBAY plate and a chrome siren in this frame",
      );
    }
    return pair;
  }

  /**
   * A box the RENDERER never drew as one call, in CSS pixels.
   *
   * Every recorded call already carries its own screen geometry, so this is
   * needed for exactly one thing: a single LENS PIXEL inside the lamp's
   * sprite, which is an offset from the blit's origin rather than anything
   * the renderer passed to the canvas. Its matrix is the blit's own.
   */
  function cssBox(matrix: CanvasTransform, box: ScreenBox): ScreenBox {
    const corners = [
      cssOf(applyCanvasTransform(matrix, box.left, box.top)),
      cssOf(applyCanvasTransform(matrix, box.left + box.width, box.top)),
      cssOf(applyCanvasTransform(matrix, box.left, box.top + box.height)),
      cssOf(
        applyCanvasTransform(
          matrix,
          box.left + box.width,
          box.top + box.height,
        ),
      ),
    ];
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return {
      left,
      top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top,
    };
  }

  /**
   * A 1×1 CSS box is fully outside `box` when its closed-open square does
   * not overlap the box at all. No slack: an antialiased fringe sitting on
   * the edge is inside.
   */
  function pixelFullyOutside(pixel: ScreenBox, box: ScreenBox): boolean {
    const right = box.left + box.width;
    const bottom = box.top + box.height;
    return (
      pixel.left + pixel.width <= box.left ||
      pixel.left >= right ||
      pixel.top + pixel.height <= box.top ||
      pixel.top >= bottom
    );
  }

  function differingLensPixels(
    theme: "light" | "dark",
  ): ReadonlyArray<{ readonly x: number; readonly y: number }> {
    const dark = rasterNamed("siren-light", theme);
    const lit = rasterNamed("siren-light-b", theme);
    const pixels: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < dark.height; y += 1) {
      for (let x = 0; x < dark.width; x += 1) {
        const a = pixelAt(dark, x, y);
        const b = pixelAt(lit, x, y);
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]) {
          continue;
        }
        pixels.push({ x, y });
      }
    }
    return pixels;
  }

  function lensClearancePx(
    captured: {
      readonly plate: ScreenBox;
      readonly blit: SirenBlit;
    },
    lens: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  ): number {
    // The plate arrives already projected - it is a recorded call's own
    // screen box - so only the lens pixels still need the matrix.
    const plateCss = captured.plate;
    const outside = lens.filter((pixel) => {
      const footprint = cssBox(captured.blit.matrix, {
        left: captured.blit.x + pixel.x,
        top: captured.blit.y + pixel.y,
        width: 1,
        height: 1,
      });
      return pixelFullyOutside(footprint, plateCss);
    });
    if (outside.length === 0) {
      throw new Error("no differing lens pixel sits fully outside the plate");
    }
    let lowestBottom = -Infinity;
    for (const pixel of outside) {
      const footprint = cssBox(captured.blit.matrix, {
        left: captured.blit.x + pixel.x,
        top: captured.blit.y + pixel.y,
        width: 1,
        height: 1,
      });
      const bottom = footprint.top + footprint.height;
      if (bottom > lowestBottom) lowestBottom = bottom;
    }
    return plateCss.top - lowestBottom;
  }

  function assertScreenChrome(
    captured: {
      readonly plateMatrix: CanvasTransform;
      readonly blit: SirenBlit;
    },
    label: string,
  ): void {
    const dpr = window.devicePixelRatio || 1;
    expect(captured.blit.matrix, `${label} same CTM`).toEqual(
      captured.plateMatrix,
    );
    expect(
      isDeviceScaleTransform(captured.plateMatrix, dpr),
      `${label} plate is screen-space`,
    ).toBe(true);
    expect(
      isDeviceScaleTransform(captured.blit.matrix, dpr),
      `${label} lamp is screen-space`,
    ).toBe(true);
  }

  function civicTaken(value: unknown): number {
    if (typeof value !== "object" || value === null) return 0;
    if (!("occupiedByRoom" in value)) return 0;
    const rooms = value.occupiedByRoom;
    if (!(rooms instanceof Map)) return 0;
    let taken = 0;
    for (const count of rooms.values()) {
      if (typeof count === "number") taken += count;
    }
    return taken;
  }

  it("keeps the blinking lens outside the plate's opaque box at office zoom and close-up", () => {
    // Plate-versus-lamp GEOMETRY in screen space, not final visible
    // pixels. The oracle does not composite the frame, so a later opaque
    // draw covering the lamp would not redden here — that is a live
    // sitting. These two beacon cases are the only ones in this file that
    // read the CTM; every other screen-position assertion is still
    // pre-transform arguments.
    //
    // Premise: Mission control plans a roadless ward, so this sign is the
    // one that carries a beacon. A Floor case cannot witness this.
    const layout = missionControlLayout();
    expect(layout.floors[0]?.road ?? null).toBeNull();
    expect(
      layout.floors[0]?.civic.some((room) => room.kind === "infirmary"),
    ).toBe(true);

    const clearances: number[] = [];
    for (const zoom of [OFFICE_LOD_OFFICE_ZOOM, OFFICE_LOD_CLOSEUP_ZOOM]) {
      const motion = installReducedMotion(true);
      seedFailure(HALL_LEAD.id, HALL_LEAD.hostId);
      const blitSpy = recordDrawOfficeSprite();
      const tally = vi.spyOn(OfficeScene.prototype, "civicTally");
      renderMissionControl(zoom);
      let taken = 0;
      for (let step = 0; step < 40; step += 1) {
        flushRaf(1);
        for (const result of tally.mock.results) {
          const n = civicTaken(result.value);
          if (n > taken) taken = n;
        }
        if (taken > 0) break;
      }
      expect(taken).toBeGreaterThan(0);
      motion.setMatches(false);
      flushRaf(2);

      calls.length = 0;
      flushRaf(1);
      const darkFrame = captureChromeSiren(calls);
      const lens = differingLensPixels(darkFrame.blit.theme);
      expect(lens.length).toBeGreaterThan(0);

      calls.length = 0;
      flushRaf(FLUSHES_PER_SIREN_PERIOD);
      const litFrame = captureChromeSiren(calls);

      expect(darkFrame.blit.name).not.toBe(litFrame.blit.name);
      assertScreenChrome(darkFrame, `zoom ${zoom} dark`);
      assertScreenChrome(litFrame, `zoom ${zoom} lit`);

      const darkClearance = lensClearancePx(darkFrame, lens);
      const litClearance = lensClearancePx(
        litFrame,
        differingLensPixels(litFrame.blit.theme),
      );
      expect(darkClearance, `zoom ${zoom} dark`).toBe(LENS_CLEARANCE_PX);
      expect(litClearance, `zoom ${zoom} lit`).toBe(LENS_CLEARANCE_PX);
      clearances.push(darkClearance);

      cleanup();
      useAppLocalNotificationsStore.setState({ byId: {} });
      blitSpy.mockRestore();
    }
    // Zoom-invariant: both the lamp and the box are screen-space, so the
    // clearance at 0.7 and at 1.6 is the same number, not two nearby ones.
    expect(clearances[0]).toBe(clearances[1]);
  });

  it("maps the resolver's frame number onto the lens pixels of Mission control's roadless ward", () => {
    // Geometry and the captured theme argument, not a composited frame.
    const layout = missionControlLayout();
    expect(layout.floors[0]?.road ?? null).toBeNull();

    const darkMap = mapNamed("siren-light").join("");
    const litMap = mapNamed("siren-light-b").join("");
    // K2's art pin, restated here so a swap of the maps cannot pass by
    // also swapping the canvas's sprite table: frame 0 has no amber, frame
    // 1 does.
    expect(darkMap).not.toContain("y");
    expect(darkMap).not.toContain("n");
    expect(litMap).toContain("y");

    for (const theme of ["light", "dark"] as const) {
      resolvedThemeMock.current = theme;

      const blitSpy = recordDrawOfficeSprite();
      renderMissionControl(OFFICE_LOD_OFFICE_ZOOM);
      calls.length = 0;
      flushRaf(4);
      const emptyResolved = resolveWardFrame({
        layout,
        occupied: 0,
        nowMs: 0,
        reducedMotion: false,
        zoom: OFFICE_LOD_OFFICE_ZOOM,
      });
      expect(emptyResolved, `${theme} empty`).toBe(0);
      const empty = captureChromeSiren(calls);
      // The chrome assertion belongs in BOTH states of BOTH themes, not only
      // in the clearance case's light pass. The clearance case pins the CTM
      // under light alone, so a scale applied to the lamp in the dark branch
      // only - or in the unoccupied branch only - would paint a wrong-sized
      // beacon that every other assertion here still accepts, because the
      // sprite name, the theme argument and the lens pixels are all
      // unchanged by a transform.
      assertScreenChrome(empty, `${theme} empty`);
      expect(empty.blit.theme, `${theme} empty arg`).toBe(theme);
      const emptyDrawn = rasterNamed(empty.blit.name, empty.blit.theme);
      const emptyExpected = rasterNamed("siren-light", theme);
      expect([...emptyDrawn.pixels], `${theme} empty pixels`).toEqual([
        ...emptyExpected.pixels,
      ]);
      expect(mapNamed(empty.blit.name).join("")).not.toContain("y");

      cleanup();
      blitSpy.mockRestore();

      const motion = installReducedMotion(true);
      seedFailure(HALL_LEAD.id, HALL_LEAD.hostId);
      const occupiedSpy = recordDrawOfficeSprite();
      renderMissionControl(OFFICE_LOD_OFFICE_ZOOM);
      calls.length = 0;
      flushRaf(4);
      const occupiedResolved = resolveWardFrame({
        layout,
        occupied: 1,
        nowMs: 0,
        reducedMotion: true,
        zoom: OFFICE_LOD_OFFICE_ZOOM,
      });
      expect(occupiedResolved, `${theme} occupied`).toBe(1);
      const occupied = captureChromeSiren(calls);
      assertScreenChrome(occupied, `${theme} occupied`);
      expect(occupied.blit.theme, `${theme} occupied arg`).toBe(theme);
      const occupiedDrawn = rasterNamed(
        occupied.blit.name,
        occupied.blit.theme,
      );
      const occupiedExpected = rasterNamed("siren-light-b", theme);
      expect([...occupiedDrawn.pixels], `${theme} occupied pixels`).toEqual([
        ...occupiedExpected.pixels,
      ]);
      expect(mapNamed(occupied.blit.name).join("")).toContain("y");

      cleanup();
      occupiedSpy.mockRestore();
      motion.setMatches(false);
      useAppLocalNotificationsStore.setState({ byId: {} });
    }
  });
});
