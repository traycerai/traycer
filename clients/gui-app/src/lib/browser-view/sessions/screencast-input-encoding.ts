import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import { SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX } from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import { hasPlatformModKey } from "@/lib/keybindings/chord";

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
  readonly castSequence: number | null;
  readonly image: HTMLImageElement | null;
  readonly frameSize: ScreencastFrameSize | null;
}

export function buildScreencastPointerFrame(
  request: ScreencastPointerFrameRequest,
): ScreencastPointerInput | null {
  const normalized = normalizedPointerPosition({
    clientX: request.event.clientX,
    clientY: request.event.clientY,
    image: request.image,
    frameSize: request.frameSize,
    clampToEdge: request.clampToEdge,
  });
  if (request.castSequence === null || normalized === null) return null;
  return {
    kind: "pointer",
    type: request.type,
    castSequence: request.castSequence,
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

export function isScreencastModChord(
  event: KeyboardEvent,
  key: string,
): boolean {
  return (
    hasPlatformModKey(event) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key
  );
}

function normalizedPointerPosition(request: {
  readonly clientX: number;
  readonly clientY: number;
  readonly image: HTMLImageElement | null;
  readonly frameSize: ScreencastFrameSize | null;
  readonly clampToEdge: boolean;
}): { readonly normalizedX: number; readonly normalizedY: number } | null {
  if (request.image === null || request.frameSize === null) return null;
  const rect = request.image.getBoundingClientRect();
  const scale = Math.min(
    rect.width / request.frameSize.width,
    rect.height / request.frameSize.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = request.frameSize.width * scale;
  const height = request.frameSize.height * scale;
  const rawX = request.clientX - rect.left - (rect.width - width) / 2;
  const rawY = request.clientY - rect.top - (rect.height - height) / 2;
  const x = request.clampToEdge ? Math.min(width, Math.max(0, rawX)) : rawX;
  const y = request.clampToEdge ? Math.min(height, Math.max(0, rawY)) : rawY;
  if (!request.clampToEdge && (x < 0 || x > width || y < 0 || y > height)) {
    return null;
  }
  return { normalizedX: x / width, normalizedY: y / height };
}
