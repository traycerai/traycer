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
import { useCommGraphSpeed } from "@/stores/epics/comm-graph-timeline-store";
import type { CommGraphCanvasProps } from "@/components/epic-canvas/comm-graph/comm-graph-canvas";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";
import { isDefaultCommGraphView } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { CommGraphAgentDetailSurface } from "@/components/epic-canvas/comm-graph/comm-graph-agent-detail-surface";
import { createCommGraphFindAdapter } from "@/components/epic-canvas/comm-graph/comm-graph-find-adapter";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { BASE_STEP_MS } from "@/components/epic-canvas/comm-graph/use-comm-graph-transport";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import {
  drawOfficeSprite,
  officePalette,
  officeSpriteSize,
} from "@/lib/comm-graph/office/office-pixel-art";
import {
  ENVELOPE_ARC_LIFT,
  OfficeScene,
} from "@/lib/comm-graph/office/office-scene";
import { officeAgentStatuses } from "@/lib/comm-graph/office/office-status";
import {
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeDrawable,
  type OfficeFrame,
  type OfficeHitRegion,
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSize,
  type OfficeTheme,
} from "@/lib/comm-graph/office/office-types";
import type { CommGraphPulseKind } from "@/lib/comm-graph/comm-graph-timeline";

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
/** A frame longer than this is a tab that was asleep, not a slow frame. */
const MAX_FRAME_MS = 100;
const AUTO_PAN_MS = 250;
/** Pointer travel that turns a click into a drag. */
const CLICK_SLOP_PX = 4;
/** Coalesces a pan/zoom gesture into one persisted view write. */
const VIEW_PERSIST_DEBOUNCE_MS = 150;
const LABEL_FONT_PX = 10;
const HOVER_LABEL_FONT_PX = 11;
const MONOSPACE_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * Envelope tints per pulse kind. Fixed hex rather than theme tokens: an
 * envelope is a colored object in a scene, and the four kinds have to stay
 * distinguishable from each other on both floors.
 */
const ENVELOPE_TINTS: Readonly<Record<CommGraphPulseKind, string>> = {
  request: "#3b82f6",
  reply: "#22c55e",
  notice: "#ef4444",
  created: "#f59e0b",
};

interface OfficeCamera {
  x: number;
  y: number;
  zoom: number;
}

interface ScreenSize {
  readonly width: number;
  readonly height: number;
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
  readonly getSearchMatchIds: () => ReadonlySet<string>;
  readonly setSearchMatchIds: (next: ReadonlySet<string>) => void;
  readonly takePanRequest: () => PanRequest | null;
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
}

