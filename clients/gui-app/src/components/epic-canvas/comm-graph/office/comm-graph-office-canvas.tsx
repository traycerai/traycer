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
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { useEpicAgentActivityTiers } from "@/lib/epic-selectors";
import { NotificationIndicatorsContext } from "@/components/notifications/notification-indicator-context";
import { attentionTone } from "@/components/notifications/notification-indicator-tones";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { selectNotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import {
  useCommGraphCursor,
  useCommGraphSpeed,
} from "@/stores/epics/comm-graph-timeline-store";
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
import { OfficeAgentHover } from "@/components/epic-canvas/comm-graph/office/office-agent-hover";
import { OfficeHoverSupplement } from "@/components/epic-canvas/comm-graph/office/office-hover-supplement";
import { OfficeLegend } from "@/components/epic-canvas/comm-graph/office/office-legend";
import {
  createOfficeStaticSurface,
  officeBakesIntoStaticFloor,
  OfficeStaticLayer,
} from "@/components/epic-canvas/comm-graph/office/office-static-layer";
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
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
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
  officeAgentStatuses,
  officeOpenRequestCounts,
} from "@/lib/comm-graph/office/office-status";
import { officeModelTier } from "@/lib/comm-graph/office/office-model-tier";
import { officeClockAngles } from "@/lib/comm-graph/office/office-clock";
import { officeFloorName } from "@/lib/comm-graph/office/office-floor-name";
import { officeFlagKind } from "@/components/epic-canvas/comm-graph/office/office-flag-kind";
import {
  layoutNameTags,
  NAME_TAG_LINE_HEIGHT,
  type OfficeNameTagCandidate,
} from "@/components/epic-canvas/comm-graph/office/office-name-tags";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_LOGO_SIZE,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeDrawable,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeEnvelopeHitRegion,
  type OfficeHitRegion,
  type OfficeLayout,
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSize,
  type OfficeTheme,
} from "@/lib/comm-graph/office/office-types";

/**
 * Screen pixels per sprite pixel. The floor is drawn at integer-ish scales so
 * the pixel art stays square; the bounds are what keeps a one-agent room from
 * filling the tile with a single desk and a fifty-agent floor from vanishing.
 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
/** Zoom levels the fit control may land on - whole-ish steps keep pixels crisp. */
const FIT_ZOOM_STEPS: ReadonlyArray<number> = [1, 1.5, 2, 3, 4, 5, 6];
/** Screen-pixel margin left around the floor when fitting. */
const FIT_PADDING = 24;
const ZOOM_BUTTON_FACTOR = 1.25;
const AUTO_PAN_MS = 250;
/** Pointer travel that turns a click into a drag. */
const CLICK_SLOP_PX = 4;
/** Coalesces a pan/zoom gesture into one persisted view write. */
const VIEW_PERSIST_DEBOUNCE_MS = 150;
const LABEL_FONT_PX = 10;
const HOVER_LABEL_FONT_PX = 11;
const MONOSPACE_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace";
/** The name-tag font, prebuilt: the width cache keys on text alone only
 * because this never varies. */
const LABEL_FONT = `${LABEL_FONT_PX}px ${MONOSPACE_STACK}`;
const SIGN_FONT_PX = 10;
const SIGN_PADDING_X = 4;
const SIGN_PADDING_Y = 2;
const SIGN_PLATE_RADIUS = 3;
const SIGN_LETTER_SPACING = "0.08em";
const CLOCK_HOUR_HAND = 3;
const CLOCK_MINUTE_HAND = 4;
const CLOCK_HUB_RADIUS = 1.5;
const DARK_LABEL_BACKING = "rgba(0, 0, 0, 0.85)";
const LIGHT_LABEL_BACKING = "rgba(255, 255, 255, 0.85)";

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
 * screen pixels. Recomputed on pointer move rather than per frame: the camera
 * does not move under a stationary pointer, and a drag clears the hover.
 */
interface OfficeHoverTarget {
  readonly agentId: string;
  /** The character's box in container screen pixels; the trigger's geometry. */
  readonly rect: OfficeRect;
}

