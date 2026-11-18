import {
  SIMULATOR_ORIENTATIONS,
  type SimulatorOrientation,
} from "@traycer/protocol/host/simulator/actions";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import type {
  SimulatorHardwareButton,
  SimulatorStreamClientFrame,
  SimulatorStreamConfig,
} from "@traycer/protocol/host/simulator/stream-contracts";

/**
 * The input half of the `simulator.stream` client protocol: DOM events in,
 * client frames out, plus the geometry the surface and the pointer path share
 * (modelled on `screencast-input-encoding.ts`). Nothing here is stateful.
 *
 * Coordinates are normalised to the DISPLAYED frame: 0..1 across the box the
 * pixels are drawn in, after any CSS rotation. The host remaps for an iOS
 * device shown rotated, so the viewer never has to.
 */

export type SimulatorTouchPhase = "begin" | "move" | "end";
export type SimulatorKeyPhase = "down" | "up";

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface SurfaceRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** The keyboard fields the encoder reads, so a test need not build a DOM event. */
export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** The wire caps `code` and `key` at 64 characters. */
const KEY_FIELD_MAX = 64;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * A pointer position as a fraction of the surface it landed on, clamped to
 * the edges so a drag that leaves the box keeps reporting the nearest edge
 * (a finger sliding off a phone's screen ends at its edge, not nowhere).
 * `null` while the surface has no area, because 0/0 is not a position.
 */
export function normalizedSurfacePoint(args: {
  readonly clientX: number;
  readonly clientY: number;
  readonly rect: SurfaceRect;
}): NormalizedPoint | null {
  const { rect } = args;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: clampUnit((args.clientX - rect.left) / rect.width),
    y: clampUnit((args.clientY - rect.top) / rect.height),
  };
}

export function buildTouchFrame(
  phase: SimulatorTouchPhase,
  point: NormalizedPoint,
): SimulatorStreamClientFrame {
  return {
    kind: "touch",
    hasBinaryPayload: false,
    phase,
    x: clampUnit(point.x),
    y: clampUnit(point.y),
  };
}

export function buildKeyFrame(
  event: KeyLike,
  phase: SimulatorKeyPhase,
): SimulatorStreamClientFrame {
  return {
    kind: "key",
    hasBinaryPayload: false,
    phase,
    code: event.code.slice(0, KEY_FIELD_MAX),
    key: event.key.slice(0, KEY_FIELD_MAX),
    modifiers: {
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
    },
  };
}

/**
 * Whether a key pressed on the focused surface belongs to the simulator or to
 * this app. A chord on the viewer's platform modifier (Cmd on a Mac, Ctrl
 * elsewhere) stays with the app - closing the tab, opening the palette - and
 * is never forwarded. Tab and Shift+Tab stay with the app too, so keyboard
 * focus can leave the surface. Everything else, modifiers included, goes to
 * the device.
 */
export function shouldForwardKey(
  event: KeyLike,
  viewerIsMac: boolean,
): boolean {
  if (event.key === "Tab") return false;
  return viewerIsMac ? !event.metaKey : !event.ctrlKey;
}

export function buildButtonFrame(
  button: SimulatorHardwareButton,
): SimulatorStreamClientFrame {
  return { kind: "button", hasBinaryPayload: false, button };
}

export function buildOrientationFrame(
  orientation: SimulatorOrientation,
): SimulatorStreamClientFrame {
  return { kind: "orientation", hasBinaryPayload: false, orientation };
}

/**
 * The next stop on the rotate button, in the order the device turns when its
 * right edge goes down first: portrait, landscape left, upside down, landscape
 * right, portrait.
 */
export function nextOrientation(
  current: SimulatorOrientation,
): SimulatorOrientation {
  const index = SIMULATOR_ORIENTATIONS.indexOf(current);
  return SIMULATOR_ORIENTATIONS[(index + 1) % SIMULATOR_ORIENTATIONS.length];
}