function createOfficeRuntime(view: CommGraphTileViewState): OfficeRuntime {
  const camera: OfficeCamera = {
    x: view.x,
    y: view.y,
    zoom: clampZoom(view.zoom),
  };
  let viewport: ScreenSize = { width: 0, height: 0 };
  let hitRegions: ReadonlyArray<OfficeHitRegion> = [];
  let searchMatchIds: ReadonlySet<string> = EMPTY_MATCH_IDS;
  let pendingPan: PanRequest | null = null;
  let agents: ReadonlyArray<CommGraphAgentNode> = [];
  let pulseKey: string | null = null;
  let playing = false;
  let activePan: CameraPan | null = null;
  let autoPanEnabled = true;
  let autoFitEnabled = isDefaultCommGraphView(view);
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
    getSearchMatchIds: () => searchMatchIds,
    setSearchMatchIds: (next) => {
      searchMatchIds = next;
    },
    takePanRequest: () => {
      const taken = pendingPan;
      pendingPan = null;
      return taken;
    },
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
 * Screen-space text with a one-pixel dark backing.
 *
 * The floor's own colors are arbitrary (a character's shirt may land on the
 * foreground color), so a name is outlined rather than trusted to contrast
 * with whatever it happens to sit on.
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
    readonly alpha: number;
  },
): void {
  const { alpha, color, fontPx, screenX, screenY, text } = label;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${fontPx}px ${MONOSPACE_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
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
  readonly hoveredName: string | null;
  readonly hoveredRegion: OfficeHitRegion | null;
  /** Agents the tile's Find session currently matches; empty when idle. */
  readonly searchMatchIds: ReadonlySet<string>;
  readonly nameById: ReadonlyMap<string, string>;
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
    { name: "envelope", tint: ENVELOPE_TINTS[drawable.pulseKind] },
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

function drawOfficeFrame(args: DrawFrameArgs): void {
  const {
    camera,
    ctx,
    dpr,
    frame,
    hoveredName,
    hoveredRegion,
    nameById,
    searchMatchIds,
    theme,
    viewport,
  } = args;
  const palette = officePalette(theme);

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
  const labels: Array<Extract<OfficeDrawable, { kind: "label" }>> = [];
  const layers: ReadonlyArray<{
    readonly drawables: ReadonlyArray<OfficeDrawable>;
    readonly anchor: SpriteAnchor;
  }> = [
    { drawables: frame.floor, anchor: "top-left" },
    { drawables: frame.props, anchor: "top-left" },
    { drawables: frame.actors, anchor: "top-left" },
    // Bubbles and sparkles hang over whatever they belong to, so the scene
    // anchors them at their bottom centre rather than a corner.
    { drawables: frame.overlay, anchor: "bottom-center" },
  ];
  for (const layer of layers) {
    for (const drawable of layer.drawables) {
      if (drawable.kind === "label") {
        labels.push(drawable);
        continue;
      }
      if (drawable.kind === "envelope") {
        drawEnvelope(ctx, drawable, theme, palette.shadow);
        continue;
      }
      drawAnchoredSprite(ctx, drawable, layer.anchor, theme);
    }
  }

  // Back to screen space for text: a name magnified by the camera would be a
  // blur at zoom 4 and unreadable at zoom 0.5. The palette owns these colors
  // rather than `--foreground`, because they have to contrast with the ROOM,
  // which is the palette's own background and not the app's.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const label of labels) {
    drawScreenLabel(ctx, {
      text: label.text,
      screenX: label.x * camera.zoom + camera.x,
      screenY: label.y * camera.zoom + camera.y,
      fontPx: LABEL_FONT_PX,
      color: label.tone === "muted" ? palette.textMuted : palette.text,
      alpha: 1,
    });
  }
  // A find match is named AND outlined. The name is the thing the query was
  // typed against, so showing it is what makes a match checkable; the outline
  // is what finds it on a crowded floor where a name tag alone reads as noise.
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
        alpha: 1,
      });
    }
  }
  if (hoveredName !== null && hoveredRegion !== null) {
    drawScreenLabel(ctx, {
      text: hoveredName,
      screenX:
        (hoveredRegion.rect.x + hoveredRegion.rect.width / 2) * camera.zoom +
        camera.x,
      screenY:
        hoveredRegion.rect.y * camera.zoom + camera.y - HOVER_LABEL_FONT_PX / 2,
      fontPx: HOVER_LABEL_FONT_PX,
      color: palette.text,
      alpha: 1,
    });
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
  const fittedFloorRef = useRef<OfficeSize>({ width: 0, height: 0 });
  // A pan asked for outside the frame loop. Handlers and the Find adapter have
  // no frame clock, so they name the destination and the loop starts it.
  const dragRef = useRef<DragState | null>(null);
  const hoveredAgentIdRef = useRef<string | null>(null);
  const wasPlayingRef = useRef(playing);
  const autoPannedKeyRef = useRef<string | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  // The one detail surface this mode has: clicking a character opens its
  // activity beside the floor, and `null` closes it.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const { resolvedTheme } = useResolvedTheme();
  const speed = useCommGraphSpeed(epicId);
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

  const officeAgents = useMemo<ReadonlyArray<OfficeAgentInput>>(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        harnessId: agent.harnessId,
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
  const attentionIdList = useAppLocalNotificationsStore(
    useShallow((state): ReadonlyArray<string> =>
      agents.flatMap((agent) =>
        attentionTone(
          selectNotificationIndicatorState(
            state,
            { epicId, chatId: agent.id },
            agent.hostId,
            indicators,
          ),
        ) === null
          ? []
          : [agent.id],
      ),
    ),
  );
  const attentionAgentIds = useMemo(
    () => new Set(attentionIdList),
    [attentionIdList],
  );

  const statusById = useMemo(
    () =>
      officeAgentStatuses({
        agents: officeAgents,
        events,
        visibleAgentIds: agentIds,
        activityTiers,
        attentionAgentIds,
      }),
    [activityTiers, agentIds, attentionAgentIds, events, officeAgents],
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
      playing,
      reducedMotion,
    }),
    [
      agentIds,
      officeAgents,
      playing,
      pulse,
      pulseKey,
      reducedMotion,
      speed,
      statusById,
    ],
  );

  useEffect(() => {
    readScene().sync(sceneInput);
  }, [readScene, sceneInput]);

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
    fittedFloorRef.current = size;
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
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) return;
    const applySize = (): void => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      runtime.setViewport({ width: rect.width, height: rect.height });
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    applySize();
    const observer = new ResizeObserver(applySize);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [runtime]);

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

    // Re-fit an unframed tile whenever the floor's size changes - agents
    // arriving after the first frame is the normal case, and the room they
    // land in is the one worth framing.
    const applyAutoFit = (floor: OfficeSize, viewport: ScreenSize): void => {
      const fitted = fittedFloorRef.current;
      if (!runtime.isAutoFitEnabled()) return;
      if (floor.width <= 0 || viewport.width <= 0 || viewport.height <= 0) {
        return;
      }
      if (floor.width === fitted.width && floor.height === fitted.height) {
        return;
      }
      const next = fitCamera(floor, viewport);
      const camera = runtime.getCamera();
      camera.x = next.x;
      camera.y = next.y;
      camera.zoom = next.zoom;
      fittedFloorRef.current = floor;
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
    // made while the tab was hidden animates when it comes back rather than
    // arriving already finished.
    const advanceCamera = (now: number, viewport: ScreenSize): void => {
      const camera = runtime.getCamera();
      const requested = runtime.takePanRequest();
      if (requested !== null) {
        runtime.setActivePan(
          panToward({
            camera,
            viewport,
            request: requested,
            startedAt: now,
          }),
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
      const dt = Math.min(MAX_FRAME_MS, now - last);
      last = now;
      const scene = readScene();
      scene.tick(dt);
      const frame = scene.frame();
      runtime.setHitRegions(frame.hitRegions);

      const camera = runtime.getCamera();
      const viewport = runtime.getViewport();
      applyAutoFit(frame.size, viewport);
      requestPlaybackPan(frame.focus, viewport);
      advanceCamera(now, viewport);

      const hoveredId = hoveredAgentIdRef.current;
      drawOfficeFrame({
        ctx,
        frame,
        camera,
        viewport,
        dpr: window.devicePixelRatio || 1,
        theme: resolvedTheme,
        hoveredName:
          hoveredId === null ? null : (nameById.get(hoveredId) ?? null),
        hoveredRegion:
          hoveredId === null
            ? null
            : (frame.hitRegions.find(
                (region) => region.agentId === hoveredId,
              ) ?? null),
        searchMatchIds: runtime.getSearchMatchIds(),
        nameById,
      });
      raf = requestAnimationFrame(step);
    };

    const start = (): void => {
      if (raf !== 0) return;
      last = performance.now();
      raf = requestAnimationFrame(step);
    };
    const stop = (): void => {
      if (raf === 0) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };
    // A hidden tab has nothing to animate for, and a floor that kept simulating
    // there would burn a laptop battery behind a window nobody is looking at.
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [nameById, readScene, resolvedTheme, runtime]);

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
    (event: ReactPointerEvent<HTMLDivElement>) => {
      runtime.takeManualControl();
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
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag !== null && drag.pointerId === event.pointerId) {
        const dx = event.clientX - drag.originX;
        const dy = event.clientY - drag.originY;
        if (Math.abs(dx) > CLICK_SLOP_PX || Math.abs(dy) > CLICK_SLOP_PX) {
          drag.moved = true;
        }
        runtime.getCamera().x = drag.cameraX + dx;
        runtime.getCamera().y = drag.cameraY + dy;
        return;
      }
      const point = toSpritePoint(event.clientX, event.clientY);
      const region =
        point === null ? null : hitRegionFor(runtime.getHitRegions(), point);
      hoveredAgentIdRef.current = region === null ? null : region.agentId;
      event.currentTarget.style.cursor =
        region === null ? "default" : "pointer";
    },
    [runtime, toSpritePoint],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
      const agentId = readScene().hitTest(point);
      if (agentId !== null) setSelectedAgentId(agentId);
    },
    [persistView, readScene, setSelectedAgentId, toSpritePoint],
  );

  // A native listener, because a passive React `onWheel` cannot call
  // `preventDefault` - and without it the epic canvas scrolls under the floor.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      runtime.takeManualControl();
      const rect = container.getBoundingClientRect();
      // A pinch arrives as ctrl+wheel and means exactly what a wheel means
      // here, so both take the same path rather than forking a gesture model.
      const factor = Math.exp(-event.deltaY / 300);
      zoomAbout(factor, event.clientX - rect.left, event.clientY - rect.top);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, [runtime, zoomAbout]);

  const visibleAgents = useMemo(
    () => agents.filter((agent) => agentIds.has(agent.id)),
    [agentIds, agents],
  );

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
    [runtime, tileInstanceId],
  );
  useRegisterTileFindAdapter(findAdapter);

  const closePanel = useCallback(
    () => setSelectedAgentId(null),
    [setSelectedAgentId],
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0">
      <div
        ref={containerRef}
        className="relative h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-testid="comm-graph-office-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          // Nearest-neighbour scaling is what makes this pixel art rather than
          // a blurry upscale; the draw disables smoothing on its side too.
          style={{ imageRendering: "pixelated" }}
          role="img"
          aria-label="Office view of the communication graph"
        />
        {modeToggle}
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
