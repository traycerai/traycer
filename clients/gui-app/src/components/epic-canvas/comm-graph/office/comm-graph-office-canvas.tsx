/**
 * The OFFICE rendering of the communication graph: a pixel-art floor on a
 * single `<canvas>`, where every agent is a character at a desk and every A2A
 * message is an envelope flying desk to desk.
 *
 * SAME PROJECTION AS THE NODE GRAPH. This component takes the identical props:
 * the epic's full agent set, the agents that exist as of the cursor, the merged
 * as-of event array, and what the cursor row pulses. Nothing here reads a clock
 * to decide WHAT to show - only how far along an animation of it has got. So a
 * replayed floor and a live one cannot disagree, and neither can the two modes.
 *
 * THREE COORDINATE SPACES, kept apart on purpose:
 *
 * - SPRITE space - integer pixels at 1x, what the scene and the sprites speak.
 * - SCREEN space - CSS pixels inside this component's box. The camera maps
 *   sprite to screen (`screen = sprite * zoom + offset`), and labels are drawn
 *   here so text stays crisp instead of being magnified into mush.
 * - DEVICE space - screen times `devicePixelRatio`, the canvas bitmap.
 *
 * The camera lives in a ref, not in React state: it is read by the animation
 * frame and written by pointer handlers, so routing it through a render would
 * re-render the tree at 60Hz to move numbers nothing else reads.
 */
import {
  useCallback,
  useEffectEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Maximize, Minus, PanelLeft, Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { useThemeRevision } from "@/providers/use-theme-revision";
import {
  useEpicAgentActivityTiers,
  useEpicAgentRoleClaimsByAgentId,
} from "@/lib/epic-selectors";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { attentionTone } from "@/components/notifications/notification-indicator-tones";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import {
  useCommGraphCursor,
  useCommGraphSpeed,
} from "@/stores/epics/comm-graph-timeline-store";
import {
  useCommGraphDirectoryOpen,
  useCommGraphPanelStore,
} from "@/stores/epics/comm-graph-panel-store";
import type { CommGraphCanvasProps } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import {
  aggregateCommGraphEdges,
  type CommGraphAgentNode,
} from "@/lib/comm-graph/comm-graph-model";
import { useCommGraphOpenAgentById } from "@/components/epic-canvas/comm-graph/use-comm-graph-open-agent-by-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import { isDefaultCommGraphView } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { CommGraphAgentDetailSurface } from "@/components/epic-canvas/comm-graph/comm-graph-agent-detail-surface";
import { CommGraphThreadPanel } from "@/components/epic-canvas/comm-graph/comm-graph-thread-panel";
import { OFFICE_ENVELOPE_TINTS } from "@/components/epic-canvas/comm-graph/office/office-envelope-tints";
import { officePipColor } from "@/components/epic-canvas/comm-graph/office/office-pip-color";
import { OfficeAgentHover } from "@/components/epic-canvas/comm-graph/office/office-agent-hover";
import {
  followOfficeHover,
  hitRegionFor,
  type OfficeHoverAnchor,
} from "@/components/epic-canvas/comm-graph/office/office-hover-follow";
import { OfficeHoverSupplement } from "@/components/epic-canvas/comm-graph/office/office-hover-supplement";
import { OfficeLegend } from "@/components/epic-canvas/comm-graph/office/office-legend";
import { OfficeLodChip } from "@/components/epic-canvas/comm-graph/office/office-lod-chip";
import { OfficeDirectoryPanel } from "@/components/epic-canvas/comm-graph/office/office-directory-panel";
import {
  createOfficeStaticSurface,
  officeBakesIntoStaticFloor,
  OFFICE_STATIC_CHUNK_BUDGET,
  OfficeStaticLayer,
  planOfficeStaticChunks,
  type OfficeStaticChunkDraw,
} from "@/components/epic-canvas/comm-graph/office/office-static-layer";
import { officeBenchStatuses } from "@/components/epic-canvas/comm-graph/office/office-bench";
import {
  officeTileRectOf,
  OFFICE_PROJECTION_BLEED_PX,
} from "@/lib/comm-graph/office/office-projection";
import {
  isElementVisible,
  officeCatchUpMs,
  OfficeFrameGate,
} from "@/components/epic-canvas/comm-graph/office/office-frame-gate";
import {
  officeHarnessLogo,
  onOfficeLogoReady,
} from "@/components/epic-canvas/comm-graph/office/office-logo-cache";
import { createCommGraphFindAdapter } from "@/components/epic-canvas/comm-graph/comm-graph-find-adapter";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { BASE_STEP_MS } from "@/components/epic-canvas/comm-graph/use-comm-graph-transport";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import {
  drawOfficeSprite,
  officePalette,
  officeSpriteSize,
  type OfficePalette,
} from "@/lib/comm-graph/office/office-pixel-art";
import {
  ENVELOPE_ARC_LIFT,
  OfficeScene,
} from "@/lib/comm-graph/office/office-scene";
import {
  officeLodForZoom,
  OFFICE_LOD_COUNT,
} from "@/lib/comm-graph/office/office-lod";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import type {
  OfficeProjector,
  OfficeView,
} from "@/lib/comm-graph/office/views/office-view";
import type { OfficeAutoProbe } from "@/lib/comm-graph/office/office-auto";
import { useOfficeEligibility } from "@/components/epic-canvas/comm-graph/office/use-office-eligibility";
import {
  officeAgentStatuses,
  officeOpenRequestCounts,
} from "@/lib/comm-graph/office/office-status";
import { officeModelTier } from "@/lib/comm-graph/office/office-model-tier";
import { officeClockAngles } from "@/lib/comm-graph/office/office-clock";
import { officeFlagKind } from "@/components/epic-canvas/comm-graph/office/office-flag-kind";
import {
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_MONOSPACE_STACK,
  OFFICE_SIGN_PADDING_X,
  officeFloorSignsToDraw,
  officeSignCenterX,
  officeSignsToDraw,
  type OfficePlateMeasure,
  type OfficeFloorSignToDraw,
  type OfficeSignToDraw,
} from "@/lib/comm-graph/office/office-signs";
import {
  layoutNameTags,
  NAME_TAG_LINE_HEIGHT,
  type OfficeNameTagCandidate,
} from "@/components/epic-canvas/comm-graph/office/office-name-tags";
import {
  OFFICE_LOGO_SIZE,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeBlockFill,
  type OfficeDrawable,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeEnvelopeHitRegion,
  type OfficeHitRegion,
  type OfficeLayout,
  type OfficeLod,
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSign,
  type OfficeSpriteName,
  type OfficeSize,
  type OfficeTheme,
} from "@/lib/comm-graph/office/office-types";

/**
 * Screen pixels per sprite pixel. The floor is drawn at integer-ish scales so
 * the pixel art stays square; the bounds are what keeps a one-agent room from
 * filling the tile with a single desk and a fifty-agent floor from vanishing.
 */
/**
 * Far below one sprite pixel per screen pixel, because a thousand-agent City
 * is tens of thousands of sprite pixels across and the overview band exists to
 * show all of it at once. The floor at this zoom is a block map, not art.
 */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
/** As far in as a fit is ever allowed to go: past this a fitted floor is a desk. */
const MAX_FIT_ZOOM = 6;
/** Screen-pixel margin left around the floor when fitting. */
const FIT_PADDING = 24;
const ZOOM_BUTTON_FACTOR = 1.25;
/** Screen pixels an arrow key moves the floor. */
const KEY_PAN_PX = 48;
const AUTO_PAN_MS = 250;
/** Pointer travel that turns a click into a drag. */
const CLICK_SLOP_PX = 4;
/** Coalesces a pan/zoom gesture into one persisted view write. */
const VIEW_PERSIST_DEBOUNCE_MS = 150;
const LABEL_FONT_PX = 10;
const HOVER_LABEL_FONT_PX = 11;
/** The name-tag font, prebuilt: the width cache keys on text alone only
 * because this never varies. */
const LABEL_FONT = `${LABEL_FONT_PX}px ${OFFICE_SIGN_MONOSPACE_STACK}`;
const SIGN_PADDING_Y = 2;
const SIGN_PLATE_RADIUS = 3;
const CLOCK_HOUR_HAND = 3;
const CLOCK_MINUTE_HAND = 4;
const CLOCK_HUB_RADIUS = 1.5;
const DARK_LABEL_BACKING = "rgba(0, 0, 0, 0.85)";
const LIGHT_LABEL_BACKING = "rgba(255, 255, 255, 0.85)";
/** A cabin's sign is two tiles wide, so its name gets less room than a desk's. */
const MAX_ROOM_LABEL_CHARS = 12;
/** A pod's plate is ONE tile, so its name gets less room again. */
const MAX_POD_LABEL_CHARS = 10;
/** Baseline of a sign's name, measured down from the sign sprite's own top. */
const SIGN_LABEL_BASELINE = 11;
const SIGN_WIDTH_TILES = 2;
/** An overview pip, and the two marks that ride over it. */
const PIP_RADIUS = 3;
const PIP_RING_GAP = 2;
const PIP_BANG_HEIGHT = 4;

interface OfficeCamera {
  x: number;
  y: number;
  zoom: number;
}

interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

/** The label tones the scene emits, named once for the colour lookup. */
type OfficeLabelTone = Extract<OfficeDrawable, { kind: "label" }>["tone"];

/** Which detail surface the floor has open, if any. */
type OfficeSelectedDetail =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "pair"; readonly edgeId: string };

/**
 * The hovered character and where its card should sit, in container-relative
 * screen pixels. Set on pointer move, and moved by the frame loop only while
 * the character under the pointer is itself moving.
 */
/**
 * The open hover card's subject and geometry.
 *
 * `whereabouts` is resolved WHEN THE CARD IS PLACED, never while rendering it:
 * the scene is a ref the frame loop owns, and a render that reached into it
 * would be reading state React does not know changed. Every path that places
 * this card has the scene in hand already.
 */
interface OfficeHoverTarget {
  readonly agentId: string;
  /** The character's box in container screen pixels; the trigger's geometry. */
  readonly rect: OfficeRect;
  /** Where this agent is, in its floor plan's words; `null` before a layout. */
  readonly whereabouts: string | null;
}

/**
 * The open card's whole subject, from one hit test: who, the box in screen
 * pixels, and where they are. Assembled here rather than in the pointer
 * handler so that handler stays a router - and so the scene is read on the
 * path that HAS one, never during a render.
 */
function hoverTargetFor(args: {
  readonly region: OfficeHitRegion | null;
  readonly camera: OfficeCamera;
  readonly scene: OfficeScene | null;
}): OfficeHoverTarget | null {
  const { camera, region, scene } = args;
  if (region === null) return null;
  return {
    agentId: region.agentId,
    rect: {
      x: region.rect.x * camera.zoom + camera.x,
      y: region.rect.y * camera.zoom + camera.y,
      width: region.rect.width * camera.zoom,
      height: region.rect.height * camera.zoom,
    },
    whereabouts: scene === null ? null : scene.whereabouts(region.agentId),
  };
}