/** The buttons a platform's device actually has, in toolbar order. */
export function hardwareButtonsForPlatform(
  platform: SimulatorPlatform,
): readonly SimulatorHardwareButton[] {
  return platform === "ios"
    ? ["home", "appSwitcher", "power"]
    : ["back", "home", "recents", "power"];
}

export function hardwareButtonLabel(button: SimulatorHardwareButton): string {
  switch (button) {
    case "home":
      return "Home";
    case "back":
      return "Back";
    case "recents":
      return "Recents";
    case "appSwitcher":
      return "App switcher";
    case "power":
      return "Lock";
  }
}

function isLandscape(orientation: SimulatorOrientation): boolean {
  return orientation === "landscape_left" || orientation === "landscape_right";
}

/**
 * The CSS rotation that shows an iOS device the way it is held. serve-sim
 * streams the raw framebuffer, which stays portrait while the device reports
 * landscape, so the viewer turns the drawn frame. A framebuffer that is
 * already wider than tall needs none, and Android frames are always upright.
 */
export function screenRotationDegrees(
  platform: SimulatorPlatform,
  config: SimulatorStreamConfig | null,
  frameSize: FrameSize | null,
): number {
  if (platform !== "ios" || config === null) return 0;
  const size =
    frameSize ??
    (config.width !== null && config.height !== null
      ? { width: config.width, height: config.height }
      : null);
  if (size !== null && size.width > size.height) return 0;
  switch (config.orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    case "portrait":
      return 0;
  }
}

/**
 * Width over height of the frame AS DISPLAYED (after rotation). Before the
 * first frame arrives a phone-shaped placeholder keeps the layout from
 * jumping when pixels do.
 */
export function displayAspect(
  platform: SimulatorPlatform,
  config: SimulatorStreamConfig | null,
  frameSize: FrameSize | null,
): number {
  const size =
    frameSize ??
    (config !== null && config.width !== null && config.height !== null
      ? { width: config.width, height: config.height }
      : null);
  const landscape = config !== null && isLandscape(config.orientation);
  if (size === null) {
    const portrait = platform === "ios" ? 9 / 19.5 : 9 / 20;
    return landscape ? 1 / portrait : portrait;
  }
  const shorter = Math.min(size.width, size.height);
  const longer = Math.max(size.width, size.height);
  return landscape ? longer / shorter : shorter / longer;
}

/**
 * The largest box at `aspect` that fits `width` by `height`, so a narrow tile
 * shows a shorter phone rather than a squeezed one. CSS `aspect-ratio` alone
 * cannot do this: with the height pinned to 100% the width clamp wins and
 * distorts the drawn frame.
 */
export function fitDeviceFrame(
  aspect: number,
  width: number,
  height: number,
): FrameSize {
  if (
    !(aspect > 0) ||
    !Number.isFinite(aspect) ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return { width: 0, height: 0 };
  }
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= width ? byHeight : { width, height: width / aspect };
}

/** The box the canvas or image is drawn in, in CSS pixels. */
export interface DeviceMediaStyle {
  readonly width: number;
  readonly height: number;
  readonly left?: number;
  readonly top?: number;
  readonly transform?: string;
}

/**
 * Positions the media element inside a frame of `frame` so that, after
 * `rotation`, it fills the frame: a sideways device swaps its width and
 * height and is offset by half the difference, so the rotated box lands
 * exactly on the frame the pointer coordinates are read against.
 */
export function deviceMediaStyle(
  frame: FrameSize,
  rotation: number,
): DeviceMediaStyle {
  const sideways = rotation === 90 || rotation === -90;
  if (sideways) {
    return {
      width: frame.height,
      height: frame.width,
      left: (frame.width - frame.height) / 2,
      top: (frame.height - frame.width) / 2,
      transform: `rotate(${String(rotation)}deg)`,
    };
  }
  if (rotation === 0) return { width: frame.width, height: frame.height };
  return {
    width: frame.width,
    height: frame.height,
    transform: `rotate(${String(rotation)}deg)`,
  };
}

/** The frame's own box: the element the pointer is normalised against. */
export function deviceFrameStyle(frame: FrameSize): DeviceMediaStyle {
  return { width: frame.width, height: frame.height };
}
