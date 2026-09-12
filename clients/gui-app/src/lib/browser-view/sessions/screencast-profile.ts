import { isMobileApp } from "@/lib/mobile-app";

/**
 * The frame budget a `browser.screencast` viewer opens its stream with. Every
 * subscriber is sized independently by the host, so one client's profile never
 * constrains another's view of the same tab.
 *
 * `maxDpr` is the ceiling this viewer reports in its `viewport` frames rather
 * than a field on the open request. The host sizes frames at `width x dpr`, so
 * the reported device ratio is what decides the JPEG's real dimensions -
 * `maxWidth` / `maxHeight` only trim what is left after that multiplication.
 * `null` reports the device ratio unchanged.
 *
 * ## Why the budget is measured, not written down
 *
 * A literal edge pair is a resolution CAP wearing the costume of a safety
 * bound. It cannot be chosen correctly, because the number it has to beat is
 * the tile's physical size - CSS edge times device ratio - and that is a fact
 * about the machine the viewer opened on, not about the protocol. A pair
 * picked for one display trims every larger one, and the trim is invisible in
 * the way that matters: the stream stays live, the frames keep arriving, and
 * the page is simply soft forever. A fixed 1280x720 spent a 1272x800@2 tile's
 * 2544x1600 request down to a third of its pixels for exactly that reason.
 *
 * So the budget is read off the display instead. A tile is a region of a
 * window and a window is a region of a display, so the display's own physical
 * extent bounds every tile that can ever exist on it - which makes it the
 * smallest bound that never trims, rather than a cap that sometimes does.
 * Frames stay bounded (that is the point of sending one at all), but by the
 * viewer's real ceiling.
 *
 * {@link ABSOLUTE_FRAME_EDGE} is the only literal left, and it is a
 * memory-safety guard rather than a quality decision: a decoded frame is
 * `width x height x 4` bytes on both sides of the wire, and a tiled 6K panel
 * at a ratio of 3 would ask for more than any of it needs to be legible.
 */
export interface ScreencastProfile {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly maxDpr: number | null;
}

/** The physical extent a viewer's display can present, in device pixels. */
export interface ScreencastDisplayExtent {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
}

/**
 * JPEG quality for a desktop shell. Text is the payload here - a page of code
 * or a form, not video - and chroma ringing around glyph edges is what reads
 * as "blurry" long before any edge count does. 70 was low enough to soften
 * antialiasing on its own, independent of the trim above.
 */
const DESKTOP_FRAME_QUALITY = 92;

/**
 * Handheld shells reach their host over the relay, where a frame's BYTE size -
 * not its decode - sets the frame rate: the stream is paint-ack-gated end to
 * end, so oversized frames surface as fewer frames per second rather than as
 * congestion. Quality is the cheaper of the two levers there (bytes fall
 * roughly with the quantizer while every pixel stays addressable), so the
 * ratio ceiling below stays generous and this carries the saving.
 */
const HANDHELD_FRAME_QUALITY = 80;

/**
 * A phone's own ratio of 3 asks for roughly nine times the pixels of a CSS
 * layout that is already sized for a small screen. Two is past the point where
 * a further step is visible at arm's length and keeps the frame a quarter
 * smaller than the panel's nominal ratio.
 */
const HANDHELD_DPR_CEILING = 2;

/** Per-edge guard on a decoded frame's allocation. See the interface docs. */
const ABSOLUTE_FRAME_EDGE = 3_840;

/**
 * Reported when the extent cannot be read - a non-DOM test environment, or a
 * shell that opens a stream before first layout. Deliberately roomy: an
 * under-read costs sharpness on a real display, while an over-read costs only
 * the host's own sizing arithmetic, which is bounded by the tile's `viewport`
 * frame anyway.
 */
const FALLBACK_EXTENT: ScreencastDisplayExtent = {
  cssWidth: 1_920,
  cssHeight: 1_200,
  devicePixelRatio: 2,
};

/**
 * The device ratio a `viewport` frame reports under `profile`, and the same
 * multiplier {@link computeScreencastProfile} sizes its edges with, so the two
 * can never disagree about how large a frame this viewer asked for.
 */
export function clampScreencastDpr(
  profile: ScreencastProfile,
  devicePixelRatio: number,
): number {
  if (profile.maxDpr === null) return devicePixelRatio;
  return Math.min(devicePixelRatio, profile.maxDpr);
}

/** Pure half of {@link screencastProfile}, over an injected extent. */
export function computeScreencastProfile(
  extent: ScreencastDisplayExtent,
  handheld: boolean,
): ScreencastProfile {
  const maxDpr = handheld ? HANDHELD_DPR_CEILING : null;
  const ratio = Math.max(
    1,
    maxDpr === null
      ? extent.devicePixelRatio
      : Math.min(extent.devicePixelRatio, maxDpr),
  );
  return {
    maxWidth: physicalEdge(extent.cssWidth, ratio),
    maxHeight: physicalEdge(extent.cssHeight, ratio),
    quality: handheld ? HANDHELD_FRAME_QUALITY : DESKTOP_FRAME_QUALITY,
    maxDpr,
  };
}

/**
 * The profile for this viewer's shell and display.
 *
 * Memoized on the extent it was computed from, because the caller depends on
 * the RESULT: a fresh object per render would re-open the subscription on
 * every commit. Re-reading the extent per call is what lets a window dragged
 * to a second display resize its frames, since the signature moves with it and
 * a genuine display change is exactly when re-opening is correct.
 */
export function screencastProfile(): ScreencastProfile {
  const handheld = isMobileApp();
  const extent = readDisplayExtent();
  const signature = [
    handheld,
    extent.cssWidth,
    extent.cssHeight,
    extent.devicePixelRatio,
  ].join(":");
  if (memo === null || memo.signature !== signature) {
    memo = { signature, profile: computeScreencastProfile(extent, handheld) };
  }
  return memo.profile;
}

/** Drops the memo so a suite can re-read a changed shell or display. */
export function resetScreencastProfileMemo(): void {
  memo = null;
}

let memo: {
  readonly signature: string;
  readonly profile: ScreencastProfile;
} | null = null;

function physicalEdge(cssEdge: number, ratio: number): number {
  const physical = Math.ceil(positiveOrNull(cssEdge) ?? 0) * ratio;
  return Math.min(ABSOLUTE_FRAME_EDGE, Math.max(1, Math.ceil(physical)));
}

function readDisplayExtent(): ScreencastDisplayExtent {
  if (typeof window === "undefined") return FALLBACK_EXTENT;
  // `window.screen` is guaranteed by the DOM, so the guard that matters is on
  // the VALUES: a stubbed or headless surface reports zeroes here, and a zero
  // edge would size every frame at one pixel.
  const { screen } = window;
  const cssWidth = positiveOrNull(screen.width);
  const cssHeight = positiveOrNull(screen.height);
  const devicePixelRatio = positiveOrNull(window.devicePixelRatio);
  if (cssWidth === null || cssHeight === null) return FALLBACK_EXTENT;
  return {
    cssWidth,
    cssHeight,
    devicePixelRatio: devicePixelRatio ?? FALLBACK_EXTENT.devicePixelRatio,
  };
}

function positiveOrNull(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