function sameRect(a: OfficeRect, b: OfficeRect | null): boolean {
  return (
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

/** An in-flight camera move, in screen space. */
interface CameraPan {
  readonly fromX: number;
  readonly fromY: number;
  readonly fromZoom: number;
  readonly toX: number;
  readonly toY: number;
  readonly toZoom: number;
  readonly startedAt: number;
}

/**
 * Where the camera should end up, without saying when. Requested by handlers
 * and by the find adapter; turned into a {@link CameraPan} by the frame loop,
 * which is the only place that has a frame clock to start one against.
 */
interface PanRequest {
  readonly focus: OfficePoint;
  /** `null` keeps the current zoom - a move, not a reframe. */
  readonly zoom: number | null;
}

/**
 * The camera move that puts a request's focus (sprite space) at the centre of
 * the viewport, expressed as an animation from where the camera is now.
 */
function panToward(args: {
  readonly camera: OfficeCamera;
  readonly viewport: ScreenSize;
  readonly request: PanRequest;
  readonly startedAt: number;
}): CameraPan {
  const { camera, request, startedAt, viewport } = args;
  const zoom = request.zoom ?? camera.zoom;
  return {
    fromX: camera.x,
    fromY: camera.y,
    fromZoom: camera.zoom,
    toX: viewport.width / 2 - request.focus.x * zoom,
    toY: viewport.height / 2 - request.focus.y * zoom,
    toZoom: zoom,
    startedAt,
  };
}

/**
 * The canvas's imperative state: everything the animation frame, the pointer
 * handlers and the Find adapter all touch, in one mutable object created once.
 *
 * Deliberately NOT a pile of refs. A ref may not be read or written during
 * render, and the Find adapter is built in a memo - so handing it refs would
 * be exactly the render-phase access that rule forbids. A plain object held in
 * state has the same lifetime and none of that hazard; the fields below are
 * written only from effects and handlers.
 */
interface OfficeRuntime {
  readonly getCamera: () => OfficeCamera;
  readonly getViewport: () => ScreenSize;
  readonly setViewport: (next: ScreenSize) => void;
  /** Rebuilt every frame from the scene, so hit-testing follows the drawing. */
  readonly getHitRegions: () => ReadonlyArray<OfficeHitRegion>;
  readonly setHitRegions: (next: ReadonlyArray<OfficeHitRegion>) => void;
  /**
   * The envelopes drawn on the last frame.
   *
   * A pointer move is answered from these rather than by asking the scene,
   * which would rebuild the whole overlay to find out - once per pointermove,
   * which is once per mouse event. What the person is pointing at is what they
   * can SEE, so the frame they are looking at is the right thing to ask.
   */
  readonly getEnvelopeRegions: () => ReadonlyArray<OfficeEnvelopeHitRegion>;
  readonly setEnvelopeRegions: (
    next: ReadonlyArray<OfficeEnvelopeHitRegion>,
  ) => void;
  /**
   * Whether a frame has ever been drawn.
   *
   * Distinguishes "the last frame had no envelopes" - the common case, and the
   * one the cache exists to answer without work - from "there has been no
   * frame", where the cached list is empty because nothing has filled it. An
   * empty list alone cannot tell those apart, and treating the second as the
   * first would drop a click on a floor that has not painted yet.
   */
  readonly hasDrawnFrame: () => boolean;
  /**
   * Asks the frame loop to paint the next frame unconditionally.
   *
   * Routed through the runtime because the gate lives inside the loop's effect
   * and the sizing callback does not - and the sizing callback is precisely
   * what erases the pixels the skip is counting on.
   */
  readonly invalidateFrame: () => void;
  readonly onInvalidateFrame: (listener: () => void) => void;
  readonly getSearchMatchIds: () => ReadonlySet<string>;
  readonly setSearchMatchIds: (next: ReadonlySet<string>) => void;
  readonly takePanRequest: () => PanRequest | null;
  /** Peeks without consuming - `takePanRequest` clears what it returns. */
  readonly hasPanRequest: () => boolean;
  readonly requestPan: (next: PanRequest | null) => void;
  /** Agents on the floor as of the cursor - what Find searches. */
  readonly getAgents: () => ReadonlyArray<CommGraphAgentNode>;
  readonly setAgents: (next: ReadonlyArray<CommGraphAgentNode>) => void;
  readonly getPulseKey: () => string | null;
  readonly isPlaying: () => boolean;
  readonly setPlayback: (pulseKey: string | null, playing: boolean) => void;
  readonly getActivePan: () => CameraPan | null;
  readonly setActivePan: (next: CameraPan | null) => void;
  readonly isAutoPanEnabled: () => boolean;
  readonly enableAutoPan: () => void;
  readonly isAutoFitEnabled: () => boolean;
  /**
   * A person took the camera: stop following the action until the next Play,
   * stop re-fitting for good, and abandon any move in flight rather than
   * fighting it. A find gesture counts - it is the user aiming the camera.
   */
  readonly takeManualControl: () => void;
  /**
   * The last input the scene was synced with, so the frame loop can re-sync a
   * fresh wall clock without React. `null` until the first sync.
   *
   * Kept even while the office is INELIGIBLE, where it is the held input that
   * `resume` is handed on the way back.
   */
  readonly getSceneInput: () => OfficeSceneInput | null;
  readonly setSceneInput: (next: OfficeSceneInput) => void;
  /**
   * The partition the last input carried, which is the `previous` the next one
   * folds in. Held here rather than in a ref so the memo that computes it can
   * read it at all - see the note on this interface.
   */
  readonly getPartition: () => OfficePopulation | null;
  readonly setPartition: (next: OfficePopulation) => void;
  /**
   * Whether this office is allowed to do anything - see
   * {@link useOfficeEligibility}. Mirrored here because the frame loop starts
   * and stops on it and the loop is created once, outside React's data flow.
   */
  readonly isEligible: () => boolean;
  readonly setEligible: (next: boolean) => void;
  readonly onEligibilityChange: (listener: (eligible: boolean) => void) => void;
  /**
   * Whether the SCENE is suspended. Distinct from eligibility: an office that
   * was never eligible has no scene to suspend, and coming back has to know
   * whether to `resume` (once, with missed rows suppressed) or plain `sync`.
   */
  readonly isSuspended: () => boolean;
  readonly setSuspended: (next: boolean) => void;
  readonly getHoveredAgentId: () => string | null;
  readonly setHoveredAgentId: (next: string | null) => void;
  /**
   * Whose detail panel is open. Mirrored here for the same reason the hovered
   * id is: the frame loop is built once and reads its inputs through the
   * runtime, and a selection change has to repaint without rebuilding it.
   */
  readonly getSelectedAgentId: () => string | null;
  readonly setSelectedAgentId: (next: string | null) => void;
  readonly getHostNames: () => ReadonlyMap<string, string>;
  readonly setHostNames: (next: ReadonlyMap<string, string>) => void;
  /**
   * Agent display names for the name tags. Mirrored here rather than closed
   * over by the frame loop: a rename is the ONE agent change the scene does
   * not treat as a new floor, and tearing the loop down for it would repaint
   * the whole static layer to change one label.
   */
  readonly getNameById: () => ReadonlyMap<string, string>;
  readonly setNameById: (next: ReadonlyMap<string, string>) => void;
  /**
   * Every agent's role claims, in ONE map read from one store subscription.
   *
   * Mirrored here for the same reason as `nameById`: the plates draw the
   * owner's claim as their second line, a claim lands asynchronously and moves
   * nothing on the floor, and a hook per sign would be one subscription per
   * room re-running on every unrelated claim in the epic.
   */
  readonly getRoleClaims: () => Readonly<Record<string, readonly RoleClaim[]>>;
  readonly setRoleClaims: (
    next: Readonly<Record<string, readonly RoleClaim[]>>,
  ) => void;
}

function createOfficeRuntime(view: CommGraphTileViewState): OfficeRuntime {
  const camera: OfficeCamera = {
    x: view.x,
    y: view.y,
    zoom: clampZoom(view.zoom),
  };
  let viewport: ScreenSize = { width: 0, height: 0 };
  let hitRegions: ReadonlyArray<OfficeHitRegion> = [];
  let envelopeRegions: ReadonlyArray<OfficeEnvelopeHitRegion> = [];
  let drawnFrame = false;
  // Replaced by the frame loop on mount; a no-op before it and after unmount,
  // when there is no frame to ask for.
  let invalidateListener: () => void = () => undefined;
  let searchMatchIds: ReadonlySet<string> = EMPTY_MATCH_IDS;
  let pendingPan: PanRequest | null = null;
  let agents: ReadonlyArray<CommGraphAgentNode> = [];
  let pulseKey: string | null = null;
  let playing = false;
  let activePan: CameraPan | null = null;
  let autoPanEnabled = true;
  let autoFitEnabled = isDefaultCommGraphView(view);
  let sceneInput: OfficeSceneInput | null = null;
  let partition: OfficePopulation | null = null;
  let eligible = false;
  let suspended = false;
  // Replaced by the frame loop on mount, like the invalidate listener above.
  let eligibilityListener: (next: boolean) => void = () => undefined;
  let hostNames: ReadonlyMap<string, string> = new Map();
  let nameById: ReadonlyMap<string, string> = new Map();
  let roleClaims: Readonly<Record<string, readonly RoleClaim[]>> = {};
  let hoveredAgentId: string | null = null;
  let selectedAgentId: string | null = null;
  return {
    getCamera: () => camera,
    getViewport: () => viewport,
    setViewport: (next) => {
      viewport = next;
    },
    getHitRegions: () => hitRegions,
    setHitRegions: (next) => {
      hitRegions = next;
    },
    invalidateFrame: () => {
      invalidateListener();
    },
    onInvalidateFrame: (listener) => {
      invalidateListener = listener;
    },
    getEnvelopeRegions: () => envelopeRegions,
    setEnvelopeRegions: (next) => {
      envelopeRegions = next;
      drawnFrame = true;
    },
    hasDrawnFrame: () => drawnFrame,
    getSearchMatchIds: () => searchMatchIds,
    // The match outlines and the hovered name tag are painted by the frame,
    // and on a still floor the idle skip refuses every frame - so a change to
    // either has to ask for one, or Find would report no matches over a floor
    // still wearing the last query's outlines. Only a CHANGE asks: a pointer
    // resting on one agent reports it on every move.
    setSearchMatchIds: (next) => {
      if (next === searchMatchIds) return;
      searchMatchIds = next;
      invalidateListener();
    },
    takePanRequest: () => {
      const taken = pendingPan;
      pendingPan = null;
      return taken;
    },
    hasPanRequest: () => pendingPan !== null,
    requestPan: (next) => {
      pendingPan = next;
    },
    getAgents: () => agents,
    setAgents: (next) => {
      agents = next;
    },
    getPulseKey: () => pulseKey,
    isPlaying: () => playing,
    setPlayback: (nextPulseKey, nextPlaying) => {
      pulseKey = nextPulseKey;
      playing = nextPlaying;
    },
    getActivePan: () => activePan,
    setActivePan: (next) => {
      activePan = next;
    },
    isAutoPanEnabled: () => autoPanEnabled,
    enableAutoPan: () => {
      autoPanEnabled = true;
    },
    isAutoFitEnabled: () => autoFitEnabled,
    getSceneInput: () => sceneInput,
    setSceneInput: (next) => {
      sceneInput = next;
    },
    getPartition: () => partition,
    setPartition: (next) => {
      partition = next;
    },
    isEligible: () => eligible,
    // Only a CHANGE reaches the loop: the effect that writes this runs on
    // every render of the composed signal, and a tile that stays on screen
    // would otherwise restart the loop on each one.
    setEligible: (next) => {
      if (next === eligible) return;
      eligible = next;
      eligibilityListener(next);
    },
    onEligibilityChange: (listener) => {
      eligibilityListener = listener;
    },
    isSuspended: () => suspended,
    setSuspended: (next) => {
      suspended = next;
    },
    getHoveredAgentId: () => hoveredAgentId,
    setHoveredAgentId: (next) => {
      if (next === hoveredAgentId) return;
      hoveredAgentId = next;
      invalidateListener();
    },
    getSelectedAgentId: () => selectedAgentId,
    setSelectedAgentId: (next) => {
      if (next === selectedAgentId) return;
      selectedAgentId = next;
      invalidateListener();
    },
    getHostNames: () => hostNames,
    setHostNames: (next) => {
      hostNames = next;
    },
    getNameById: () => nameById,
    setNameById: (next) => {
      nameById = next;
    },
    getRoleClaims: () => roleClaims,
    setRoleClaims: (next) => {
      roleClaims = next;
    },
    takeManualControl: () => {
      autoPanEnabled = false;
      autoFitEnabled = false;
      activePan = null;
      pendingPan = null;
    },
  };
}

/** Centre of a sprite-space box - what a pan request focuses on. */
function rectCenter(rect: OfficeRect): OfficePoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

interface DragState {
  readonly pointerId: number;
  readonly originX: number;
  readonly originY: number;
  readonly cameraX: number;
  readonly cameraY: number;
  moved: boolean;
}

function get2dContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  // jsdom throws "Not implemented" rather than returning null, so this
  // capability probe is the one boundary where catching is the cleanest option.
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Ease-in-out, so an auto-pan starts and lands gently instead of snapping. */
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * The EXACT zoom at which the whole floor fits with padding, centered.
 *
 * It used to be the largest of a few whole-ish steps, which kept pixels square
 * and made a floor bigger than the tile at 1x overflow rather than fit - the
 * step list had no answer below 1. Every view but the Floor is routinely
 * larger than the tile, and "fit" has to mean it; the clamp at both ends is
 * what keeps a one-desk office from filling the tile with a chair.
 */
function fitCamera(floor: OfficeSize, viewport: ScreenSize): OfficeCamera {
  const availableWidth = Math.max(1, viewport.width - FIT_PADDING * 2);
  const availableHeight = Math.max(1, viewport.height - FIT_PADDING * 2);
  const zoom = clampZoom(
    Math.min(
      MAX_FIT_ZOOM,
      Math.min(availableWidth / floor.width, availableHeight / floor.height),
    ),
  );
  return {
    zoom,
    x: (viewport.width - floor.width * zoom) / 2,
    y: (viewport.height - floor.height * zoom) / 2,
  };
}

function isOnScreen(
  point: OfficePoint,
  camera: OfficeCamera,
  viewport: ScreenSize,
): boolean {
  const screenX = point.x * camera.zoom + camera.x;
  const screenY = point.y * camera.zoom + camera.y;
  return (
    screenX >= 0 &&
    screenX <= viewport.width &&
    screenY >= 0 &&
    screenY <= viewport.height
  );
}

const EMPTY_MATCH_IDS: ReadonlySet<string> = new Set();

/** A frozen empty list, so a claimless agent does not re-render the card. */
const NO_ROLE_CLAIMS: readonly RoleClaim[] = Object.freeze([]);

function claimsOf(
  roleClaims: Readonly<Record<string, readonly RoleClaim[]>>,
  agentId: string,
): readonly RoleClaim[] {
  if (!Object.hasOwn(roleClaims, agentId)) return NO_ROLE_CLAIMS;
  return roleClaims[agentId];
}

/** The unmeasured tile; see the placeholder note on `sceneInput`. */
const EMPTY_VIEWPORT: OfficeSize = { width: 0, height: 0 };

/** A fresh office's seat book: nobody seated, nobody waiting for a seat. */
const NO_OCCUPANCY: ReadonlyMap<string, string> = new Map();
const NO_CAPACITY_NEEDED: ReadonlyArray<string> = [];

/** Stand-ins for a floor with no layout yet. Frozen, so no frame allocates one. */
const NO_SIGNS: ReadonlyArray<OfficeSign> = [];
const NO_FLOORS: ReadonlyArray<OfficeFloor> = [];
const NO_STATUSES: ReadonlyMap<string, OfficeAgentStatus> = new Map();

/**
 * What the camera can SEE, in world pixels. The frame is built for this and
 * nothing outside it plus the scene's own cull margin, which is what makes a
 * frame cost what the viewport holds rather than what the epic holds.
 */
function worldRectOf(camera: OfficeCamera, viewport: ScreenSize): OfficeRect {
  return {
    x: -camera.x / camera.zoom,
    y: -camera.y / camera.zoom,
    width: viewport.width / camera.zoom,
    height: viewport.height / camera.zoom,
  };
}

/** No floor bitmaps this frame: the floor is drawn. Frozen; see `NO_SIGNS`. */
const NO_STATIC_CHUNKS: ReadonlyArray<OfficeStaticChunkDraw> = [];

/**
 * The static layer's version, with the BAND folded in. Two zoom bands of one
 * layout share a `staticVersion` and are not the same floor: the painter is
 * asked for each separately, and a bitmap keyed on the layout alone would
 * serve whichever was baked first.
 */
function staticKeyOf(staticVersion: number, lod: OfficeLod): number {
  return staticVersion * OFFICE_LOD_COUNT + lod;
}

/**
 * Everything the draw needs that is NOT in the frame: the plan's lettering and
 * storeys, and what the last synced input says exists right now.
 *
 * Gathered in one place because each of the four has an answer for "there is
 * no layout yet" or "nothing has been synced yet", and four separate fallbacks
 * inline in the frame loop is four chances to write the wrong empty value.
 */
interface FrameChrome {
  readonly signs: ReadonlyArray<OfficeSign>;
  readonly floors: ReadonlyArray<OfficeFloor>;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
}

function frameChrome(
  layout: OfficeLayout | null,
  synced: OfficeSceneInput | null,
): FrameChrome {
  return {
    signs: layout === null ? NO_SIGNS : layout.signs,
    floors: layout === null ? NO_FLOORS : layout.floors,
    // Off the SYNCED input, not off props: the loop is created once and never
    // re-created for a cursor step, and the signs have to say what the floor
    // under them is showing.
    visibleAgentIds: synced === null ? EMPTY_MATCH_IDS : synced.visibleAgentIds,
    statusById: synced === null ? NO_STATUSES : synced.statusById,
  };
}

/** A requested pan names a WORLD point, so a world that moved moves it too. */
function shiftPendingPan(runtime: OfficeRuntime, shift: OfficePoint): void {
  const pending = runtime.takePanRequest();
  if (pending === null) return;
  runtime.requestPan({
    ...pending,
    focus: { x: pending.focus.x + shift.x, y: pending.focus.y + shift.y },
  });
}

/**
 * A pan ALREADY RUNNING holds camera offsets, not world points, so it moves by
 * the shift in screen pixels - and it has to move, because the next frame
 * writes `camera.x` straight from these and would otherwise throw away the
 * compensation applied beside them.
 */
function shiftActivePan(
  runtime: OfficeRuntime,
  shift: OfficePoint,
  zoom: number,
): void {
  const pan = runtime.getActivePan();
  if (pan === null) return;
  runtime.setActivePan({
    ...pan,
    fromX: pan.fromX - shift.x * zoom,
    toX: pan.toX - shift.x * zoom,
    fromY: pan.fromY - shift.y * zoom,
    toY: pan.toY - shift.y * zoom,
  });
}

/**
 * The sprite-space box covering every named agent's hit region, or `null` when
 * none of them is on the floor.
 */
function spriteBoundsFor(
  regions: ReadonlyArray<OfficeHitRegion>,
  agentIds: ReadonlySet<string>,
): OfficeRect | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const region of regions) {
    if (!agentIds.has(region.agentId)) continue;
    left = Math.min(left, region.rect.x);
    top = Math.min(top, region.rect.y);
    right = Math.max(right, region.rect.x + region.rect.width);
    bottom = Math.max(bottom, region.rect.y + region.rect.height);
  }
  if (left === Number.POSITIVE_INFINITY) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Screen-space text with a one-pixel backing behind it.
 *
 * The floor's own colors are arbitrary (a character's shirt may land on the
 * foreground color), so a name is outlined rather than trusted to contrast
 * with whatever it happens to sit on. The backing's colour is the CALLER's,
 * because it has to contrast with the text rather than with the floor.
 */