/**
 * What the open hover card was measured against, so the frame loop can tell
 * when that measurement has stopped being true without a pointer event.
 *
 * The card's screen rect is computed on a pointermove and never again, but the
 * thing it points at keeps moving: the character walks off to lunch, or an
 * auto-pan slides the whole floor under a stationary cursor. Either leaves the
 * trigger anchored over empty floor. Both are a change in exactly these five
 * numbers, which is what makes them the thing to remember.
 */
interface HoverAnchor {
  readonly agentId: string;
  /** The hit region's box in sprite space, as it was when the pointer landed. */
  readonly rect: OfficeRect;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly zoom: number;
}

function sameRect(a: OfficeRect, b: OfficeRect): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** Whether the hovered box is still exactly where the card was measured. */
function hoverAnchorHolds(
  anchor: HoverAnchor,
  regions: ReadonlyArray<OfficeHitRegion>,
  camera: OfficeCamera,
): boolean {
  if (
    camera.x !== anchor.cameraX ||
    camera.y !== anchor.cameraY ||
    camera.zoom !== anchor.zoom
  ) {
    return false;
  }
  return regions.some(
    (region) =>
      region.agentId === anchor.agentId && sameRect(region.rect, anchor.rect),
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
   */
  readonly getSceneInput: () => OfficeSceneInput | null;
  readonly setSceneInput: (next: OfficeSceneInput) => void;
  readonly getHoveredAgentId: () => string | null;
  readonly setHoveredAgentId: (next: string | null) => void;
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
  let hostNames: ReadonlyMap<string, string> = new Map();
  let nameById: ReadonlyMap<string, string> = new Map();
  let hoveredAgentId: string | null = null;
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
    getHoveredAgentId: () => hoveredAgentId,
    setHoveredAgentId: (next) => {
      if (next === hoveredAgentId) return;
      hoveredAgentId = next;
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
 * The largest listed zoom at which the whole floor fits with padding, centered.
 * Falls back to the smallest step when nothing fits: an overflowing floor the
 * user can zoom out of beats a blank one.
 */
function fitCamera(floor: OfficeSize, viewport: ScreenSize): OfficeCamera {
  const availableWidth = Math.max(1, viewport.width - FIT_PADDING * 2);
  const availableHeight = Math.max(1, viewport.height - FIT_PADDING * 2);
  let zoom = FIT_ZOOM_STEPS[0];
  for (const step of FIT_ZOOM_STEPS) {
    if (
      floor.width * step <= availableWidth &&
      floor.height * step <= availableHeight
    ) {
      zoom = step;
    }
  }
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

function hitRegionFor(
  regions: ReadonlyArray<OfficeHitRegion>,
  point: OfficePoint,
): OfficeHitRegion | null {
  // Last match wins: `hitRegions` follows the frame's own draw order, so the
  // character painted on top of another is the one the pointer is over.
  let found: OfficeHitRegion | null = null;
  for (const region of regions) {
    if (
      point.x >= region.rect.x &&
      point.x <= region.rect.x + region.rect.width &&
      point.y >= region.rect.y &&
      point.y <= region.rect.y + region.rect.height
    ) {
      found = region;
    }
  }
  return found;
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
  ctx.font = `${fontPx}px ${MONOSPACE_STACK}`;
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
  readonly viewport: ScreenSize;
  readonly dpr: number;
  readonly theme: OfficeTheme;
  /** Agents the tile's Find session currently matches; empty when idle. */
  readonly searchMatchIds: ReadonlySet<string>;
  readonly nameById: ReadonlyMap<string, string>;
  /** One per host. A single-floor building names nothing - there is no choice to explain. */
  readonly floors: ReadonlyArray<OfficeFloor>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly awayAgentIds: ReadonlySet<string>;
  readonly hoveredAgentId: string | null;
  /**
   * The floor, already painted in sprite space. `null` where no offscreen
   * surface could be made, in which case the floor is drawn tile by tile as it
   * always was - the fast path is an optimization, never a requirement.
   */
  readonly staticFloor: HTMLCanvasElement | null;
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
  readonly floors: ReadonlyArray<OfficeFloor>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly color: string;
  readonly backing: string;
}): void {
  const { backing, camera, color, ctx, floors, hostNameById } = args;
  if (floors.length <= 1) return;
  for (const floor of floors) {
    const anchor = floor.stairsTile ?? {
      col: floor.bounds.col,
      row: floor.bounds.row,
    };
    drawScreenLabel(ctx, {
      text: officeFloorName(floor.hostId, hostNameById),
      screenX:
        (anchor.col * OFFICE_TILE + OFFICE_TILE) * camera.zoom + camera.x,
      screenY: anchor.row * OFFICE_TILE * camera.zoom + camera.y - 2,
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
  ctx.font = `bold ${SIGN_FONT_PX}px ${MONOSPACE_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = SIGN_LETTER_SPACING;
  const width = ctx.measureText(text).width + SIGN_PADDING_X * 2;
  const height = SIGN_FONT_PX + SIGN_PADDING_Y * 2;
  const left = screenX - width / 2;
  const top = screenY - SIGN_FONT_PX - SIGN_PADDING_Y;
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

/**
 * The agent a name tag belongs to, or `null` when it belongs to no character.
 *
 * The scene emits a tag directly under its character and gives neither an id,
 * so they are matched by GEOMETRY: same horizontal centre, and the tag's
 * baseline within one tile below the character's feet. An empty desk's own
 * plate label matches nothing - correctly, since a desk is not away.
 */
function nameTagOwner(
  label: OfficeLabelDrawable,
  hitRegions: ReadonlyArray<OfficeHitRegion>,
): string | null {
  for (const region of hitRegions) {
    if (region.rect.x + region.rect.width / 2 !== label.x) continue;
    const feet = region.rect.y + region.rect.height;
    if (label.y <= feet || label.y - feet > OFFICE_TILE) continue;
    return region.agentId;
  }
  return null;
}

/**
 * Agents whose character is not on its own chair tile - walking, on an errand,
 * queueing, playing.
 *
 * Derived from the character hit region rather than from any scene internal:
 * a region's bottom edge sits exactly on the bottom of the tile the character
 * stands on, so the tile falls out of the rect with no offset to keep in step.
 */
type OfficeLabelDrawable = Extract<OfficeDrawable, { kind: "label" }>;
type OfficeClockDrawable = Extract<OfficeDrawable, { kind: "clock" }>;

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
    if (drawable.kind !== "sprite") continue;
    drawAnchoredSprite(ctx, drawable, "top-left", theme);
  }
}

/** Reused across frames; see the scratch note above. */
const awayScratch = new Set<string>();

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

function awayAgentIdsIn(
  frame: OfficeFrame,
  layout: OfficeLayout,
): ReadonlySet<string> {
  const away = awayScratch;
  away.clear();
  for (const region of frame.hitRegions) {
    const desk = layout.desks.get(region.agentId);
    if (desk === undefined) continue;
    if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
    const col = region.rect.x / OFFICE_TILE;
    const row = (region.rect.y + region.rect.height) / OFFICE_TILE - 1;
    if (col !== desk.chairTile.col || row !== desk.chairTile.row) {
      away.add(region.agentId);
    }
  }
  return away;
}

/**
 * Cabin, area and pod names. They are the only `bright` labels the scene
 * emits, which is what makes the tone a reliable test for "this is signage".
 */
function drawSignLabels(
  ctx: CanvasRenderingContext2D,
  labels: ReadonlyArray<OfficeLabelDrawable>,
  camera: OfficeCamera,
  palette: OfficePalette,
): void {
  for (const label of labels) {
    if (label.tone !== "bright") continue;
    drawSignPlate(ctx, {
      text: label.text.toUpperCase(),
      screenX: label.x * camera.zoom + camera.x,
      screenY: label.y * camera.zoom + camera.y,
      palette,
    });
  }
}

/**
 * Agent name tags, thinned and de-overlapped.
 *
 * An agent AWAY from its desk keeps its tag only while hovered: a walking
 * character is already where the eye is, and its tag is what collides with
 * everyone else's the moment a group gathers. What survives that is then
 * placed by {@link layoutNameTags}, which moves or drops a tag rather than
 * letting two print through each other.
 */
function drawNameTags(args: {
  readonly ctx: CanvasRenderingContext2D;
  readonly labels: ReadonlyArray<OfficeLabelDrawable>;
  readonly camera: OfficeCamera;
  readonly palette: OfficePalette;
  readonly backings: Readonly<Record<OfficeLabelTone, string>>;
  readonly hitRegions: ReadonlyArray<OfficeHitRegion>;
  readonly awayAgentIds: ReadonlySet<string>;
  readonly hoveredAgentId: string | null;
}): void {
  const {
    awayAgentIds,
    backings,
    camera,
    ctx,
    hitRegions,
    hoveredAgentId,
    labels,
    palette,
  } = args;
  const candidates = resetScratch(nameTagScratch);
  ctx.font = LABEL_FONT;
  for (const label of labels) {
    if (label.tone === "bright") continue;
    const owner = nameTagOwner(label, hitRegions);
    if (owner !== null && awayAgentIds.has(owner) && owner !== hoveredAgentId) {
      continue;
    }
    candidates.push({
      text: label.text,
      tone: label.tone,
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
  }
}

function drawOfficeFrame(args: DrawFrameArgs): void {
  const {
    camera,
    ctx,
    awayAgentIds,
    dpr,
    floors,
    frame,
    hostNameById,
    hoveredAgentId,
    nameById,
    searchMatchIds,
    staticFloor,
    theme,
    viewport,
  } = args;
  const palette = officePalette(theme);
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
  // tile-by-tile walk it has always been.
  const layer = {
    ctx,
    theme,
    palette,
    labels,
    clocks,
    sprites: "draw",
  } as const;
  if (staticFloor === null) {
    drawDrawableLayer({ ...layer, drawables: frame.floor, anchor: "top-left" });
  } else {
    ctx.drawImage(staticFloor, 0, 0);
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
  drawDrawableLayer({ ...layer, drawables: frame.props, anchor: "top-left" });
  drawDrawableLayer({ ...layer, drawables: frame.actors, anchor: "top-left" });
  // Bubbles and sparkles hang over whatever they belong to, so the scene
  // anchors them at their bottom centre rather than a corner.
  drawDrawableLayer({
    ...layer,
    drawables: frame.overlay,
    anchor: "bottom-center",
  });

  for (const clock of clocks) drawClockHands(ctx, clock, palette.ink);

  // Back to screen space for text: a name magnified by the camera would be a
  // blur at zoom 4 and unreadable at zoom 0.5. The palette owns these colors
  // rather than `--foreground`, because they have to contrast with the ROOM,
  // which is the palette's own background and not the app's.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  drawSignLabels(ctx, labels, camera, palette);
  drawNameTags({
    ctx,
    labels,
    camera,
    palette,
    backings: labelBackings,
    hitRegions: frame.hitRegions,
    awayAgentIds,
    hoveredAgentId,
  });

  drawFloorSigns({
    ctx,
    camera,
    floors,
    hostNameById,
    color: palette.text,
    backing: labelBackings.default,
  });
  if (searchMatchIds.size > 0) {
    for (const region of frame.hitRegions) {
      if (!searchMatchIds.has(region.agentId)) continue;
      const left = region.rect.x * camera.zoom + camera.x;
      const top = region.rect.y * camera.zoom + camera.y;
      ctx.save();
      ctx.strokeStyle = palette.bright;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        left,
        top,
        region.rect.width * camera.zoom,
        region.rect.height * camera.zoom,
      );
      ctx.restore();
      const name = nameById.get(region.agentId);
      if (name === undefined) continue;
      drawScreenLabel(ctx, {
        text: name,
        screenX: left + (region.rect.width * camera.zoom) / 2,
        screenY: top - HOVER_LABEL_FONT_PX / 2,
        fontPx: HOVER_LABEL_FONT_PX,
        color: palette.text,
        backing: labelBackings.default,
        alpha: 1,
      });
    }
  }
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

export type CommGraphOfficeCanvasProps = CommGraphCanvasProps;

export function CommGraphOfficeCanvas(props: CommGraphOfficeCanvasProps) {
  const {
    agentIds,
    agents,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    canOpenAgentForEvent,
    epicId,
    events,
    initialHistoryCaughtUp,
    modeToggle,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgent,
    onViewChange,
    playing,
    pulse,
    pulseKey,
    tileInstanceId,
    view,
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
  const hoverAnchorRef = useRef<HoverAnchor | null>(null);
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

  const { resolvedTheme } = useResolvedTheme();
  const speed = useCommGraphSpeed(epicId);
  // The cursor's capture time decides which agents read as archived AS OF the
  // floor being shown, and what the wall clock says during replay.
  const cursorMs = useCommGraphCursor(epicId)?.timestamp ?? null;
  const activityTiers = useEpicAgentActivityTiers();
  const reducedMotion = usePrefersReducedMotion();

  // ONE scene per epic, kept across renders: it owns walk paths, envelope
  // flights and typing phase, all of which are continuous state that a
  // re-created scene would restart on every unrelated prop change.
  const sceneRef = useRef<{
    readonly epicId: string;
    readonly scene: OfficeScene;
  } | null>(null);
  const readScene = useCallback((): OfficeScene => {
    const current = sceneRef.current;
    if (current !== null && current.epicId === epicId) return current.scene;
    const scene = new OfficeScene(layoutOffice);
    sceneRef.current = { epicId, scene };
    return scene;
  }, [epicId]);

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

  const statusById = useMemo(
    () =>
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

  const sceneInput = useMemo<OfficeSceneInput>(
    () => ({
      agents: officeAgents,
      visibleAgentIds: agentIds,
      statusById,
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
      agentIds,
      officeAgents,
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

  useEffect(() => {
    const stamped =
      sceneInput.cursorMs === null
        ? { ...sceneInput, clockMs: Date.now() }
        : sceneInput;
    runtime.setSceneInput(stamped);
    readScene().sync(stamped);
    // Not every change to the input moves anything. A paused seek that answers
    // an open request takes an envelope off a desk and starts no walk, and
    // within the same minute the idle skip would leave the pile painted.
    runtime.invalidateFrame();
  }, [readScene, runtime, sceneInput]);

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
      onViewChange({
        x: camera.x,
        y: camera.y,
        zoom: camera.zoom,
        mode: view.mode,
      });
    }, VIEW_PERSIST_DEBOUNCE_MS);
  }, [onViewChange, runtime, view.mode]);

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
      // The camera is not part of what the idle skip watches - a still floor
      // would keep the old framing painted under the new hit geometry.
      runtime.invalidateFrame();
      persistView();
    },
    [persistView, runtime],
  );

  const fitToFloor = useCallback(() => {
    const layout = readScene().layout();
    const size: OfficeSize = {
      width: layout.cols * OFFICE_TILE,
      height: layout.rows * OFFICE_TILE,
    };
    const viewport = runtime.getViewport();
    if (size.width <= 0 || viewport.width <= 0) return;
    const fitted = fitCamera(size, viewport);
    runtime.getCamera().x = fitted.x;
    runtime.getCamera().y = fitted.y;
    runtime.getCamera().zoom = fitted.zoom;
    fittedRef.current = { floor: size, viewport };
    runtime.invalidateFrame();
    persistView();
  }, [persistView, readScene, runtime]);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = get2dContext(canvas);
    // No 2d context (jsdom): the accessible agent list below is the whole
    // surface, and it works without a single pixel being drawn.
    if (ctx === null) return;

    let raf = 0;
    let last = performance.now();
    // Seeded from the DOM rather than assumed: the observer's first callback
    // is asynchronous, and a tile opened in the foreground should not wait a
    // frame for it.
    let canvasIsVisible = isElementVisible(canvas);
    let lastClockSecond = -1;
    let pausedAt: number | null = null;
    const gate = new OfficeFrameGate();
    const staticLayer = new OfficeStaticLayer(createOfficeStaticSurface);
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
    const advanceLiveClock = (): void => {
      const input = runtime.getSceneInput();
      if (input === null || input.cursorMs !== null) return;
      const now = Date.now();
      const second = Math.floor(now / 1000);
      if (second === lastClockSecond) return;
      lastClockSecond = second;
      const stamped = { ...input, clockMs: now };
      readScene().sync(stamped);
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
      advanceLiveClock();
      const scene = readScene();
      scene.tick(elapsed);
      // A DPR change does not resize anything in CSS pixels, so no resize
      // event is guaranteed to arrive - a browser zoom on a secondary display
      // moves it silently. Checked BEFORE the idle skip: resizing the bitmap
      // is what invalidates the gate, and a still floor would otherwise never
      // reach the check. The compare is two property reads a frame.
      if ((window.devicePixelRatio || 1) !== appliedDprRef.current) {
        applyCanvasSize();
      }

      const clockMs = runtime.getSceneInput()?.clockMs ?? 0;
      const draw = gate.shouldDraw({
        animating: scene.isAnimating(),
        minute: Math.floor(clockMs / 60_000),
        // PEEKED, not taken: consuming the request here would drop the pan on
        // the floor on exactly the still frames auto-pan exists to move.
        panning: runtime.getActivePan() !== null || runtime.hasPanRequest(),
      });
      if (!draw) {
        raf = requestAnimationFrame(step);
        return;
      }

      const frame = scene.frame();
      runtime.setHitRegions(frame.hitRegions);
      runtime.setEnvelopeRegions(frame.envelopeHitRegions);
      const camera = runtime.getCamera();
      const viewport = runtime.getViewport();
      applyAutoFit(frame.size, viewport);
      requestPlaybackPan(frame.focus, viewport);
      advanceCamera(now, viewport);
      // The hover card's rect was measured on the last pointermove, and what
      // it points at can move without the pointer moving at all: the cursor
      // scrubs to a time before that agent existed, the agent walks off to
      // the cafeteria, or an auto-pan slides the floor under the cursor.
      // Holding the card open would leave it anchored to empty floor. Checked
      // AFTER the camera has moved for this frame, so a pan is caught on the
      // frame it happens rather than the one after.
      const anchor = hoverAnchorRef.current;
      if (
        anchor !== null &&
        !hoverAnchorHolds(anchor, frame.hitRegions, camera)
      ) {
        hoverAnchorRef.current = null;
        runtime.setHoveredAgentId(null);
        setHoverCard(null);
      }

      // Repainted only when the floor's version, the theme or its size moves;
      // every other frame this is a single `drawImage`.
      const staticFloor = staticLayer.sync(
        {
          staticVersion: frame.staticVersion,
          theme: resolvedTheme,
          width: frame.size.width,
          height: frame.size.height,
        },
        (floorCtx) => {
          drawStaticFloor(floorCtx, frame.floor, resolvedTheme);
        },
      );
      const hoveredId = runtime.getHoveredAgentId();
      drawOfficeFrame({
        ctx,
        frame,
        staticFloor,
        camera,
        viewport,
        dpr: appliedDprRef.current,
        theme: resolvedTheme,
        searchMatchIds: runtime.getSearchMatchIds(),
        nameById: runtime.getNameById(),
        floors: scene.layout().floors,
        hostNameById: runtime.getHostNames(),
        awayAgentIds: awayAgentIdsIn(frame, scene.layout()),
        hoveredAgentId: hoveredId,
      });
      raf = requestAnimationFrame(step);
    };

    const start = (): void => {
      if (raf !== 0) return;
      if (document.hidden || !canvasIsVisible) return;
      // Catch the simulation up on a bounded slice of the time spent paused,
      // so the floor resumes looking alive rather than mid-stride.
      const catchUp = officeCatchUpMs(
        pausedAt === null ? 0 : Date.now() - pausedAt,
      );
      pausedAt = null;
      if (catchUp > 0) readScene().tick(catchUp);
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
    // TWO ways to be invisible, and the floor has to answer to both. A hidden
    // DOCUMENT is the browser's own signal. A hidden TILE is not: an unselected
    // Traycer tab keeps its tiles mounted under `display:none`, so without the
    // observer this loop draws sixty frames a second into a canvas nobody can
    // see. The tile itself stays mounted either way - only the loop pauses.
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    const observer = new IntersectionObserver((entries) => {
      canvasIsVisible = entries.some((entry) => entry.isIntersecting);
      if (canvasIsVisible) start();
      else stop();
    });
    observer.observe(canvas);
    if (isElementVisible(canvas)) {
      canvasIsVisible = true;
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      stop();
      stopWatchingLogos();
      runtime.onInvalidateFrame(() => undefined);
      // A floor's worth of pixels is real memory; it goes with the tile.
      staticLayer.release();
    };
  }, [applyCanvasSize, readScene, resolvedTheme, runtime]);

  const toSpritePoint = useCallback(
    (clientX: number, clientY: number): OfficePoint | null => {
      const container = containerRef.current;
      if (container === null) return null;
      const rect = container.getBoundingClientRect();
      const camera = runtime.getCamera();
      return {
        x: (clientX - rect.left - camera.x) / camera.zoom,
        y: (clientY - rect.top - camera.y) / camera.zoom,
      };
    },
    [runtime],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
      event.currentTarget.setPointerCapture(event.pointerId);
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
      const overEnvelope =
        point !== null && envelopeEdgeFor(runtime, readScene(), point) !== null;
      const region =
        point === null ? null : hitRegionFor(runtime.getHitRegions(), point);
      const camera = runtime.getCamera();
      // Mirrored for the DRAW, which needs it to keep an away agent's name tag
      // while the pointer is on it; the card itself is React state.
      runtime.setHoveredAgentId(region === null ? null : region.agentId);
      hoverAnchorRef.current =
        region === null
          ? null
          : {
              agentId: region.agentId,
              rect: region.rect,
              cameraX: camera.x,
              cameraY: camera.y,
              zoom: camera.zoom,
            };
      setHoverCard(
        region === null
          ? null
          : {
              agentId: region.agentId,
              rect: {
                x: region.rect.x * camera.zoom + camera.x,
                y: region.rect.y * camera.zoom + camera.y,
                width: region.rect.width * camera.zoom,
                height: region.rect.height * camera.zoom,
              },
            },
      );
      // An envelope is clickable too, so it earns the same cursor even where
      // it is flying over open floor with no desk under it.
      event.currentTarget.style.cursor =
        region === null && !overEnvelope ? "default" : "pointer";
    },
    [readScene, runtime, toSpritePoint],
  );

  const clearHover = useCallback(() => {
    hoverAnchorRef.current = null;
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
      const scene = readScene();
      const edgeId = envelopeEdgeFor(runtime, scene, point);
      if (edgeId !== null) {
        setSelectedDetail({ kind: "pair", edgeId });
        return;
      }
      const agentId = scene.hitTest(point);
      if (agentId !== null) setSelectedAgentId(agentId);
    },
    [persistView, readScene, runtime, setSelectedAgentId, toSpritePoint],
  );

  // A native listener, because a passive React `onWheel` cannot call
  // `preventDefault` - and without it the epic canvas scrolls under the floor.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      runtime.takeManualControl();
      const rect = container.getBoundingClientRect();
      // A pinch arrives as ctrl+wheel and means exactly what a wheel means
      // here, so both take the same path rather than forking a gesture model.
      const factor = Math.exp(-event.deltaY / 300);
      zoomAbout(factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [runtime, zoomAbout]);

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

  return (
    <div className="flex h-full min-h-0 w-full min-w-0">
      <div
        ref={containerRef}
        className="relative h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-testid="comm-graph-office-canvas"
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          // The camera gestures live on the CANVAS, never on the wrapper. The
          // wrapper is also the parent of every overlay control, and a
          // pointerdown there took pointer capture - which retargets the
          // following `click` to the capturing element, so the mode toggle's
          // own button never saw its click at all.
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          // Nearest-neighbour scaling is what makes this pixel art rather than
          // a blurry upscale; the draw disables smoothing on its side too.
          style={{ imageRendering: "pixelated" }}
          role="img"
          aria-label="Office view of the communication graph"
        />
        {modeToggle}
        {hoverCard === null || hoveredAgent === null ? null : (
          <OfficeAgentHover
            epicId={epicId}
            agentId={hoveredAgent.id}
            name={hoveredAgent.name}
            screenRect={hoverCard.rect}
            extraContent={
              <OfficeHoverSupplement
                status={statusById.get(hoveredAgent.id) ?? "idle"}
                modelTier={officeModelTier(hoveredAgent.model)}
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
            "absolute bottom-2 left-2 z-10 flex flex-col gap-0.5",
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
        agents={agents}
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
