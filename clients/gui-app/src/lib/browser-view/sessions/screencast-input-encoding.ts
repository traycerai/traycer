import type {
  BrowserScreencastAgentCursorType,
  BrowserScreencastCaptureMode,
  BrowserScreencastClientFrame,
} from "@traycer/protocol/host/browser/contracts";
import { SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX } from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import { hasPlatformModKey, normalizeCode } from "@/lib/keybindings/chord";

const POINTER_CLICK_COUNT_WINDOW_MS = 500;
const POINTER_CLICK_COUNT_MAX = 8;

/**
 * The input half of the `browser.screencast` client protocol: DOM events in,
 * unsequenced client frames out. `armEpoch` / `seq` are stamped by the
 * session that owns the arm handshake, so nothing here is stateful.
 */
export type ScreencastPointerInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "pointer" }>,
  "armEpoch" | "seq" | "hasBinaryPayload"
>;

export type ScreencastKeyboardInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "keyboard" }>,
  "armEpoch" | "seq" | "hasBinaryPayload"
>;

type ScreencastInsertTextInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "insertText" }>,
  "armEpoch" | "seq" | "hasBinaryPayload"
>;

// Distributive: a plain Omit over this 4-variant union would collapse it to
// the common properties and lose `navigate`'s `url`.
type StripInputEnvelope<F> = F extends unknown
  ? Omit<F, "armEpoch" | "seq" | "hasBinaryPayload">
  : never;

export type ScreencastNavInput = StripInputEnvelope<
  Extract<
    BrowserScreencastClientFrame,
    { readonly kind: "navigate" | "goBack" | "goForward" | "reload" }
  >
>;

export type ScreencastInputFrame =
  | ScreencastPointerInput
  | ScreencastKeyboardInput
  | ScreencastInsertTextInput
  | ScreencastNavInput;

export interface ScreencastFrameSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Where the agent driving a tab last pointed. Lives beside
 * {@link ScreencastFrameSize} because the two are read together: the overlay
 * maps this through that geometry, the exact inverse of the pointer path
 * below. Every screencast surface produces one - the tile from its session,
 * PiP from its own subscription - so it cannot belong to either.
 */
export interface AgentCursorPosition {
  readonly type: BrowserScreencastAgentCursorType;
  /** Normalized [0,1] against the surface the host mapped it to. */
  readonly normalizedX: number;
  readonly normalizedY: number;
  readonly label: string;
  /** Distinguishes consecutive identical positions (a click at rest). */
  readonly id: number;
}

/**
 * The pointer shape the encoder reads. Named and exported because a translated
 * gesture - a finger drag re-expressed as a wheel - has no DOM event that
 * carries the right `button` / `buttons`, and must supply them itself.
 */
export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
  readonly buttons: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface PointerClickCount {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly at: number;
  readonly count: number;
}

interface ScreencastPointerFrameRequest {
  readonly event: PointerLike;
  readonly type: ScreencastPointerInput["type"];
  readonly clampToEdge: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly clickCount: number;
  /**
   * The surface the coordinates were taken against, as one number the host
   * compares back: the painted frame's sequence on the JPEG plane, the host's
   * viewport epoch on the video plane. `null` means the tile has nothing
   * correlatable to click on yet, so no frame is built at all.
   */
  readonly correlationToken: number | null;
  /** Which plane's token {@link correlationToken} is, for the wire's two fields. */
  readonly captureMode: BrowserScreencastCaptureMode;
  /**
   * The element the plane paints into - `<img>` on the JPEG plane, `<video>`
   * on the video plane. Only its box is read, so the union stays `HTMLElement`.
   */
  readonly surface: HTMLElement | null;
  readonly frameSize: ScreencastFrameSize | null;
}

export function buildScreencastPointerFrame(
  request: ScreencastPointerFrameRequest,
): ScreencastPointerInput | null {
  const normalized = normalizedPointerPosition({
    clientX: request.event.clientX,
    clientY: request.event.clientY,
    surface: request.surface,
    frameSize: request.frameSize,
    clampToEdge: request.clampToEdge,
  });
  if (request.correlationToken === null || normalized === null) return null;
  const onVideo = request.captureMode === "video";
  return {
    kind: "pointer",
    type: request.type,
    castSequence: onVideo ? null : request.correlationToken,
    viewportEpoch: onVideo ? request.correlationToken : null,
    ...normalized,
    button:
      request.type === "wheel" ? "none" : pointerButton(request.event.button),
    buttons: request.event.buttons,
    modifiers: inputModifiers(request.event),
    clickCount: request.clickCount,
    deltaX: request.deltaX,
    deltaY: request.deltaY,
  };
}

/**
 * Multi-click accumulation. A press continues the previous one only while it
 * shares the button and stays inside the arm buffer's click slop, so a drag
 * never reads as a double click.
 */