const LABEL_BACKING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function drawScreenLabel(
  ctx: CanvasRenderingContext2D,
  label: {
    readonly text: string;
    readonly screenX: number;
    readonly screenY: number;
    readonly fontPx: number;
    readonly color: string;
    /** Sits behind the glyphs; must contrast with `color`, not with the floor. */
    readonly backing: string;
    readonly alpha: number;
  },
): void {
  const { alpha, backing, color, fontPx, screenX, screenY, text } = label;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${fontPx}px ${OFFICE_SIGN_MONOSPACE_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = backing;
  for (const [dx, dy] of LABEL_BACKING_OFFSETS) {
    ctx.fillText(text, screenX + dx, screenY + dy);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, screenX, screenY);
  ctx.restore();
}

interface DrawFrameArgs {
  readonly ctx: CanvasRenderingContext2D;
  readonly frame: OfficeFrame;
  readonly camera: OfficeCamera;
  /** The zoom band the frame was built for; the signage follows it. */
  readonly lod: OfficeLod;
  readonly viewport: ScreenSize;
  readonly dpr: number;
  readonly theme: OfficeTheme;
  /** Agents the tile's Find session currently matches; empty when idle. */
  readonly searchMatchIds: ReadonlySet<string>;
  /**
   * The PLAN's lettering, drawn here because a sign names an agent and whether
   * that agent exists yet is a fact about the time cursor. Empty before the
   * first layout.
   */
  readonly signs: ReadonlyArray<OfficeSign>;
  /** Who exists at the cursor; a sign whose owner does not is not drawn. */
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly nameById: ReadonlyMap<string, string>;
  /** Every agent's claims, as one bulk map; a plate draws its owner's first. */
  readonly roleClaims: Readonly<Record<string, readonly RoleClaim[]>>;
  /** One per host. A single-floor building names nothing - there is no choice to explain. */
  readonly floors: ReadonlyArray<OfficeFloor>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly hoveredAgentId: string | null;
  /** Whose detail panel is open; named at lod 1 even when unhovered. */
  readonly selectedAgentId: string | null;
  /**
   * The view's projection, or `null` before the first layout. Every sign anchor
   * goes through it: a tile is only a screen position once a view has said so.
   */
  readonly projector: OfficeProjector | null;
  /**
   * The floor, already painted in sprite space, one chunk per bitmap. EMPTY
   * where none could be held - no offscreen surface, overview zoom, or a view
   * larger than the chunk budget - in which case the floor is drawn tile by
   * tile as it always was; the fast path is an optimization, never a
   * requirement. A non-empty set always covers the whole view rect, so the two
   * paths never both draw the same sprite.
   */
  readonly staticFloor: ReadonlyArray<OfficeStaticChunkDraw>;
}

/**
 * A harness logo on a desk nameplate, CENTER anchored.
 *
 * The chip behind it is load-bearing, not decoration: the plate sits on wood,
 * and a brand mark drawn straight onto it can lose its own outline against a
 * grain of a similar value. Drawn whether or not the logo has rasterized yet,
 * so the plate does not visibly pop when an async decode lands.
 */
function drawHarnessLogo(
  ctx: CanvasRenderingContext2D,
  drawable: Extract<OfficeDrawable, { kind: "logo" }>,
  chipColor: string,
): void {
  const half = OFFICE_LOGO_SIZE / 2;
  const chipHalf = half + 1;
  ctx.save();
  ctx.globalAlpha = drawable.alpha ?? 1;
  ctx.fillStyle = chipColor;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(
      drawable.x - chipHalf,
      drawable.y - chipHalf,
      chipHalf * 2,
      chipHalf * 2,
      2,
    );
  } else {
    ctx.rect(
      drawable.x - chipHalf,
      drawable.y - chipHalf,
      chipHalf * 2,
      chipHalf * 2,
    );
  }
  ctx.fill();
  // `null` while the logo rasterizes - the chip alone is the placeholder. The
  // decode asks for the frame that first shows the mark (`onOfficeLogoReady`),
  // which a still floor would otherwise never draw.
  const logo = officeHarnessLogo(drawable.harnessId);
  if (logo !== null) {
    ctx.drawImage(logo, drawable.x - half, drawable.y - half);
  }
  ctx.restore();
}

/**
 * Hands over a clock face, in LOCAL time.
 *
 * Drawn rather than sprited because a sprite would need one frame per minute.
 * Twelve-hour geometry: the hour hand carries the minutes too, so it sits
 * between hours rather than jumping across them.
 */
function drawClockHands(
  ctx: CanvasRenderingContext2D,
  drawable: OfficeClockDrawable,
  inkColor: string,
): void {
  const angles = officeClockAngles(drawable.timeMs);
  ctx.save();
  ctx.strokeStyle = inkColor;
  ctx.fillStyle = inkColor;
  ctx.lineWidth = 1;
  for (const hand of [
    { angle: angles.hour, length: CLOCK_HOUR_HAND },
    { angle: angles.minute, length: CLOCK_MINUTE_HAND },
  ]) {
    ctx.beginPath();
    ctx.moveTo(drawable.x, drawable.y);
    // Twelve o'clock is UP, which is negative y, and angles run clockwise.
    ctx.lineTo(
      drawable.x + Math.sin(hand.angle) * hand.length,
      drawable.y - Math.cos(hand.angle) * hand.length,
    );
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(drawable.x, drawable.y, CLOCK_HUB_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEnvelope(
  ctx: CanvasRenderingContext2D,
  drawable: Extract<OfficeDrawable, { kind: "envelope" }>,
  theme: OfficeTheme,
  shadowColor: string,
): void {
  const size = officeSpriteSize({ name: "envelope" });
  // `y` already carries the scene's arc lift, so ADDING the same term back
  // recovers the straight sender-to-receiver line - where the envelope's
  // shadow belongs. Height is the only depth cue a flat floor has, and the
  // shadow shrinking as the arc peaks is what reads as height.
  const arcFraction = 4 * drawable.progress * (1 - drawable.progress);
  const groundY = drawable.y + ENVELOPE_ARC_LIFT * arcFraction;
  const radiusX = (size.width / 2) * (1 - 0.3 * arcFraction);
  const radiusY = Math.max(1, radiusX / 2.5);
  ctx.save();
  ctx.globalAlpha = 0.3 * (1 - 0.4 * arcFraction);
  ctx.fillStyle = shadowColor;
  ctx.beginPath();
  ctx.ellipse(drawable.x, groundY, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // An envelope is anchored at its CENTER; sprites draw from their top-left.
  drawOfficeSprite(
    ctx,
    { name: "envelope", tint: OFFICE_ENVELOPE_TINTS[drawable.pulseKind] },
    { x: drawable.x - size.width / 2, y: drawable.y - size.height / 2 },
    theme,
  );
}

/**
 * Where a sprite's (x, y) sits on its own box. The scene anchors the layers
 * differently on purpose - a floor tile is placed, a bubble is HUNG over the
 * head it belongs to - so the anchor travels with the layer, not the sprite.
 */
type SpriteAnchor = "top-left" | "bottom-center";

function drawAnchoredSprite(
  ctx: CanvasRenderingContext2D,
  drawable: Extract<OfficeDrawable, { kind: "sprite" }>,
  anchor: SpriteAnchor,
  theme: OfficeTheme,
): void {
  let x = drawable.x;
  let y = drawable.y;
  if (anchor === "bottom-center") {
    const size = officeSpriteSize(drawable.sprite);
    x -= size.width / 2;
    y -= size.height;
  }
  const alpha = drawable.alpha;
  if (alpha === undefined) {
    drawOfficeSprite(ctx, drawable.sprite, { x, y }, theme);
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  drawOfficeSprite(ctx, drawable.sprite, { x, y }, theme);
  ctx.restore();
}

/**
 * A floor's name over its stairwell. Only drawn when the building has more
 * than one floor: with a single host the building IS the epic, and a sign over
 * it would label the obvious.
 */
function drawFloorSigns(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly camera: OfficeCamera;
  readonly signs: ReadonlyArray<OfficeFloorSignToDraw>;
  readonly color: string;
  readonly backing: string;
}): void {
  const { backing, camera, color, ctx, signs } = args;
  for (const entry of signs) {
    drawScreenLabel(ctx, {
      text: entry.text,
      screenX: entry.anchor.x * camera.zoom + camera.x,
      screenY: entry.anchor.y * camera.zoom + camera.y - 2,
      fontPx: LABEL_FONT_PX,
      color,
      backing,
      alpha: 1,
    });
  }
}

/**
 * A room's name on a wall plate.
 *
 * SIGNAGE, not a name tag - and the distinction is the point. Cabin, area and
 * pod names used to be drawn in the same face as an agent's name, so a reader
 * counted "Cafeteria" as another person standing in the room. Uppercase,
 * tracked out, and set on a plate, it reads as a fixture instead. The plate is
 * also its own backing, so the four-offset outline the name tags use would
 * only muddy it.
 */
/** Puts the plate's own face on the context. Shared, so measuring matches drawing. */
function applySignPlateFont(ctx: CanvasRenderingContext2D): void {
  ctx.font = `bold ${OFFICE_SIGN_FONT_PX}px ${OFFICE_SIGN_MONOSPACE_STACK}`;
  ctx.letterSpacing = `${OFFICE_SIGN_LETTER_SPACING_EM}em`;
}

/**
 * How wide this text's plate would be, measured in the face it is drawn in.
 *
 * The resolver picks a board's reading by this, so the thing that decides
 * whether a reading fits is the same measurement that lays it out. A count of
 * characters is not a width: tracking, boldness and the fallback stack all
 * move it, and a six-tile board that a character budget called comfortable
 * measured three times the room it was naming.
 */
function signPlateMeasure(ctx: CanvasRenderingContext2D): OfficePlateMeasure {
  return (text: string): number => {
    ctx.save();
    applySignPlateFont(ctx);
    const width = ctx.measureText(text).width + OFFICE_SIGN_PADDING_X * 2;
    ctx.restore();
    return width;
  };
}

function drawSignPlate(
  ctx: CanvasRenderingContext2D,
  sign: {
    readonly text: string;
    readonly screenX: number;
    readonly screenY: number;
    readonly palette: OfficePalette;
  },
): void {
  const { palette, screenX, screenY, text } = sign;
  ctx.save();
  applySignPlateFont(ctx);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const width = ctx.measureText(text).width + OFFICE_SIGN_PADDING_X * 2;
  const height = OFFICE_SIGN_FONT_PX + SIGN_PADDING_Y * 2;
  const left = screenX - width / 2;
  const top = screenY - OFFICE_SIGN_FONT_PX - SIGN_PADDING_Y;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(left, top, width, height, SIGN_PLATE_RADIUS);
  } else {
    ctx.rect(left, top, width, height);
  }
  ctx.fillStyle = palette.ink;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.bright;
  ctx.stroke();
  ctx.fillStyle = palette.bright;
  ctx.fillText(text, screenX, screenY);
  ctx.restore();
}

type OfficeLabelDrawable = Extract<OfficeDrawable, { kind: "label" }>;
type OfficeClockDrawable = Extract<OfficeDrawable, { kind: "clock" }>;
type OfficePipDrawable = Extract<OfficeDrawable, { kind: "pip" }>;
type OfficeBlockDrawable = Extract<OfficeDrawable, { kind: "block" }>;

/**
 * Per-frame scratch, module-scoped and reused.
 *
 * Every allocation in the draw path is paid thirty times a second for as long
 * as an office is open, and these three collections are pure intermediates:
 * nothing outside `drawOfficeFrame` ever holds one, and each is fully
 * overwritten before it is read. Module scope rather than per-canvas because
 * the draw is synchronous and re-entrant only through itself, so two mounted
 * offices cannot be inside it at once.
 */
const labelScratch: OfficeLabelDrawable[] = [];
const clockScratch: OfficeClockDrawable[] = [];
const nameTagScratch: OfficeNameTagCandidate[] = [];

function resetScratch<T>(buffer: T[]): T[] {
  buffer.length = 0;
  return buffer;
}

/** The two label backings, per theme. Constant, so not rebuilt per frame. */
const LABEL_BACKINGS: Readonly<
  Record<OfficeTheme, Readonly<Record<OfficeLabelTone, string>>>
> = {
  light: {
    default: LIGHT_LABEL_BACKING,
    muted: LIGHT_LABEL_BACKING,
    // `bright` is the cabin sign's tone, light by definition, so it keeps the
    // dark backing in both themes.
    bright: DARK_LABEL_BACKING,
  },
  dark: {
    default: DARK_LABEL_BACKING,
    muted: DARK_LABEL_BACKING,
    bright: DARK_LABEL_BACKING,
  },
};

/**
 * Measured text widths, by string.
 *
 * `measureText` shapes the run and allocates a `TextMetrics` for every tag on
 * every frame, and an agent's name does not change width between two frames.
 * The font is a module constant, so the text alone is the whole key. Bounded
 * because a long session can meet a lot of names.
 */
const MEASURE_CACHE_LIMIT = 512;
const measuredWidths = new Map<string, number>();

function measuredWidth(ctx: CanvasRenderingContext2D, text: string): number {
  const cached = measuredWidths.get(text);
  if (cached !== undefined) return cached;
  const width = ctx.measureText(text).width;
  if (measuredWidths.size >= MEASURE_CACHE_LIMIT) {
    const oldest = measuredWidths.keys().next();
    if (oldest.done !== true) measuredWidths.delete(oldest.value);
  }
  measuredWidths.set(text, width);
  return width;
}

interface DrawLayerArgs {
  readonly ctx: CanvasRenderingContext2D;
  readonly drawables: ReadonlyArray<OfficeDrawable>;
  readonly anchor: SpriteAnchor;
  readonly theme: OfficeTheme;
  readonly palette: OfficePalette;
  /** Drawables set aside for a later pass, in screen space. */
  readonly labels: OfficeLabelDrawable[];
  readonly clocks: OfficeClockDrawable[];
  /**
   * `skip` for the floor when its sprites are already on screen from the
   * static layer. Everything that layer does NOT bake still comes through
   * here, so the blitted floor and the drawn one contain the same things.
   */
  readonly sprites: "draw" | "skip";
}

/**
 * Draws one layer of the frame, setting aside the drawables that belong to a
 * later pass. A function rather than a loop over an array of layer descriptors
 * - four object literals a frame to say what four call sites already say.
 */
function drawDrawableLayer(args: DrawLayerArgs): void {
  const { anchor, clocks, ctx, drawables, labels, palette, sprites, theme } =
    args;
  for (const drawable of drawables) {
    if (sprites === "skip" && officeBakesIntoStaticFloor(drawable)) continue;
    if (drawable.kind === "label") {
      labels.push(drawable);
      continue;
    }
    if (drawable.kind === "envelope") {
      drawEnvelope(ctx, drawable, theme, palette.shadow);
      continue;
    }
    if (drawable.kind === "logo") {
      drawHarnessLogo(ctx, drawable, palette.wallDark);
      continue;
    }
    if (drawable.kind === "clock") {
      clocks.push(drawable);
      continue;
    }
    // The two overview primitives. They are not sprites - at lod 0 a tile is
    // under a pixel, so the floor is filled rects and a person is a dot.
    if (drawable.kind === "block") {
      drawBlock({ ctx, block: drawable, palette });
      continue;
    }
    if (drawable.kind === "pip") {
      drawPip({ ctx, pip: drawable, palette });
      continue;
    }
    drawAnchoredSprite(ctx, drawable, anchor, theme);
  }
}

/**
 * Paints the bakeable half of the floor into the static layer, in sprite space
 * with no camera. Its complement is drawn per frame by the caller.
 */
function drawStaticFloor(
  ctx: CanvasRenderingContext2D,
  floor: ReadonlyArray<OfficeDrawable>,
  theme: OfficeTheme,
): void {
  for (const drawable of floor) {
    if (!officeBakesIntoStaticFloor(drawable)) continue;
    drawAnchoredSprite(ctx, drawable, "top-left", theme);
  }
}

/**
 * The pair edge of the envelope under a point, topmost first.
 *
 * The scene can answer this too, but only by rebuilding its whole overlay to
 * do it - and the regions it would rebuild are the ones already drawn.
 */
function envelopeEdgeAt(
  regions: ReadonlyArray<OfficeEnvelopeHitRegion>,
  point: OfficePoint,
): string | null {
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index];
    const rect = region.rect;
    if (
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
    ) {
      return region.edgeId;
    }
  }
  return null;
}

/**
 * The envelope under a point, from the last drawn frame where there is one.
 *
 * Falling back to the scene rebuilds its entire overlay to answer, which is
 * why it happens once at most: before the first frame. After that the drawn
 * regions ARE the answer, and they are what the person is pointing at.
 */
function envelopeEdgeFor(
  runtime: OfficeRuntime,
  scene: OfficeScene,
  point: OfficePoint,
): string | null {
  if (!runtime.hasDrawnFrame()) return scene.hitTestEnvelope(point);
  return envelopeEdgeAt(runtime.getEnvelopeRegions(), point);
}

/**
 * The world-space art a sign hangs ON: a two-tile wall board for a cabin or an
 * area, a one-tile plate for a pod. A board sign has none - it is lettering on
 * the storey itself, which the later views hang without furniture.
 */
function signSpriteFor(sign: OfficeSign): "sign" | "pod-plate" | null {
  if (sign.kind === "room" || sign.kind === "area" || sign.kind === "host") {
    return "sign";
  }
  if (sign.kind === "pod" || sign.kind === "plate") return "pod-plate";
  return null;
}

/** How many characters fit across a sign of this width, before the ellipsis. */
function signMaxChars(widthTiles: number): number {
  return widthTiles >= SIGN_WIDTH_TILES
    ? MAX_ROOM_LABEL_CHARS
    : MAX_POD_LABEL_CHARS;
}

function truncateSign(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Whether the middle zoom band names this character.
 *
 * Only the three the reader has singled out: the one under the pointer, the one
 * whose panel is open, and the ones Find is matching. A label with no owner is
 * not a name tag at all - a painter's own lettering - and is always drawn.
 */
function isNameTagCalledFor(args: {
  readonly owner: string | null;
  readonly hoveredAgentId: string | null;
  readonly selectedAgentId: string | null;
  readonly searchMatchIds: ReadonlySet<string>;
}): boolean {
  const { hoveredAgentId, owner, searchMatchIds, selectedAgentId } = args;
  if (owner === null) return true;
  return (
    owner === hoveredAgentId ||
    owner === selectedAgentId ||
    searchMatchIds.has(owner)
  );
}

/** Overview draws none; see the note in `officeSignsToDraw`. */
const NO_SIGN_ENTRIES: ReadonlyArray<OfficeSignToDraw> = [];
const NO_FLOOR_SIGN_ENTRIES: ReadonlyArray<OfficeFloorSignToDraw> = [];

/**
 * How far a sign's art reaches ABOVE its own tile.
 *
 * A sprite-space constant, so it is added to the PROJECTED top of the tile
 * rather than recomputed from an unprojected row - the same treatment the
 * overlay's clock face gets, and the reason signs now land on their cabins
 * under an isometric projector instead of beside them.
 */
function signArtOverhang(name: OfficeSpriteName): number {
  return OFFICE_TILE - officeSpriteSize({ name }).height;
}

/**
 * The lettering the PLAN placed: cabin signs, pod plates, area names, boards.
 *
 * Two passes, because a sign is two things in two coordinate spaces: the board
 * it hangs on is world art under the camera, and the text on it is screen-space
 * so it stays crisp at every zoom. Both hang off the anchor the resolver
 * projected, so neither has any tile arithmetic of its own.
 */
function drawSignArt(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly signs: ReadonlyArray<OfficeSignToDraw>;
  readonly theme: OfficeTheme;
}): void {
  const { ctx, signs, theme } = args;
  for (const entry of signs) {
    const name = signSpriteFor(entry.sign);
    if (name === null) continue;
    drawOfficeSprite(
      ctx,
      { name },
      {
        x: entry.anchor.x,
        y: entry.anchor.y + signArtOverhang(name),
      },
      theme,
    );
  }
}

function drawSignLabels(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly signs: ReadonlyArray<OfficeSignToDraw>;
  readonly camera: OfficeCamera;
  readonly palette: OfficePalette;
  readonly lod: OfficeLod;
}): void {
  const { camera, ctx, lod, palette, signs } = args;
  for (const entry of signs) {
    const name = signSpriteFor(entry.sign);
    const baseline =
      entry.anchor.y +
      (name === null ? 0 : signArtOverhang(name)) +
      SIGN_LABEL_BASELINE;
    const screenX = officeSignCenterX(entry) * camera.zoom + camera.x;
    drawSignPlate(ctx, {
      text: signPlateText(entry).toUpperCase(),
      screenX,
      screenY: baseline * camera.zoom + camera.y,
      palette,
    });
    // THE CLAIM ONLY AT CLOSE-UP. The name is what a plate is for; the role
    // under it is a second plate's worth of pixels, and at office zoom it
    // would double the signage on a floor that is already mostly signage.
    if (lod < 2 || entry.subtext === null) continue;
    drawSignPlate(ctx, {
      text: truncateSign(
        entry.subtext,
        signMaxChars(entry.sign.widthTiles),
      ).toUpperCase(),
      screenX,
      screenY:
        (baseline + OFFICE_SIGN_FONT_PX + SIGN_PADDING_Y * 2) * camera.zoom +
        camera.y,
      palette,
    });
  }
}

/**
 * A board is already laid out to its own width by the resolver, so truncating
 * it here would cut a reading that was chosen to fit. A NAME is different: it
 * cannot be abbreviated by rule and keeps the ellipsis it always had.
 */
function signPlateText(entry: OfficeSignToDraw): string {
  if (entry.sign.kind === "board" || entry.sign.kind === "hq-board") {
    return entry.text;
  }
  return truncateSign(entry.text, signMaxChars(entry.sign.widthTiles));
}

/**
 * What a lod-0 block is painted in. Every role resolves in both themes - a
 * fill with no colour is a hole in the overview, and the block map is the
 * whole of the floor at that zoom.
 */
function blockColor(fill: OfficeBlockFill, palette: OfficePalette): string {
  if (fill === "room") return palette.wallLight;
  if (fill === "pod") return palette.glassLight;
  if (fill === "storey") return palette.floorBase;
  if (fill === "building") return palette.wallDark;
  if (fill === "grass") return palette.leafDark;
  // `plaza` and `ground` are both open outdoor floor.
  return palette.floorAccent;
}

/** One agent at overview zoom: a dot in its status colour, with its glyph. */
function drawPip(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly pip: OfficePipDrawable;
  readonly palette: OfficePalette;
}): void {
  const { ctx, palette, pip } = args;
  const color = officePipColor(pip.status, palette);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (pip.glyph === "hollow") {
    ctx.beginPath();
    ctx.arc(pip.x, pip.y, PIP_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(pip.x, pip.y, PIP_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
  if (pip.glyph === "ring") {
    // A second, wider outline: the mark for "waiting on somebody else", which
    // must not be the colour alone.
    ctx.beginPath();
    ctx.arc(pip.x, pip.y, PIP_RADIUS + PIP_RING_GAP, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (pip.glyph === "bang") {
    ctx.beginPath();
    ctx.moveTo(pip.x, pip.y - PIP_RADIUS - PIP_BANG_HEIGHT);
    ctx.lineTo(pip.x, pip.y - PIP_RADIUS - 1);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBlock(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly block: OfficeBlockDrawable;
  readonly palette: OfficePalette;
}): void {
  const { block, ctx, palette } = args;
  ctx.save();
  ctx.globalAlpha = block.alpha ?? 1;
  ctx.fillStyle = blockColor(block.fill, palette);
  ctx.fillRect(block.x, block.y, block.width, block.height);
  ctx.restore();
}

/**
 * Agent name tags, thinned and de-overlapped.
 *
 * WHO gets one is the zoom band's question and only the zoom band's: nothing
 * here asks whether a character is in its chair. A walking agent's tag used
 * to be dropped unless it was hovered, which quietly overrode the band - a
 * selected agent lost its label the moment it stood up, and at close-up,
 * where everything is named, a walker was not. Crowding is what
 * {@link layoutNameTags} is for, and it moves or drops a tag by where the tag
 * lands rather than by what its owner happens to be doing.
 */
function drawNameTags(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly labels: ReadonlyArray<OfficeLabelDrawable>;
  readonly camera: OfficeCamera;
  readonly palette: OfficePalette;
  readonly backings: Readonly<Record<OfficeLabelTone, string>>;
  readonly hoveredAgentId: string | null;
  readonly selectedAgentId: string | null;
  readonly searchMatchIds: ReadonlySet<string>;
  readonly lod: OfficeLod;
}): ReadonlySet<string> {
  const {
    backings,
    camera,
    ctx,
    hoveredAgentId,
    labels,
    lod,
    palette,
    searchMatchIds,
    selectedAgentId,
  } = args;
  const named = new Set<string>();
  // SEMANTIC ZOOM. At overview a name is a smear over a five-pixel pip, so
  // there are none; in the middle band only the agents the reader has actually
  // pointed at get one, because a floor of four hundred names is a wall of text
  // that hides the office it describes; at close-up everything is named.
  if (lod === 0) return named;
  const candidates = resetScratch(nameTagScratch);
  ctx.font = LABEL_FONT;
  for (const label of labels) {
    // Signage is drawn from `layout.signs` by `drawSignLabels` and never
    // reaches the frame, so a `bright` label here is a view sending signage
    // down the name-tag channel. Skipped rather than printed as body text on
    // a plate meant for a dark surface - and skipping it is also what narrows
    // the tone to the two a name tag can carry.
    if (label.tone === "bright") continue;
    // The owner rides ON the drawable now. It used to be recovered by scanning
    // the hit regions for one whose centre line matched, which is a guess that
    // is wrong the moment two things share a column.
    const owner = label.ownerAgentId;
    if (
      lod === 1 &&
      !isNameTagCalledFor({
        owner,
        hoveredAgentId,
        selectedAgentId,
        searchMatchIds,
      })
    ) {
      continue;
    }
    candidates.push({
      text: label.text,
      tone: label.tone,
      ownerAgentId: owner,
      centerX: label.x * camera.zoom + camera.x,
      baselineY: label.y * camera.zoom + camera.y,
      width: measuredWidth(ctx, label.text),
    });
  }
  for (const placed of layoutNameTags(candidates, NAME_TAG_LINE_HEIGHT)) {
    drawScreenLabel(ctx, {
      text: placed.text,
      screenX: placed.centerX,
      screenY: placed.baselineY,
      fontPx: LABEL_FONT_PX,
      color: placed.tone === "muted" ? palette.textMuted : palette.text,
      backing: backings[placed.tone],
      alpha: 1,
    });
    // PLACED, not merely offered. A tag with nowhere to go is dropped rather
    // than drawn over its neighbour, and an agent whose tag was dropped has
    // not been named by this path.
    if (placed.ownerAgentId !== null) named.add(placed.ownerAgentId);
  }
  return named;
}

function drawOfficeFrame(args: DrawFrameArgs): void {
  const {
    camera,
    ctx,
    dpr,
    floors,
    frame,
    hostNameById,
    hoveredAgentId,
    lod,
    nameById,
    roleClaims,
    searchMatchIds,
    selectedAgentId,
    staticFloor,
    statusById,
    theme,
    viewport,
    visibleAgentIds,
  } = args;
  const palette = officePalette(theme);
  // Resolved once, through the view's own projector: what each sign says at
  // this cursor and where that lands in world pixels. Overview resolves none.
  const projector = args.projector;
  const signs =
    projector === null
      ? NO_SIGN_ENTRIES
      : officeSignsToDraw({
          signs: args.signs,
          visibleAgentIds,
          statusById,
          nameById,
          hostNameById,
          roleClaims,
          projector,
          lod,
          // A board is laid out to ITS OWN width on screen, which moves with
          // the camera: the same six tiles are ninety-six pixels at 1x and
          // sixty-seven at 0.7, and the reading that fits is not the same one.
          zoom: camera.zoom,
          measure: signPlateMeasure(ctx),
        });
  const floorSigns =
    projector === null
      ? NO_FLOOR_SIGN_ENTRIES
      : officeFloorSignsToDraw({ floors, hostNameById, projector, lod });
  // The backing exists to separate glyphs from whatever they sit on, so it has
  // to contrast with the TEXT. A fixed dark backing did that for the dark
  // theme's light text and smeared the light theme's dark text into a bold
  // blur. `bright` is the exception in both themes: it is the cabin sign's
  // tone, light by definition, so it keeps the dark backing either way.
  const labelBackings = LABEL_BACKINGS[theme];

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  ctx.setTransform(
    dpr * camera.zoom,
    0,
    0,
    dpr * camera.zoom,
    dpr * camera.x,
    dpr * camera.y,
  );
  ctx.imageSmoothingEnabled = false;

  // Labels are collected rather than drawn inline: they belong to screen space,
  // and switching the transform per label would cost more than one pass.
  // Collected into SCRATCH buffers reused across frames - a fresh array per
  // layer per frame is garbage the collector has to walk thirty times a
  // second, and nothing outside this function ever sees them.
  const labels = resetScratch(labelScratch);
  // Collected so the hands land ON TOP of the face sprite regardless of which
  // layer the scene emitted the clock in.
  const clocks = resetScratch(clockScratch);
  // The floor is either one blit or, where no offscreen surface exists, the
  // tile-by-tile walk it has always been. At overview zoom there is no bake at
  // all: the floor is a few dozen filled rects, and baking a whole world's
  // bitmap to blit them would be the largest allocation in the office.
  const layer = {
    ctx,
    theme,
    palette,
    labels,
    clocks,
    sprites: "draw",
  } as const;
  if (staticFloor.length === 0) {
    drawDrawableLayer({ ...layer, drawables: frame.floor, anchor: "top-left" });
  } else {
    for (const chunk of staticFloor) {
      ctx.drawImage(chunk.canvas, chunk.x, chunk.y);
    }
    // The layer baked the sprites and nothing else, so the rest of the floor
    // takes the ordinary path - otherwise a label on the floor would appear
    // only on hosts that could not make an offscreen surface.
    drawDrawableLayer({
      ...layer,
      drawables: frame.floor,
      anchor: "top-left",
      sprites: "skip",
    });
  }
  // ONE of the two streams, never both: a `world` painter interleaves its props
  // and its characters by depth because they genuinely overlap, and a `layered`
  // one draws props and then actors as the office always has.
  const world = frame.world;
  if (world === null) {
    drawDrawableLayer({ ...layer, drawables: frame.props, anchor: "top-left" });
    drawDrawableLayer({
      ...layer,
      drawables: frame.actors,
      anchor: "top-left",
    });
  } else {
    drawDrawableLayer({
      ...layer,
      drawables: world.map((entry) => entry.drawable),
      anchor: "top-left",
    });
  }
  // Bubbles and sparkles hang over whatever they belong to, so the scene
  // anchors them at their bottom centre rather than a corner.
  drawDrawableLayer({
    ...layer,
    drawables: frame.overlay,
    anchor: "bottom-center",
  });
  // Signage rides on the world transform for its board and on the screen for
  // its text, so the board goes down before the transform is dropped.
  drawSignArt({ ctx, signs, theme });

  for (const clock of clocks) drawClockHands(ctx, clock, palette.ink);

  // Back to screen space for text: a name magnified by the camera would be a
  // blur at zoom 4 and unreadable at zoom 0.5. The palette owns these colors
  // rather than `--foreground`, because they have to contrast with the ROOM,
  // which is the palette's own background and not the app's.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  drawSignLabels({ ctx, signs, camera, palette, lod });
  const alreadyNamed = drawNameTags({
    ctx,
    labels,
    camera,
    palette,
    backings: labelBackings,
    hoveredAgentId,
    selectedAgentId,
    searchMatchIds,
    lod,
  });

  drawFloorSigns({
    ctx,
    camera,
    signs: floorSigns,
    color: palette.text,
    backing: labelBackings.default,
  });
  drawFindOverlay({
    ctx,
    regions: frame.hitRegions,
    labels,
    camera,
    palette,
    backing: labelBackings.default,
    nameById,
    searchMatchIds,
    lod,
    alreadyNamed,
  });
}

/**
 * What Find draws over the agents it matched: one ring and one name EACH.
 *
 * This used to walk `frame.hitRegions` and annotate every entry. A hit region
 * is one clickable PART of a drawable, and since parts became individually
 * hit-testable a City building contributes its roof, its windows, its body and
 * its seat backstop - so one matched agent drew thirty-two rings and thirty-two
 * copies of its own name, stacked four pixels apart over the same building.
 * The regions are right; treating each of them as another agent was not.
 *
 * The name also came out here unconditionally, which put a name on the screen
 * at overview zoom - where the office draws none, because a name there is a
 * smear over a five-pixel pip. Find is a reason to QUALIFY for a name tag, not
 * a way around the band that decides whether names exist at all.
 *
 * The ring is not a name and stays at every zoom: at overview it is the only
 * thing that can say where a match is.
 *
 * THE NAME IS THE TAG PATH'S unless that path did not draw one. A matched
 * agent qualifies for an ordinary name tag, so drawing a Find label beside it
 * put two names at the same anchor - which read as one slightly bold name and
 * hid itself whenever the tag was truncated and the two strings stopped
 * matching. `drawNameTags` reports who it actually placed, and Find names only
 * the agents it did not: one whose tag was dropped for collision, or whose
 * view emitted no label drawable for it at all.
 */
function drawFindOverlay(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly regions: ReadonlyArray<OfficeHitRegion>;
  readonly labels: ReadonlyArray<OfficeLabelDrawable>;
  readonly camera: OfficeCamera;
  readonly palette: OfficePalette;
  readonly backing: string;
  readonly nameById: ReadonlyMap<string, string>;
  readonly searchMatchIds: ReadonlySet<string>;
  readonly lod: OfficeLod;
  /** Agents the ordinary name-tag path has already put a name on screen for. */
  readonly alreadyNamed: ReadonlySet<string>;
}): void {
  const {
    alreadyNamed,
    backing,
    camera,
    ctx,
    labels,
    lod,
    nameById,
    palette,
    regions,
    searchMatchIds,
  } = args;
  if (searchMatchIds.size === 0) return;
  // One box an agent, grown to cover every part it owns, in draw order so two
  // matched agents ring in the same order their parts arrived.
  const bounds = new Map<string, OfficeRect>();
  for (const region of regions) {
    if (!searchMatchIds.has(region.agentId)) continue;
    const grown = bounds.get(region.agentId);
    bounds.set(
      region.agentId,
      grown === undefined ? region.rect : unionRect(grown, region.rect),
    );
  }
  // The anchor a name tag would use, so Find's label and the office's own
  // lettering agree about where this agent's name belongs.
  const anchors = new Map<string, OfficePoint>();
  for (const label of labels) {
    const owner = label.ownerAgentId;
    if (owner === null || anchors.has(owner)) continue;
    if (!searchMatchIds.has(owner)) continue;
    anchors.set(owner, { x: label.x, y: label.y });
  }
  for (const [agentId, rect] of bounds) {
    const left = rect.x * camera.zoom + camera.x;
    const top = rect.y * camera.zoom + camera.y;
    ctx.save();
    ctx.strokeStyle = palette.bright;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      left,
      top,
      rect.width * camera.zoom,
      rect.height * camera.zoom,
    );
    ctx.restore();
    // NO NAMES AT OVERVIEW, the same rule every other name on this canvas
    // obeys. The ring above has already said where the match is.
    if (lod === 0) continue;
    // ONE NAME. The office has already named this agent, laid out against its
    // neighbours and truncated to fit; a second copy at the same anchor is not
    // a second piece of information.
    if (alreadyNamed.has(agentId)) continue;
    const name = nameById.get(agentId);
    if (name === undefined) continue;
    const anchor = anchors.get(agentId);
    drawScreenLabel(ctx, {
      text: name,
      screenX:
        anchor === undefined
          ? left + (rect.width * camera.zoom) / 2
          : anchor.x * camera.zoom + camera.x,
      screenY:
        anchor === undefined
          ? top - HOVER_LABEL_FONT_PX / 2
          : anchor.y * camera.zoom + camera.y,
      fontPx: HOVER_LABEL_FONT_PX,
      color: palette.text,
      backing,
      alpha: 1,
    });
  }
}

/** The smallest box covering both - one agent's parts, gathered. */
function unionRect(left: OfficeRect, right: OfficeRect): OfficeRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
}

/**
 * `prefers-reduced-motion`, live. The scene applies state changes instantly
 * under it - no walking, no flight - so the preference has to be able to change
 * mid-session rather than being sampled once at mount.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (): void => setReduced(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, []);
  return reduced;
}

/**
 * The top-right chrome, in reading order: what is beside the floor, what the
 * floor IS, and which renderer draws it.
 *
 * Its own component so the office component is not also a toolbar: the row is
 * three controls and one branch, and none of it depends on anything the canvas
 * knows.
 */
function OfficeChromeRow(props: {
  readonly directoryOpen: boolean;
  readonly onToggleDirectory: () => void;
  readonly viewPicker: ReactNode;
  readonly modeToggle: ReactNode;
}) {
  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
      <div
        className={cn(
          "flex items-center gap-0.5 rounded-md border border-border",
          "bg-popover p-0.5 shadow-xs",
        )}
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-pressed={props.directoryOpen}
          aria-label={
            props.directoryOpen ? "Hide the directory" : "Show the directory"
          }
          data-testid="comm-graph-office-directory-toggle"
          onClick={props.onToggleDirectory}
        >
          <PanelLeft aria-hidden />
        </Button>
        {props.viewPicker}
      </div>
      {props.modeToggle}
    </div>
  );
}

/** The moment a detached floor is showing; nothing while live. */
function OfficeCursorChip(props: {
  readonly cursorMs: number | null;
  readonly playing: boolean;
}) {
  if (props.cursorMs === null) return null;
  return (
    <div
      data-testid="comm-graph-office-cursor-chip"
      // Read-only: it must not take the pan or the click a person aims at the
      // floor underneath it.
      className="pointer-events-none absolute top-2 left-2 z-10 rounded-md border border-border bg-popover px-1.5 py-0.5 text-ui-xs text-popover-foreground tabular-nums shadow-xs"
    >
      <span className="text-muted-foreground">
        {props.playing ? "Replaying " : "Paused at "}
      </span>
      {new Date(props.cursorMs).toLocaleTimeString()}
    </div>
  );
}

export interface CommGraphOfficeCanvasProps extends CommGraphCanvasProps {
  /**
   * WHICH view draws this canvas - a value, not an id: the plan, the measure
   * and the painter all come out of it, and the scene is rebuilt when it
   * changes. Named `officeView` because `view` on `CommGraphCanvasProps` is
   * already the tile's camera and mode state, which both canvases share.
   */
  readonly officeView: OfficeView;
  /**
   * The view picker, owned by the tile (which owns the choice it writes) and
   * POSITIONED here, beside the mode toggle - the same bargain the toggle
   * itself strikes, and for the same reason: only this component knows where
   * its canvas ends and a detail panel begins.
   */
  readonly viewPicker: ReactNode;
  /** Auto's explanation, or `null` where the choice is not Auto. */
  readonly autoChip: ReactNode;
  /**
   * Whether the tile has settled what this canvas is supposed to draw.
   *
   * False while Auto is still measuring: the derivations below keep running
   * (they are what make the probe possible, and they are cheap), but nothing
   * is PLANNED - a floor planned for a view that is about to be replaced is a
   * whole layout thrown away a moment later.
   */
  readonly ready: boolean;
  /**
   * What Auto would need to decide, pushed up as the inputs change.
   *
   * The measurement belongs to the TILE - a mode toggle or an LRU remount
   * re-creates this component, and a decision taken here would be re-taken
   * every time - but the two things a decision needs are both known here: the
   * population this canvas derives anyway, and the box the office is left
   * once the directory and any panel have taken their width.
   */
  /** The current measurement, or `null` when this canvas no longer has one. */
  readonly onAutoProbe: (probe: OfficeAutoProbe | null) => void;
}

export function CommGraphOfficeCanvas(props: CommGraphOfficeCanvasProps) {
  const {
    agentIds,
    agents,
    autoChip,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    canOpenAgentForEvent,
    epicId,
    events,
    initialHistoryCaughtUp,
    modeToggle,
    officeView,
    onAutoProbe,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    onCameraChange,
    playing,
    pulse,
    pulseKey,
    ready,
    tileInstanceId,
    view,
    viewPicker,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [runtime] = useState(() => createOfficeRuntime(view));
  // A tile the user has never framed keeps fitting itself, so a floor that
  // GROWS - agents arriving after the first frame, which is the normal case -
  // is framed as the room it became rather than as the empty one it started
  // as. The first pan, zoom or explicit fit ends that for good.
  //
  // The VIEWPORT is part of what was fitted, not only the floor: a tile that
  // shrinks or grows around an unchanged floor needs framing again just as
  // much as a floor that grew inside an unchanged tile.
  const fittedRef = useRef<{
    readonly floor: OfficeSize;
    readonly viewport: ScreenSize;
  }>({
    floor: { width: 0, height: 0 },
    viewport: { width: 0, height: 0 },
  });
  // The open hover's subject and the pointer's last position; `null` while no
  // card is open. The frame loop re-resolves it against every frame.
  const hoverAnchorRef = useRef<OfficeHoverAnchor | null>(null);
  /** The box the card was last placed at, so a frame that moved nothing is free. */
  const hoverRectRef = useRef<OfficeRect | null>(null);
  // A pan asked for outside the frame loop. Handlers and the Find adapter have
  // no frame clock, so they name the destination and the loop starts it.
  const dragRef = useRef<DragState | null>(null);
  /** The ratio the bitmap was last sized at, so a change to it is detectable. */
  const appliedDprRef = useRef<number>(1);
  const wasPlayingRef = useRef(playing);
  const autoPannedKeyRef = useRef<string | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  // ONE detail surface at a time, the same rule the node graph follows:
  // opening a character replaces an open thread and vice versa, so the floor
  // never has two competing explanations beside it.
  const [selectedDetail, setSelectedDetail] =
    useState<OfficeSelectedDetail | null>(null);
  const selectedAgentId =
    selectedDetail?.kind === "agent" ? selectedDetail.agentId : null;
  const selectedEdgeId =
    selectedDetail?.kind === "pair" ? selectedDetail.edgeId : null;
  const setSelectedAgentId = useCallback((agentId: string | null) => {
    setSelectedDetail(agentId === null ? null : { kind: "agent", agentId });
  }, []);
  // What the pointer is over, in container-relative screen pixels. State
  // rather than a ref because the card is React, and it only moves when the
  // hover target changes - not every frame.
  const [hoverCard, setHoverCard] = useState<OfficeHoverTarget | null>(null);

  // The BAND the camera is in, mirrored into React for the chip that names it.
  // The camera itself is a ref read by the frame loop; only a band CHANGE is
  // worth a render, which is a few times per session rather than per frame.
  const openingLod = officeLodForZoom(clampZoom(view.zoom));
  const lodBandRef = useRef<OfficeLod>(openingLod);
  const [lodBand, setLodBand] = useState<OfficeLod>(openingLod);
  const syncLodBand = useCallback((zoom: number) => {
    const next = officeLodForZoom(zoom);
    if (lodBandRef.current === next) return;
    lodBandRef.current = next;
    setLodBand(next);
  }, []);

  /** The canvas box as last measured; `EMPTY_VIEWPORT` before the first pass. */
  const [measuredBox, setMeasuredBox] = useState<OfficeSize>(EMPTY_VIEWPORT);

  const directoryOpen = useCommGraphDirectoryOpen();
  const setDirectoryOpen = useCommGraphPanelStore(
    (state) => state.setDirectoryOpen,
  );

  const { resolvedTheme } = useResolvedTheme();
  const themeRevision = useThemeRevision();
  const speed = useCommGraphSpeed(epicId);
  // The cursor's capture time decides which agents read as archived AS OF the
  // floor being shown, and what the wall clock says during replay.
  const cursorMs = useCommGraphCursor(epicId)?.timestamp ?? null;
  const activityTiers = useEpicAgentActivityTiers();
  const reducedMotion = usePrefersReducedMotion();

  // ONE scene per epic AND per view, kept across renders: it owns walk paths,
  // envelope flights and typing phase, all of which are continuous state that
  // a re-created scene would restart on every unrelated prop change.
  //
  // Built on the first ELIGIBLE input rather than at mount. A tile in a
  // background tab is mounted along with everything else in its pane, and a
  // scene built there would plan a whole floor for nobody - which is the
  // largest single thing a hidden office used to do.
  //
  // Not keyed by the VIEW. The contract's answer to a view change is that this
  // canvas REMOUNTS, so the scene goes with the component through the ordinary
  // unmount path rather than being swapped underneath it - which also keeps
  // `previous` from ever chaining across two different plans.
  //
  // The KEY that guarantees that is the tile's: it renders this canvas under
  // `key={resolvedViewId}:{autoRevision}` (`comm-graph-tile.tsx`), so a picked
  // view - or a re-measured Auto - is a remount here and never a scene left
  // over from the view before it.
  const sceneRef = useRef<{
    readonly epicId: string;
    readonly scene: OfficeScene;
  } | null>(null);
  /** The live scene, or `null` where nothing has been eligible to build one. */
  const peekScene = useCallback((): OfficeScene | null => {
    const current = sceneRef.current;
    if (current === null || current.epicId !== epicId) return null;
    return current.scene;
  }, [epicId]);
  const ensureScene = useCallback((): OfficeScene => {
    const current = peekScene();
    if (current !== null) return current;
    // No initial layout: the first sync plans one. Handing the constructor an
    // empty plan would be a floor nobody asked for, thrown away a line later.
    const scene = new OfficeScene(officeView, null);
    sceneRef.current = { epicId, scene };
    return scene;
  }, [epicId, officeView, peekScene]);

  // The canvas's own intersection state - the one eligibility signal no
  // context can answer, because a tile scrolled out of the epic canvas is
  // mounted, selected and in a visible pane.
  const [intersecting, setIntersecting] = useState(false);
  const { eligible } = useOfficeEligibility({ intersecting });

  const nameById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  useEffect(() => {
    runtime.setNameById(nameById);
    // A rename moves nothing, so nothing else would ask for the frame that
    // shows it.
    runtime.invalidateFrame();
  }, [nameById, runtime]);

  // ONE subscription for every agent's claims, the same shape `nameById`
  // takes: the plates read it, the hover card reads it, and a hook per sign
  // would re-run a subscription per room whenever anyone claimed anything.
  const roleClaimsByAgentId = useEpicAgentRoleClaimsByAgentId();
  useEffect(() => {
    runtime.setRoleClaims(roleClaimsByAgentId);
    // A claim lands asynchronously and moves nothing on the floor, so the
    // frame that shows it has to be asked for.
    runtime.invalidateFrame();
  }, [roleClaimsByAgentId, runtime]);

  // Selecting an agent names it at the middle zoom band, so the frame loop has
  // to know who that is. Pushed rather than closed over, for the same reason
  // the names are: the loop is built once and outlives every selection.
  useEffect(() => {
    runtime.setSelectedAgentId(selectedAgentId);
  }, [runtime, selectedAgentId]);

  const officeAgents = useMemo<ReadonlyArray<OfficeAgentInput>>(
    () =>
      agents.map((agent) => ({
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
      })),
    [agents],
  );

  // The "!" bubble's source. Read for every agent in one store subscription
  // (the same shape the sidebar's descendant rollup uses) rather than one hook
  // per character: a floor can hold dozens, and each would otherwise be its own
  // subscription re-running on every unrelated notification.
  const indicators = useContext(NotificationIndicatorsContext);
  // ONE subscription for both signals. They are read from the same indicator
  // state and split by the SAME rule `attentionTone` applies internally, so a
  // crashed screen and a "!" bubble can never disagree about one agent.
  const flaggedIdList = useAppLocalNotificationsStore(
    useShallow((state): ReadonlyArray<string> =>
      agents.flatMap((agent) => {
        const indicatorState = selectNotificationIndicatorState(
          state,
          { epicId, chatId: agent.id },
          agent.hostId,
          indicators,
        );
        if (attentionTone(indicatorState) === null) return [];
        return [`${officeFlagKind(indicatorState)}:${agent.id}`];
      }),
    ),
  );
  const { attentionAgentIds, failureAgentIds } = useMemo(() => {
    const attention = new Set<string>();
    const failure = new Set<string>();
    for (const entry of flaggedIdList) {
      const separator = entry.indexOf(":");
      const agentId = entry.slice(separator + 1);
      if (entry.startsWith("failure:")) failure.add(agentId);
      else attention.add(agentId);
    }
    return { attentionAgentIds: attention, failureAgentIds: failure };
  }, [flaggedIdList]);

  // THE DEV BENCH'S ONE BRANCH IN THIS FILE, and the whole of it.
  //
  // Every input `officeAgentStatuses` reads - the activity store, the event
  // feed, the notification indicators - is keyed by agents that exist on a
  // host, so a synthetic population reads as a thousand idle agents and a
  // still office is the wrong thing to profile. The bench's own fixture
  // carries the statuses instead. `null` in production, where the reader
  // returns before it touches anything and takes the fixtures out of the
  // bundle with it.
  const benchStatusById = officeBenchStatuses();
  const statusById = useMemo(
    () =>
      benchStatusById ??
      officeAgentStatuses({
        agents: officeAgents,
        // The cursor, so a scrub back BEFORE an agent was archived reads it as
        // live - which is the desk the scene draws it at.
        cursorMs,
        events,
        visibleAgentIds: agentIds,
        activityTiers,
        attentionAgentIds,
        failureAgentIds,
      }),
    [
      activityTiers,
      agentIds,
      attentionAgentIds,
      benchStatusById,
      cursorMs,
      events,
      failureAgentIds,
      officeAgents,
    ],
  );

  const openRequestsByReceiver = useMemo(
    () => officeOpenRequestCounts(events, agentIds),
    [agentIds, events],
  );

  // How much each agent is TALKING, over the graph as displayed. Folded from
  // the same aggregation the node graph draws, so the two cannot disagree
  // about who is busy; only City's building heights read it today.
  const activityById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of aggregateCommGraphEdges(events, agentIds)) {
      const weight = edge.events.length;
      counts.set(edge.agentAId, (counts.get(edge.agentAId) ?? 0) + weight);
      counts.set(edge.agentBId, (counts.get(edge.agentBId) ?? 0) + weight);
    }
    return counts;
  }, [agentIds, events]);

  // HQ, teams and solos, computed ONCE here and handed to the plan, the boards
  // and (in time) the directory panel, so nothing downstream can re-derive a
  // different answer. The previous partition is what freezes a classification
  // for an agent that was already here; it is read off the runtime rather than
  // a ref for the reason the runtime exists - a memo may not touch a ref.
  const partition = useMemo(
    () =>
      partitionOfficePopulation({
        agents: officeAgents,
        statusById,
        previous: runtime.getPartition(),
      }),
    [officeAgents, runtime, statusById],
  );
  useEffect(() => {
    // NOT committed until the input is real. Whatever is committed here
    // becomes the `previous` every later partition is frozen against, so
    // committing a half-replayed one makes incomplete data the permanent
    // arrival classification for this mount: a member replay turns
    // `awaiting` keeps `hotAtArrival: false` forever, while a fresh
    // partition of the same finished input has `true`. Gating the scene sync
    // alone does not help - this commit happens first and poisons the input
    // the sync later reads.
    if (!ready) return;
    runtime.setPartition(partition);
  }, [partition, ready, runtime]);

  // WHAT AUTO WOULD MEASURE, pushed up whenever it changes. Reported even
  // while `ready` is false - it is the thing that MAKES the tile ready - but
  // never before this canvas is eligible and has a box, because a measurement
  // against a tile nobody can see would decide the office by the size of
  // nothing.
  useEffect(() => {
    // WITHDRAWN, not merely unsaid. A tile that stops being eligible - hidden,
    // switched to Graph, unmounted by a re-pick - leaves its last measurement
    // standing unless it says so, and a decision taken from it is a decision
    // about a box that is no longer on screen.
    if (!eligible || measuredBox.width <= 0 || measuredBox.height <= 0) {
      onAutoProbe(null);
      return;
    }
    onAutoProbe({
      input: {
        agents: officeAgents,
        partition,
        // A measurement is of a FRESH office: nobody is seated yet, nobody is
        // owed a seat, and there is no previous layout to keep stable.
        occupancy: NO_OCCUPANCY,
        needsCapacity: NO_CAPACITY_NEEDED,
        activityById,
        viewport: measuredBox,
        previous: null,
      },
      canvas: measuredBox,
    });
  }, [
    activityById,
    eligible,
    measuredBox,
    officeAgents,
    onAutoProbe,
    partition,
  ]);

  /**
   * The last word from a canvas on its way out.
   *
   * Its OWN effect, keyed on nothing that changes, so it fires on unmount and
   * only on unmount - folded into the reporting effect above it would withdraw
   * and re-report on every batch of rows. An unmount is exactly the case where
   * nothing else can speak for this canvas.
   */
  useEffect(() => {
    return () => {
      onAutoProbe(null);
    };
  }, [onAutoProbe]);

  const sceneInput = useMemo<OfficeSceneInput>(
    () => ({
      agents: officeAgents,
      visibleAgentIds: agentIds,
      statusById,
      activityById,
      partition,
      // A PLACEHOLDER, like `clockMs` below: the measured box is written by a
      // ResizeObserver with no render behind it, so the sync effect stamps
      // whatever it currently is. Nothing re-plans because it changed.
      viewport: EMPTY_VIEWPORT,
      pulse,
      pulseKey,
      // Envelope flights are sized to fit inside one playback step, so a faster
      // transport shortens the flight instead of queueing them up behind it.
      stepMs: BASE_STEP_MS / speed,
      cursorMs,
      // A PLACEHOLDER while live: reading a clock during render is impure, so
      // the sync effect below stamps the real time and the frame loop advances
      // it once a second. During replay the cursor's own time is the answer
      // and never ticks.
      clockMs: cursorMs ?? 0,
      openRequestsByReceiver,
      playing,
      reducedMotion,
    }),
    [
      activityById,
      agentIds,
      officeAgents,
      partition,
      playing,
      pulse,
      cursorMs,
      openRequestsByReceiver,
      pulseKey,
      reducedMotion,
      speed,
      statusById,
    ],
  );

  // Host display names for the floor signs. One Query for the whole directory
  // rather than a hook per floor - the count is data, and hooks are not.
  const hostDirectory = useHostDirectoryList();
  const hostNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of hostDirectory.data ?? []) {
      names.set(entry.hostId, entry.label);
    }
    return names;
  }, [hostDirectory.data]);
  useEffect(() => {
    runtime.setHostNames(hostNameById);
    // The signs are painted from this map and nothing on the floor moves when
    // a label arrives, so the frame that shows it has to be asked for.
    runtime.invalidateFrame();
  }, [hostNameById, runtime]);

  // Eligibility drives the DRAWING half: the loop starts and stops with it,
  // and going away releases the floor's bitmap. Declared before the sync
  // effect so a commit that flips both has told the loop before the scene is
  // resumed. Suspension itself is the scene's, and lives here rather than in
  // the frame loop because a host with no 2D context never builds one.
  useEffect(() => {
    runtime.setEligible(eligible);
    if (eligible) return;
    const scene = peekScene();
    if (scene === null || runtime.isSuspended()) return;
    runtime.setSuspended(true);
    scene.suspend();
  }, [eligible, peekScene, runtime]);

  useEffect(() => {
    const viewport = runtime.getViewport();
    const stamped: OfficeSceneInput = {
      ...sceneInput,
      clockMs: sceneInput.cursorMs ?? Date.now(),
      viewport: { width: viewport.width, height: viewport.height },
    };
    // HELD whether or not it is synced. An office that comes back finds the
    // state the rows it slept through led to, which is what makes the return
    // one sync rather than a burst of envelopes nobody watched.
    runtime.setSceneInput(stamped);
    // READY as well as eligible. Until the tile has settled which view this
    // is, there is nothing to plan FOR - and the held input above means the
    // wait costs one sync when it settles, not a replay of everything missed.
    if (!eligible || !ready) return;
    const scene = ensureScene();
    if (runtime.isSuspended()) {
      runtime.setSuspended(false);
      scene.resume(stamped);
    } else {
      scene.sync(stamped);
    }
    // Not every change to the input moves anything. A paused seek that answers
    // an open request takes an envelope off a desk and starts no walk, and
    // within the same minute the idle skip would leave the pile painted.
    runtime.invalidateFrame();
  }, [eligible, ensureScene, ready, runtime, sceneInput]);

  // Pressing Play is an explicit request to follow the action again. Pause
  // leaves the current choice alone; only the next false -> true transition
  // re-arms after a person has taken manual control of the camera.
  useEffect(() => {
    if (playing && !wasPlayingRef.current) runtime.enableAutoPan();
    wasPlayingRef.current = playing;
  }, [playing, runtime]);

  const persistView = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      const camera = runtime.getCamera();
      // A PATCH of the three camera fields. This canvas is mounted under the
      // resolved view's key and knows nothing about which view that is, so it
      // must not be the thing that writes one back.
      onCameraChange({ x: camera.x, y: camera.y, zoom: camera.zoom });
    }, VIEW_PERSIST_DEBOUNCE_MS);
  }, [onCameraChange, runtime]);

  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
    },
    [],
  );

  const zoomAbout = useCallback(
    (factor: number, screenX: number, screenY: number) => {
      const camera = runtime.getCamera();
      const nextZoom = clampZoom(camera.zoom * factor);
      if (nextZoom === camera.zoom) return;
      // Keep the sprite pixel under the cursor under the cursor.
      const ratio = nextZoom / camera.zoom;
      camera.x = screenX - (screenX - camera.x) * ratio;
      camera.y = screenY - (screenY - camera.y) * ratio;
      camera.zoom = nextZoom;
      syncLodBand(nextZoom);
      // The camera is not part of what the idle skip watches - a still floor
      // would keep the old framing painted under the new hit geometry.
      runtime.invalidateFrame();
      persistView();
    },
    [persistView, runtime, syncLodBand],
  );

  const fitToFloor = useCallback(() => {
    // The PROJECTED world, not the layout's tile grid: a projector is free not
    // to be the identity, and on those views the grid is not the shape
    // anything was drawn at.
    const scene = peekScene();
    if (scene === null) return;
    const size = scene.worldSize();
    const viewport = runtime.getViewport();
    if (size.width <= 0 || viewport.width <= 0) return;
    const fitted = fitCamera(size, viewport);
    runtime.getCamera().x = fitted.x;
    runtime.getCamera().y = fitted.y;
    runtime.getCamera().zoom = fitted.zoom;
    syncLodBand(fitted.zoom);
    fittedRef.current = { floor: size, viewport };
    runtime.invalidateFrame();
    persistView();
  }, [peekScene, persistView, runtime, syncLodBand]);

  const handleZoomIn = useCallback(() => {
    runtime.takeManualControl();
    const viewport = runtime.getViewport();
    zoomAbout(ZOOM_BUTTON_FACTOR, viewport.width / 2, viewport.height / 2);
  }, [runtime, zoomAbout]);

  const handleZoomOut = useCallback(() => {
    runtime.takeManualControl();
    const viewport = runtime.getViewport();
    zoomAbout(1 / ZOOM_BUTTON_FACTOR, viewport.width / 2, viewport.height / 2);
  }, [runtime, zoomAbout]);

  const handleFit = useCallback(() => {
    runtime.takeManualControl();
    fitToFloor();
  }, [fitToFloor, runtime]);

  // Sizing the bitmap is the ONLY place device pixels appear outside the draw:
  // everything else works in CSS pixels and lets the transform scale it.
  const applyCanvasSize = useCallback((): void => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    appliedDprRef.current = dpr;
    runtime.setViewport({ width: rect.width, height: rect.height });
    // Mirrored into React as well as the runtime: the runtime's copy is for
    // the frame loop, and this one is what lets the Auto probe below be a
    // reaction to the tile changing size rather than a poll.
    setMeasuredBox((current) =>
      current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height },
    );
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    // Assigning either dimension CLEARS the bitmap, which is exactly the thing
    // the idle skip assumes is still there. Without this a resize of a still
    // floor leaves the tile blank until something happens to move.
    runtime.invalidateFrame();
  }, [runtime]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    applyCanvasSize();
    const observer = new ResizeObserver(applyCanvasSize);
    observer.observe(container);
    // A DEVICE PIXEL RATIO change is invisible to the observer: dragging the
    // window from a 1x display to a 2x one leaves every CSS dimension exactly
    // as it was, so nothing resizes and the bitmap stays at half the density
    // the screen now has - a permanently blurry floor.
    window.addEventListener("resize", applyCanvasSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", applyCanvasSize);
    };
  }, [applyCanvasSize]);

  // Mirrored into the runtime rather than read from props inside the frame
  // loop: the loop is created once and must see the latest values without
  // being torn down and restarted on every playback step.
  useEffect(() => {
    runtime.setPlayback(pulseKey, playing);
  }, [playing, pulseKey, runtime]);

  // The one eligibility signal that is not a context: whether the tile is
  // actually in the epic canvas's viewport. Held in React state, because
  // everything downstream of it - the scene, the sync, the loop - is decided
  // during render from the composed boolean.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // Seeded from the DOM rather than assumed: the observer's first callback
    // is asynchronous, and a tile opened in the foreground should not wait a
    // frame for it.
    setIntersecting(isElementVisible(canvas));
    const observer = new IntersectionObserver((entries) => {
      setIntersecting(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, []);

  /**
   * The three the render loop READS rather than reacts to.
   *
   * `useEffectEvent` exists for exactly this shape: the loop wants each of
   * these at its latest, and none of them is a reason to tear the loop down.
   * Listed as ordinary dependencies they were - an identity change in any one
   * would stop the frames, drop the listeners and RELEASE THE FLOOR'S BITMAP,
   * which is the largest thing the tile holds and the most expensive thing it
   * can rebuild.
   *
   * Measured before changing: across a pan, both lod-band crossings, a resize
   * and a view pick on the real component, all three keep one identity
   * throughout - `syncLodBand` closes over nothing, `peekScene` over `epicId`,
   * and `applyCanvasSize` over `runtime`, which is a `useState` initial value.
   * So no office is losing its floor today. What this removes is the standing
   * hazard: any of those three gaining a dependency that moves would have
   * turned a callback's re-creation into a dropped bitmap, silently and at a
   * distance from the line that caused it.
   *
   * What it must NOT remove is `epicId`. `peekScene` closes over it, so the
   * old array carried it by accident; the array below names it deliberately,
   * because the bitmap this loop owns is one epic's floor.
   */
  const readScene = useEffectEvent((): OfficeScene | null => peekScene());
  const resizeCanvas = useEffectEvent((): void => {
    applyCanvasSize();
  });
  const trackLodBand = useEffectEvent((zoom: number): void => {
    syncLodBand(zoom);
  });
  /**
   * The cascade's revision, READ rather than reacted to.
   *
   * A custom theme repaints every token without changing the mode or the
   * preset, so `resolvedTheme` cannot see it - and these pixels are baked into
   * an offscreen surface, which no cascade repaints for us. So the revision
   * belongs in the static layer's KEY rather than in the loop's dependency
   * array: what a custom palette makes stale is one bitmap, not the frame
   * gate, the listeners or the loop, and rebuilding that bitmap is the whole
   * of the repair. Reacting to it here would spend a full teardown - frames
   * stopped, listeners dropped, the floor released - to fix a repaint.
   */
  const readThemeRevision = useEffectEvent((): number => themeRevision);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = get2dContext(canvas);
    // No 2d context (jsdom): the accessible agent list below is the whole
    // surface, and it works without a single pixel being drawn.
    if (ctx === null) return;

    let raf = 0;
    let last = performance.now();
    let lastClockSecond = -1;
    let pausedAt: number | null = null;
    const gate = new OfficeFrameGate();
    const staticLayer = new OfficeStaticLayer(
      createOfficeStaticSurface,
      OFFICE_STATIC_CHUNK_BUDGET,
    );
    runtime.onInvalidateFrame(() => {
      gate.invalidate();
    });
    // A logo lands asynchronously, and a still floor is the one that would
    // never draw the frame that shows it.
    const stopWatchingLogos = onOfficeLogoReady(() => {
      gate.invalidate();
    });

    // A wall clock only has to be right to the minute, but it must not be
    // right only at mount. Re-syncing the SAME input with a fresh `clockMs`
    // is what advances it: `sync` is idempotent and guarded by the pulse key,
    // so re-supplying a row replays nothing.
    const advanceLiveClock = (scene: OfficeScene): void => {
      const input = runtime.getSceneInput();
      if (input === null || input.cursorMs !== null) return;
      const now = Date.now();
      const second = Math.floor(now / 1000);
      if (second === lastClockSecond) return;
      lastClockSecond = second;
      const stamped = { ...input, clockMs: now };
      scene.sync(stamped);
      // Stored back, not merely synced: the idle skip reads the clock off the
      // runtime to decide whether the minute turned over, and a stamp only the
      // scene knows about leaves it comparing the mount-time value forever.
      runtime.setSceneInput(stamped);
    };

    // Re-fit an unframed tile whenever the floor's size OR the tile's changes -
    // agents arriving after the first frame is the normal case, and the room
    // they land in is the one worth framing; a resized tile is the same floor
    // seen through a different window, and the old framing crops it.
    const applyAutoFit = (floor: OfficeSize, viewport: ScreenSize): void => {
      const fitted = fittedRef.current;
      if (!runtime.isAutoFitEnabled()) return;
      if (floor.width <= 0 || viewport.width <= 0 || viewport.height <= 0) {
        return;
      }
      if (
        floor.width === fitted.floor.width &&
        floor.height === fitted.floor.height &&
        viewport.width === fitted.viewport.width &&
        viewport.height === fitted.viewport.height
      ) {
        return;
      }
      const next = fitCamera(floor, viewport);
      const camera = runtime.getCamera();
      camera.x = next.x;
      camera.y = next.y;
      camera.zoom = next.zoom;
      fittedRef.current = { floor, viewport };
    };

    // One visibility decision per cursor step, exactly like the node graph's:
    // a row whose sender is already on screen moves nothing.
    const requestPlaybackPan = (
      focus: OfficePoint | null,
      viewport: ScreenSize,
    ): void => {
      const key = runtime.getPulseKey();
      if (!runtime.isPlaying() || !runtime.isAutoPanEnabled()) return;
      if (focus === null || key === null) return;
      if (key === autoPannedKeyRef.current) return;
      autoPannedKeyRef.current = key;
      if (isOnScreen(focus, runtime.getCamera(), viewport)) return;
      runtime.requestPan({ focus, zoom: null });
    };

    // The frame clock is the only clock here: a pan is REQUESTED without a
    // start time and gets one from whichever frame picks it up, so a request
    // made while the tile was hidden animates when it comes back rather than
    // arriving already finished.
    const advanceCamera = (now: number, viewport: ScreenSize): void => {
      const camera = runtime.getCamera();
      const requested = runtime.takePanRequest();
      if (requested !== null) {
        runtime.setActivePan(
          panToward({ camera, viewport, request: requested, startedAt: now }),
        );
      }
      const pan = runtime.getActivePan();
      if (pan === null) return;
      const progress = Math.min(1, (now - pan.startedAt) / AUTO_PAN_MS);
      const eased = easeInOut(progress);
      camera.x = pan.fromX + (pan.toX - pan.fromX) * eased;
      camera.y = pan.fromY + (pan.toY - pan.fromY) * eased;
      camera.zoom = pan.fromZoom + (pan.toZoom - pan.fromZoom) * eased;
      if (progress >= 1) runtime.setActivePan(null);
    };

    /**
     * Keeps the open hover card on the thing it points at.
     *
     * What the card points at can move without the pointer moving at all: the
     * agent walks off to the cafeteria, an auto-pan slides the floor under the
     * cursor, or the cursor scrubs to a time before that agent existed. So the
     * pointer's last position is hit-tested against THIS frame - while it
     * still lands on the hovered agent the card follows the character, and
     * once it does not the card closes rather than being left anchored to
     * empty floor. Run AFTER the camera has moved for this frame, so a pan is
     * caught on the frame it happens rather than the one after.
     */
    const followHoverCard = (
      frame: OfficeFrame,
      camera: OfficeCamera,
      scene: OfficeScene,
    ): void => {
      const anchor = hoverAnchorRef.current;
      if (anchor === null) return;
      const rect = followOfficeHover(anchor, frame.hitRegions, camera);
      if (rect === null) {
        hoverAnchorRef.current = null;
        hoverRectRef.current = null;
        runtime.setHoveredAgentId(null);
        setHoverCard(null);
        return;
      }
      if (sameRect(rect, hoverRectRef.current)) return;
      // React state, so only a box that actually moved is worth a render. The
      // "where" is re-read on those same frames: what moves a character's box
      // is exactly what changes where it is.
      hoverRectRef.current = rect;
      setHoverCard({
        agentId: anchor.agentId,
        rect,
        whereabouts: scene.whereabouts(anchor.agentId),
      });
    };

    /**
     * The view's projection, remembered per layout.
     *
     * `painter.projector(layout)` builds a small object with closures in it,
     * and the signage needs one every frame. Keyed on layout identity because
     * that is exactly when a projection can change - a new plan is the only
     * thing that moves an origin or a scale.
     */
    let projectorLayout: OfficeLayout | null = null;
    let projectorCache: OfficeProjector | null = null;
    const projectorFor = (
      layout: OfficeLayout | null,
    ): OfficeProjector | null => {
      if (layout === null) return null;
      if (projectorLayout !== layout) {
        projectorLayout = layout;
        projectorCache = officeView.painter.projector(layout);
      }
      return projectorCache;
    };

    /**
     * The floor as bitmaps, one per 512-pixel chunk of the world the camera
     * has reached, repainted only when the plan's version, its band, the theme
     * or the world's size moves; every other frame this is a dozen
     * `drawImage`s of squares already in hand.
     *
     * NOT baked at overview, and never from the frame's own floor. At lod 0 the
     * floor is a few dozen filled rects covering the view, and baking a whole
     * world's bitmap to blit them would be the largest allocation the office
     * makes. Above it each chunk is painted from the tiles that reach INTO it,
     * asked of the painter once - the frame's floor is culled to the viewport,
     * and a bitmap painted from that would hold whatever happened to be on
     * screen when it was last repainted.
     */
    const bakeFloor = (
      frame: OfficeFrame,
      layout: OfficeLayout | null,
      lod: OfficeLod,
      view: OfficeRect,
    ): ReadonlyArray<OfficeStaticChunkDraw> => {
      if (layout === null) return NO_STATIC_CHUNKS;
      return staticLayer.sync({
        key: {
          staticVersion: staticKeyOf(frame.staticVersion, lod),
          theme: resolvedTheme,
          themeRevision: readThemeRevision(),
          width: frame.size.width,
          height: frame.size.height,
        },
        chunks: planOfficeStaticChunks({
          world: frame.size,
          view,
          lod,
          budget: OFFICE_STATIC_CHUNK_BUDGET,
        }),
        paint: (floorCtx, chunk) => {
          const tiles = officeTileRectOf({
            projector: officeView.painter.projector(layout),
            cols: layout.cols,
            rows: layout.rows,
            rect: chunk,
            bleedPx: OFFICE_PROJECTION_BLEED_PX,
          });
          drawStaticFloor(
            floorCtx,
            officeView.painter.floor(layout, tiles, lod),
            resolvedTheme,
          );
        },
      });
    };

    const step = (now: number): void => {
      // The SIM runs in real time; only the DRAWING is capped, and the whole
      // accumulated slice is what it is ticked with - that is what keeps a
      // walk taking as long as it would at any frame rate.
      const elapsed = gate.elapsed(now - last);
      last = now;
      if (elapsed === null) {
        raf = requestAnimationFrame(step);
        return;
      }
      // The loop only runs while the office is eligible, which is the same
      // condition that builds the scene - but the two are separate effects,
      // so the frame between them draws nothing rather than planning a floor
      // from inside an animation callback.
      const scene = readScene();
      if (scene === null) {
        raf = requestAnimationFrame(step);
        return;
      }
      advanceLiveClock(scene);
      scene.tick(elapsed);
      // A DPR change does not resize anything in CSS pixels, so no resize
      // event is guaranteed to arrive - a browser zoom on a secondary display
      // moves it silently. Checked BEFORE the idle skip: resizing the bitmap
      // is what invalidates the gate, and a still floor would otherwise never
      // reach the check. The compare is two property reads a frame.
      if ((window.devicePixelRatio || 1) !== appliedDprRef.current) {
        resizeCanvas();
      }

      const synced = runtime.getSceneInput();
      const clockMs = synced?.clockMs ?? 0;
      // The band the frame below will be built at, read here because what
      // counts as animating depends on it: a typing screen is a still frame
      // at overview, where a desk is one dot. `advanceCamera` has not run yet
      // and may move the zoom, but every way it does - a pan, an auto-fit -
      // already forces a draw of its own, so a band read one frame early can
      // only mean one extra frame at a band boundary, never a frozen floor.
      const band = officeLodForZoom(runtime.getCamera().zoom);
      const draw = gate.shouldDraw({
        animating: scene.isAnimating(band),
        minute: Math.floor(clockMs / 60_000),
        // PEEKED, not taken: consuming the request here would drop the pan on
        // the floor on exactly the still frames auto-pan exists to move.
        panning: runtime.getActivePan() !== null || runtime.hasPanRequest(),
      });
      if (!draw) {
        raf = requestAnimationFrame(step);
        return;
      }

      const camera = runtime.getCamera();
      const viewport = runtime.getViewport();
      // A plan that GREW the world translates everything in it. Taking the
      // shift and moving the camera by it is what keeps the floor still on
      // screen: without it a building that gained a storey jumps by a storey.
      //
      // Every camera MOVE in flight moves with it too. A pan is aimed at a
      // world point that just slid, and an active one overwrites `camera.x`
      // from its own endpoints on the next frame - so compensating the camera
      // alone would be undone by the pan a frame later.
      const shift = scene.takeShift();
      if (shift !== null) {
        camera.x -= shift.x * camera.zoom;
        camera.y -= shift.y * camera.zoom;
        shiftPendingPan(runtime, shift);
        shiftActivePan(runtime, shift, camera.zoom);
      }
      // THE CAMERA SETTLES FIRST, and the frame is built from where it ended
      // up. A frame is culled to what the camera can see, so a fit or a pan
      // applied after it would be one frame ahead of the world it framed -
      // which on the very first frame is the whole difference between the
      // floor as fitted and the floor as it happened to be persisted.
      applyAutoFit(scene.worldSize(), viewport);
      advanceCamera(now, viewport);
      // SEMANTIC ZOOM. The band decides what a frame even contains - a block
      // map and pips at overview, pixel art otherwise - so it is chosen here,
      // once, and everything below reads it rather than the zoom.
      const lod = officeLodForZoom(camera.zoom);
      // An auto-fit or a playback pan moves the zoom without any handler
      // having touched it, so the chip is synced from the frame that results
      // rather than only from the gestures.
      trackLodBand(camera.zoom);
      const worldRect = worldRectOf(camera, viewport);
      const frame = scene.frame(lod, worldRect);
      runtime.setHitRegions(frame.hitRegions);
      runtime.setEnvelopeRegions(frame.envelopeHitRegions);
      const layout = scene.layout();
      // REQUESTED, not started: `advanceCamera` has already run for this
      // frame, so the move begins on the next one. A playback pan is a 400ms
      // ease, and one frame of it is a pixel.
      requestPlaybackPan(frame.focus, viewport);
      followHoverCard(frame, camera, scene);
      drawOfficeFrame({
        ctx,
        frame,
        staticFloor: bakeFloor(frame, layout, lod, worldRect),
        projector: projectorFor(layout),
        selectedAgentId: runtime.getSelectedAgentId(),
        camera,
        lod,
        viewport,
        dpr: appliedDprRef.current,
        theme: resolvedTheme,
        searchMatchIds: runtime.getSearchMatchIds(),
        nameById: runtime.getNameById(),
        roleClaims: runtime.getRoleClaims(),
        hostNameById: runtime.getHostNames(),
        hoveredAgentId: runtime.getHoveredAgentId(),
        ...frameChrome(layout, synced),
      });
      raf = requestAnimationFrame(step);
    };

    const start = (): void => {
      if (raf !== 0) return;
      if (!runtime.isEligible()) return;
      // Catch the simulation up on a bounded slice of the time spent paused,
      // so the floor resumes looking alive rather than mid-stride.
      const catchUp = officeCatchUpMs(
        pausedAt === null ? 0 : Date.now() - pausedAt,
      );
      pausedAt = null;
      const scene = readScene();
      // Not for a SUSPENDED scene: `resume` is about to settle every walk and
      // flight anyway, so catching one up first is work whose result is thrown
      // away a moment later. The catch-up is for the loop being rebuilt under
      // a live office - a theme flip - where nothing resets the motion.
      if (catchUp > 0 && scene !== null && !runtime.isSuspended()) {
        scene.tick(catchUp);
      }
      last = performance.now();
      gate.resume();
      raf = requestAnimationFrame(step);
    };
    const stop = (): void => {
      if (raf === 0) return;
      cancelAnimationFrame(raf);
      raf = 0;
      pausedAt = Date.now();
    };
    // EVERY way to be invisible arrives as one boolean - a hidden document, a
    // background tab, an unselected tab body, a tile scrolled out of the
    // canvas - and each of them used to be somebody else's listener, or
    // nobody's. What is left here is what the loop itself owns: the frames,
    // and the floor's bitmap.
    //
    // The bitmap goes on the way out because it is the largest thing a hidden
    // office was holding; the scene's own suspension is the other effect's,
    // since a host with no 2D context never reaches this line at all.
    runtime.onEligibilityChange((next) => {
      if (next) {
        gate.invalidate();
        start();
        return;
      }
      stop();
      staticLayer.release();
    });
    start();
    return () => {
      stop();
      stopWatchingLogos();
      runtime.onInvalidateFrame(() => undefined);
      runtime.onEligibilityChange(() => undefined);
      // A floor's worth of pixels is real memory; it goes with the tile.
      staticLayer.release();
    };
    // `epicId` IS a reactive input, and naming it is the point of this array.
    // The loop's whole closure belongs to one epic's scene - the gate, the
    // listeners, and the static layer holding that epic's baked floor - so an
    // epic switched in place has to rebuild it. It used to arrive here only
    // because `peekScene` closes over `epicId` and was listed; dropping that
    // callback dropped the reactivity with it, and a canvas switched from one
    // epic to another kept painting the new office on the old floor.
  }, [epicId, officeView, resolvedTheme, runtime]);

  /**
   * A repainted cascade has to buy ONE frame, or the key above is never read.
   *
   * Putting the revision in the static layer's key says what a rebuild costs;
   * it does not say when anyone looks. `bakeFloor` holds the only `sync` call
   * there is, and the gate returns before it on a still floor - not animating,
   * not settling, same minute, not panning. So a custom palette on an idle
   * office repainted nothing until an agent moved or the clock's minute turned
   * over, which is the common case and was the whole bug.
   *
   * `invalidateFrame` only clears the gate's last-drawn minute, so this stands
   * the idle skip aside for a single frame rather than pinning the loop awake.
   * It is the same rule the gate's own `invalidate` doc states for a resize:
   * the skip's premise is that the canvas still holds the right picture, and a
   * repainted cascade is exactly the case where it no longer does.
   *
   * DECLARED AFTER THE LOOP so the invalidation reaches the LIVE gate. The
   * runtime keeps one mutable listener slot, and the loop's cleanup puts back
   * a no-op; React runs every cleanup before any effect and then effects in
   * declaration order, so on a MODE flip - where the loop is being rebuilt in
   * this same commit - the loop's fresh listener is wired before this fires.
   * Ahead of the loop it would land on the no-op and be dropped, harmlessly
   * but for the wrong reason: the new gate draws its first frame regardless.
   * On a CUSTOM theme, which is what this exists for, the loop does not
   * restart at all and the listener in the slot is the live one throughout.
   *
   * On mount it fires once against a gate that has drawn nothing yet, whose
   * last-drawn minute is already -1, so it asks for a frame that was coming
   * anyway.
   */
  useEffect(() => {
    runtime.invalidateFrame();
  }, [runtime, themeRevision]);

  /** A client position in container screen pixels. */
  const toScreenPoint = useCallback(
    (clientX: number, clientY: number): OfficePoint | null => {
      const container = containerRef.current;
      if (container === null) return null;
      const rect = container.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    },
    [],
  );

  const toSpritePoint = useCallback(
    (clientX: number, clientY: number): OfficePoint | null => {
      const screen = toScreenPoint(clientX, clientY);
      if (screen === null) return null;
      const camera = runtime.getCamera();
      return {
        x: (screen.x - camera.x) / camera.zoom,
        y: (screen.y - camera.y) / camera.zoom,
      };
    },
    [runtime, toScreenPoint],
  );

  // Shared by the canvas and the hover trigger that sits over a character: a
  // press that starts on the trigger is still a press on the floor. The
  // pointer is captured by the CANVAS whichever element took the press, so
  // the move and the release reach the canvas handlers - and a click, if the
  // press never moved, is resolved there by the same hit test as any other.
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      // Manual control is claimed when the drag actually MOVES, not here. A
      // plain click on an agent is not a statement about the camera, and
      // taking control on every press disabled auto-fit for the session.
      const camera = runtime.getCamera();
      dragRef.current = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        cameraX: camera.x,
        cameraY: camera.y,
        moved: false,
      };
      canvas.setPointerCapture(event.pointerId);
    },
    [runtime],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag !== null && drag.pointerId === event.pointerId) {
        const dx = event.clientX - drag.originX;
        const dy = event.clientY - drag.originY;
        if (Math.abs(dx) > CLICK_SLOP_PX || Math.abs(dy) > CLICK_SLOP_PX) {
          drag.moved = true;
          // The gesture has become a pan, which IS a statement about where the
          // camera should be - so the automatic framing steps aside now.
          runtime.takeManualControl();
        }
        runtime.getCamera().x = drag.cameraX + dx;
        runtime.getCamera().y = drag.cameraY + dy;
        runtime.invalidateFrame();
        return;
      }
      const point = toSpritePoint(event.clientX, event.clientY);
      const scene = peekScene();
      const overEnvelope =
        point !== null &&
        scene !== null &&
        envelopeEdgeFor(runtime, scene, point) !== null;
      const region =
        point === null ? null : hitRegionFor(runtime.getHitRegions(), point);
      const screen = toScreenPoint(event.clientX, event.clientY);
      const target = hoverTargetFor({
        region,
        camera: runtime.getCamera(),
        scene,
      });
      // Mirrored for the DRAW, which needs it to keep an away agent's name tag
      // while the pointer is on it; the card itself is React state.
      runtime.setHoveredAgentId(target === null ? null : target.agentId);
      hoverAnchorRef.current =
        target === null || screen === null
          ? null
          : { agentId: target.agentId, screenX: screen.x, screenY: screen.y };
      hoverRectRef.current = target === null ? null : target.rect;
      setHoverCard(target);
      // An envelope is clickable too, so it earns the same cursor even where
      // it is flying over open floor with no desk under it.
      event.currentTarget.style.cursor =
        region === null && !overEnvelope ? "default" : "pointer";
    },
    [peekScene, runtime, toScreenPoint, toSpritePoint],
  );

  // On the CONTAINER, because the hover trigger is laid over the character and
  // takes the pointer from the canvas while it is there. A move inside the
  // trigger never reaches the canvas handler, but the frame loop still needs
  // the pointer's true position to decide whether a walking character is
  // still under it - so the anchor is kept current from whichever element
  // has the pointer.
  const trackHoverPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const anchor = hoverAnchorRef.current;
      if (anchor === null) return;
      const screen = toScreenPoint(event.clientX, event.clientY);
      if (screen === null) return;
      hoverAnchorRef.current = {
        agentId: anchor.agentId,
        screenX: screen.x,
        screenY: screen.y,
      };
    },
    [toScreenPoint],
  );

  const clearHover = useCallback(() => {
    hoverAnchorRef.current = null;
    hoverRectRef.current = null;
    runtime.setHoveredAgentId(null);
    setHoverCard(null);
  }, [runtime]);

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      // The hover card's trigger is a transparent element laid OVER the canvas,
      // so opening it moves the pointer from the canvas onto the trigger
      // without the pointer having moved at all. That fires `pointerleave`
      // here, and clearing the hover on it closed the card the instant it
      // opened. A leave into our own container is not leaving the floor.
      const related = event.relatedTarget;
      const container = containerRef.current;
      if (
        container !== null &&
        related instanceof Node &&
        container.contains(related)
      ) {
        return;
      }
      clearHover();
    },
    [clearHover],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (drag.moved) {
        persistView();
        return;
      }
      const point = toSpritePoint(event.clientX, event.clientY);
      if (point === null) return;
      // Envelopes first: a message in flight over a desk is drawn on top of
      // it, so it has to be the thing a click on those pixels resolves to.
      const scene = peekScene();
      if (scene === null) return;
      const edgeId = envelopeEdgeFor(runtime, scene, point);
      if (edgeId !== null) {
        setSelectedDetail({ kind: "pair", edgeId });
        return;
      }
      // Answered from the last PAINTED frame, like the hover and the envelope
      // above: the scene has ticked since, and on a floor with walkers the two
      // can name different agents for the same pixels. The live scene is only
      // the fallback before a first frame exists.
      const agentId = runtime.hasDrawnFrame()
        ? (hitRegionFor(runtime.getHitRegions(), point)?.agentId ?? null)
        : scene.hitTest(point);
      if (agentId !== null) setSelectedAgentId(agentId);
    },
    [peekScene, persistView, runtime, setSelectedAgentId, toSpritePoint],
  );

  // A cancelled gesture is not a click: the browser took the pointer (a touch
  // became a scroll, a window lost focus mid-press), and the coordinates it
  // reports are wherever that happened, not somewhere the person chose.
  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (drag.moved) persistView();
    },
    [persistView],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const camera = runtime.getCamera();
      camera.x -= dx;
      camera.y -= dy;
      // The camera is not part of what the idle skip watches, so a still floor
      // would keep the old framing painted under the new hit geometry.
      runtime.invalidateFrame();
      persistView();
    },
    [persistView, runtime],
  );

  // A native listener, because a passive React `onWheel` cannot call
  // `preventDefault` - and without it the epic canvas scrolls under the floor.
  // On the CONTAINER rather than the canvas: the hover trigger is a sibling
  // element over a character, and a wheel that lands on it is still a wheel
  // over the floor.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      runtime.takeManualControl();
      // THE WHEEL PANS. An office is a place with a plan, and the gesture for
      // moving around a map is scrolling it; zooming on a bare wheel made
      // every scroll past the tile change how much office there was.
      //
      // A pinch arrives as ctrl+wheel whether or not a ctrl key exists, and
      // the mod-wheel a trackpad user reaches for means the same thing - so
      // both are the zoom, about the cursor, and nothing else is.
      if (!event.ctrlKey && !event.metaKey) {
        panBy(event.deltaX, event.deltaY);
        return;
      }
      const rect = container.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY / 300);
      zoomAbout(factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, [panBy, runtime, zoomAbout]);

  // A double-click is the one gesture that reads as "closer, here" in every
  // map surface; the floor had no answer to it at all.
  //
  // Typed on `HTMLElement`, not the canvas: the agent hit target is a sibling
  // element covering part of the floor, and it hands the same gesture here
  // rather than swallowing it. Only the cursor position is read, so the
  // element it came from does not matter.
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const screen = toScreenPoint(event.clientX, event.clientY);
      if (screen === null) return;
      runtime.takeManualControl();
      zoomAbout(ZOOM_BUTTON_FACTOR, screen.x, screen.y);
    },
    [runtime, toScreenPoint, zoomAbout],
  );

  /**
   * The keyboard route around the floor.
   *
   * The canvas is the focusable element, so every key here is handled only
   * once something inside the office has focus - the sr-only agent list is in
   * the same container and keeps its own tab order.
   */
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      const viewport = runtime.getViewport();
      const center = { x: viewport.width / 2, y: viewport.height / 2 };
      switch (event.key) {
        case "ArrowLeft":
          runtime.takeManualControl();
          panBy(-KEY_PAN_PX, 0);
          break;
        case "ArrowRight":
          runtime.takeManualControl();
          panBy(KEY_PAN_PX, 0);
          break;
        case "ArrowUp":
          runtime.takeManualControl();
          panBy(0, -KEY_PAN_PX);
          break;
        case "ArrowDown":
          runtime.takeManualControl();
          panBy(0, KEY_PAN_PX);
          break;
        // `=` unshifted is what most keyboards put `+` on, and a person
        // pressing either means the same thing.
        case "+":
        case "=":
          runtime.takeManualControl();
          zoomAbout(ZOOM_BUTTON_FACTOR, center.x, center.y);
          break;
        case "-":
          runtime.takeManualControl();
          zoomAbout(1 / ZOOM_BUTTON_FACTOR, center.x, center.y);
          break;
        case "f":
        case "F":
          runtime.takeManualControl();
          fitToFloor();
          break;
        // Back to one sprite pixel per screen pixel, about the CENTRE of the
        // tile - so whatever was in the middle of the floor is still in the
        // middle of it, rather than the office jumping to its own origin.
        case "0":
          runtime.takeManualControl();
          zoomAbout(1 / runtime.getCamera().zoom, center.x, center.y);
          break;
        default:
          return;
      }
      // Only for a key this actually handled: the default above returns first,
      // so typing anywhere over the floor still reaches whatever owns it.
      event.preventDefault();
    },
    [fitToFloor, panBy, runtime, zoomAbout],
  );

  const visibleAgents = useMemo(
    () => agents.filter((agent) => agentIds.has(agent.id)),
    [agentIds, agents],
  );

  // The same aggregation the node graph draws its edges from. The office draws
  // no edges, but an envelope click opens a PAIR thread, and that thread is
  // this pair's folded history - resolved here so both modes open the identical
  // panel on the identical rows.
  const aggregated = useMemo(
    () => aggregateCommGraphEdges(events, agentIds),
    [agentIds, events],
  );
  const selectedEdge =
    selectedEdgeId === null
      ? null
      : (aggregated.find((edge) => edge.id === selectedEdgeId) ?? null);

  // Resolved against the VISIBLE set, not every agent the epic ever had: the
  // floor is drawn as of the cursor, and finding a card's subject among agents
  // that are not on it is how the card outlives the character it describes.
  const hoveredAgent =
    hoverCard === null
      ? null
      : (visibleAgents.find((agent) => agent.id === hoverCard.agentId) ?? null);

  // The tile's Find surface, on the same adapter contract the node graph
  // registers. It is registered by whichever renderer is mounted, so search is
  // never silently absent in one mode; the office answers the same four
  // renderer calls in its own coordinate space.
  useEffect(() => {
    runtime.setAgents(visibleAgents);
  }, [runtime, visibleAgents]);
  const findAdapter = useMemo(
    () =>
      createCommGraphFindAdapter({
        tileInstanceId,
        renderer: {
          getNodes: () =>
            runtime.getAgents().map((agent) => ({
              id: agent.id,
              name: agent.name,
            })),
          showMatches: (agentIdsToShow) => {
            runtime.setSearchMatchIds(agentIdsToShow);
          },
          frameMatches: (agentIdsToFrame) => {
            const bounds = spriteBoundsFor(
              runtime.getHitRegions(),
              agentIdsToFrame,
            );
            const viewport = runtime.getViewport();
            if (bounds === null || viewport.width <= 0) return;
            runtime.takeManualControl();
            const fitted = fitCamera(
              { width: bounds.width, height: bounds.height },
              viewport,
            );
            runtime.requestPan({
              focus: rectCenter(bounds),
              // Searching may zoom OUT to hold every match, but one nearby
              // result must not unexpectedly magnify the floor.
              zoom: Math.min(fitted.zoom, runtime.getCamera().zoom),
            });
          },
          focusMatch: (agentId) => {
            const bounds = spriteBoundsFor(
              runtime.getHitRegions(),
              new Set([agentId]),
            );
            const viewport = runtime.getViewport();
            // Selecting is half the answer: the panel is where a match stops
            // being a name on a floor and becomes something you can read.
            setSelectedAgentId(agentId);
            if (bounds === null || viewport.width <= 0) return;
            runtime.takeManualControl();
            runtime.requestPan({ focus: rectCenter(bounds), zoom: null });
          },
          clear: () => {
            runtime.setSearchMatchIds(EMPTY_MATCH_IDS);
          },
        },
      }),
    [runtime, setSelectedAgentId, tileInstanceId],
  );
  useRegisterTileFindAdapter(findAdapter);

  const openAgentById = useCommGraphOpenAgentById(agents, onOpenAgent);
  const closePanel = useCallback(() => setSelectedDetail(null), []);

  /**
   * A directory row names somebody who may be nowhere near the viewport, so
   * the camera is aimed from the SEAT BOOK (`scene.locate`) rather than from
   * the last frame, which only knows what it drew.
   */
  const handleDirectorySelect = useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId);
      const scene = peekScene();
      if (scene === null) return;
      const box = scene.locate(agentId);
      if (box === null) return;
      // Aiming the camera by hand is a statement about where it should be, the
      // same as a drag - Find's own row does exactly this.
      runtime.takeManualControl();
      runtime.requestPan({ focus: rectCenter(box), zoom: null });
    },
    [peekScene, runtime, setSelectedAgentId],
  );

  const handleDirectoryHover = useCallback(
    (agentId: string | null) => {
      // The draw keeps an away agent's name tag while it is hovered, so a row
      // under the pointer lights its character up on the floor.
      runtime.setHoveredAgentId(agentId);
    },
    [runtime],
  );

  const hideDirectory = useCallback(() => {
    setDirectoryOpen(false);
  }, [setDirectoryOpen]);

  const toggleDirectory = useCallback(() => {
    setDirectoryOpen(!directoryOpen);
  }, [directoryOpen, setDirectoryOpen]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0">
      {/*
        RESERVED SPACE, before the canvas and before any panel: the directory
        is read WHILE the floor is, so it takes width rather than covering it -
        and taking width is also what makes the canvas box Auto measures the
        box the office really gets.
      */}
      {!directoryOpen ? null : (
        <OfficeDirectoryPanel
          partition={partition}
          visibleAgentIds={agentIds}
          statusById={statusById}
          nameById={nameById}
          hostNameById={hostNameById}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleDirectorySelect}
          onHoverAgent={handleDirectoryHover}
          onClose={hideDirectory}
        />
      )}
      <div
        ref={containerRef}
        className="relative h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-testid="comm-graph-office-canvas"
        onPointerMove={trackHoverPointer}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          // The camera gestures live on the CANVAS, never on the wrapper. The
          // wrapper is also the parent of every overlay control, and a
          // pointerdown there took pointer capture - which retargets the
          // following `click` to the capturing element, so the mode toggle's
          // own button never saw its click at all.
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          // FOCUSABLE, so the camera has a keyboard route at all: arrows pan,
          // `+`/`-` zoom, `F` fits and `0` returns to 1x. Everything a pointer
          // can do to the framing, a keyboard can now do too.
          tabIndex={0}
          // Nearest-neighbour scaling is what makes this pixel art rather than
          // a blurry upscale; the draw disables smoothing on its side too.
          style={{ imageRendering: "pixelated" }}
          role="img"
          aria-label="Office view of the communication graph"
        />
        {/*
          The mode toggle is passed in already positioned for this row by the
          tile - it pins itself to the corner in the node graph, which has no
          row to sit in.
        */}
        <OfficeChromeRow
          directoryOpen={directoryOpen}
          onToggleDirectory={toggleDirectory}
          viewPicker={viewPicker}
          modeToggle={modeToggle}
        />
        {/*
          A detached cursor has to be VISIBLE on the floor. Scrubbing back
          changes little here - the same people sit at the same desks, only
          their screens go dark and later arrivals vanish - so without a sign
          the past reads as a live floor that stopped moving. The chip names
          the moment being shown; the transport bar below owns moving it.
        */}
        <OfficeCursorChip cursorMs={cursorMs} playing={playing} />
        {hoverCard === null || hoveredAgent === null ? null : (
          <OfficeAgentHover
            epicId={epicId}
            agentId={hoveredAgent.id}
            name={hoveredAgent.name}
            screenRect={hoverCard.rect}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            roleClaims={claimsOf(roleClaimsByAgentId, hoveredAgent.id)}
            extraContent={
              <OfficeHoverSupplement
                status={statusById.get(hoveredAgent.id) ?? "idle"}
                modelTier={officeModelTier(hoveredAgent.model)}
                // Asked of the LIVE scene as the card re-renders, which it does
                // every time the character it points at moves - so "at their
                // desk" becomes "Kitchen" on the frame they get up.
                whereabouts={hoverCard.whereabouts}
              />
            }
            onSelect={setSelectedAgentId}
            onLeave={clearHover}
          />
        )}
        <OfficeLegend />
        {/*
          The keyboard and assistive-tech route to every character on the floor,
          and the only handle a test has on a canvas. Same select handler as the
          pointer, so the two cannot open different things.
        */}
        <ul className="sr-only">
          {visibleAgents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                data-testid={`comm-graph-office-agent-${agent.id}`}
                aria-label={`Open ${agent.name}`}
                onClick={() => setSelectedAgentId(agent.id)}
              >
                {agent.name}
              </button>
            </li>
          ))}
        </ul>
        <div
          className={cn(
            "absolute bottom-2 left-2 z-10 flex flex-col items-start gap-1",
            // Capped against the tile: the auto chip is a sentence, and a
            // sentence has no business being wider than the office it is
            // explaining.
            "max-w-[min(100%,24rem)]",
          )}
        >
          {autoChip}
          <OfficeLodChip lod={lodBand} />
          <div
            className={cn(
              "flex flex-col gap-0.5",
              "rounded-md border border-border bg-popover p-0.5 shadow-xs",
            )}
          >
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Zoom in"
              data-testid="comm-graph-office-zoom-in"
              onClick={handleZoomIn}
            >
              <Plus aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Zoom out"
              data-testid="comm-graph-office-zoom-out"
              onClick={handleZoomOut}
            >
              <Minus aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Fit the office floor"
              data-testid="comm-graph-office-fit"
              onClick={handleFit}
            >
              <Maximize aria-hidden />
            </Button>
          </div>
        </div>
      </div>
      {selectedEdge === null ? null : (
        <CommGraphThreadPanel
          key={selectedEdge.id}
          edge={selectedEdge}
          epicId={epicId}
          agentNames={nameById}
          initialHistoryCaughtUp={initialHistoryCaughtUp}
          canOpenAgentForEvent={canOpenAgentForEvent}
          canJump={canJump}
          onJump={onJump}
          canJumpToSender={canJumpToSender}
          onJumpToSender={onJumpToSender}
          canJumpToCreated={canJumpToCreated}
          onJumpToCreated={onJumpToCreated}
          onOpenAgentId={openAgentById}
          onClose={closePanel}
        />
      )}
      <CommGraphAgentDetailSurface
        agentId={selectedAgentId}
        // As of the cursor, like the floor: a panel opened live and then
        // scrubbed to before its agent existed has nothing to show for it.
        agents={visibleAgents}
        agentNames={nameById}
        events={events}
        epicId={epicId}
        initialHistoryCaughtUp={initialHistoryCaughtUp}
        canOpenAgentForEvent={canOpenAgentForEvent}
        canJump={canJump}
        onJump={onJump}
        canJumpToSender={canJumpToSender}
        onJumpToSender={onJumpToSender}
        canJumpToCreated={canJumpToCreated}
        onJumpToCreated={onJumpToCreated}
        onOpenAgent={onOpenAgent}
        onClose={closePanel}
      />
    </div>
  );
}