export function nextPointerClickCount(
  previous: PointerClickCount | null,
  event: PointerLike,
  at: number,
): PointerClickCount {
  const continuesPrevious =
    previous !== null &&
    previous.button === event.button &&
    at - previous.at <= POINTER_CLICK_COUNT_WINDOW_MS &&
    Math.abs(event.clientX - previous.clientX) <=
      SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX &&
    Math.abs(event.clientY - previous.clientY) <=
      SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX;
  return {
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    at,
    count: continuesPrevious
      ? Math.min(POINTER_CLICK_COUNT_MAX, previous.count + 1)
      : 1,
  };
}

export function inputModifiers(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

export function pointerButton(
  button: number,
): ScreencastPointerInput["button"] {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return "none";
}

/** The platform mod alone - the shape both chords below are typed with. */
function hasBareModifier(event: KeyboardEvent): boolean {
  return hasPlatformModKey(event) && !event.altKey && !event.shiftKey;
}

/**
 * Does this event carry the platform mod plus the PHYSICAL key `key` names?
 *
 * Derived from `code` through the shared `normalizeCode`, like the renderer's
 * matcher (`lib/keybindings/chord.ts`) and the native guest's
 * (`browser-view-chords.ts`). It was the third matcher of that set and the one
 * left on `event.key`, which is the character a layout produces rather than the
 * place it was pressed: on AZERTY the physical `KeyW` reports `key: "z"`, so an
 * armed screencast sent the configured close chord to the remote page and
 * closed the row on whichever key happened to produce a `w`. The app registry
 * cannot cover for it either, because browser-scoped commands are excluded
 * while a tile is armed.
 *
 * `key` falls back to the character for anything `normalizeCode` does not
 * recognise, matching the native matcher exactly - a code we have no token for
 * is better matched loosely than not at all.
 *
 * This is for chords that resolve a REGISTERED BINDING, whose tokens this
 * codebase mints from `code` and which therefore have to be read back the same
 * way. A platform convention is the opposite case and must not come here - see
 * `isScreencastPasteChord`.
 */
export function isScreencastModChord(
  event: KeyboardEvent,
  key: string,
): boolean {
  const physical = normalizeCode(event.code) ?? event.key.toLowerCase();
  return hasBareModifier(event) && physical === key;
}

/**
 * Is this the clipboard paste convention - deliberately by CHARACTER?
 *
 * The one screencast chord that must NOT derive from `code`, and the reason is
 * the mirror of the reason the others must. Paste is not one of our bindings:
 * its caller returns without `preventDefault` precisely so Chromium raises its
 * own paste event, which the tile turns into `insertText`. It has to match
 * wherever the reader's layout puts the letter V, because that is where they
 * press it and where the browser's own paste is bound.
 *
 * Matching it physically breaks that contract rather than tightening it. On a
 * Dvorak-style layout the V key reports `code: "Period"`, so a physical match
 * fails, the handler falls through to `preventDefault`, and the native paste
 * never happens - the chord is forwarded to the page as a rawKeyDown instead.
 * Same class as the mod+K/Z/S conventions the renderer keeps on `key`.
 */
export function isScreencastPasteChord(event: KeyboardEvent): boolean {
  return hasBareModifier(event) && event.key.toLowerCase() === "v";
}

/**
 * The box a frame actually paints inside a surface of `box`, under the
 * `object-contain` letterboxing both display planes use - null when the
 * surface has no area yet.
 *
 * Shared by the two directions this mapping runs in: pointer input out
 * (below) and the agent ghost cursor back in (`agent-cursor-overlay.tsx`).
 * They must stay exact inverses, so they read the same box.
 */
function containFit(
  box: { readonly width: number; readonly height: number },
  frameSize: ScreencastFrameSize,
): { readonly width: number; readonly height: number } | null {
  const scale = Math.min(
    box.width / frameSize.width,
    box.height / frameSize.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return { width: frameSize.width * scale, height: frameSize.height * scale };
}

function normalizedPointerPosition(request: {
  readonly clientX: number;
  readonly clientY: number;
  readonly surface: HTMLElement | null;
  readonly frameSize: ScreencastFrameSize | null;
  readonly clampToEdge: boolean;
}): { readonly normalizedX: number; readonly normalizedY: number } | null {
  if (request.surface === null || request.frameSize === null) return null;
  const rect = request.surface.getBoundingClientRect();
  const painted = containFit(rect, request.frameSize);
  if (painted === null) return null;
  const { width, height } = painted;
  const rawX = request.clientX - rect.left - (rect.width - width) / 2;
  const rawY = request.clientY - rect.top - (rect.height - height) / 2;
  const x = request.clampToEdge ? Math.min(width, Math.max(0, rawX)) : rawX;
  const y = request.clampToEdge ? Math.min(height, Math.max(0, rawY)) : rawY;
  if (!request.clampToEdge && (x < 0 || x > width || y < 0 || y > height)) {
    return null;
  }
  return { normalizedX: x / width, normalizedY: y / height };
}
