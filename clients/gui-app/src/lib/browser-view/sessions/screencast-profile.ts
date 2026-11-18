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
 */
export interface ScreencastProfile {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  readonly maxDpr: number | null;
}

const DESKTOP_SCREENCAST_PROFILE: ScreencastProfile = {
  maxWidth: 1280,
  maxHeight: 720,
  quality: 70,
  maxDpr: null,
};

/**
 * The installed phone app reaches its host over the relay, where a frame's
 * BYTE size - not its decode - is what sets the frame rate: the stream is
 * paint-ack-gated end to end, so oversized frames surface as fewer frames per
 * second rather than as congestion.
 *
 * The device ratio is what needs clamping. A portrait phone viewport at a
 * ratio of 3 asks the host for roughly 1170x2530 - an order of magnitude more
 * pixels than the page needs to be legible on that screen, and enough JPEG per
 * frame to hold the stream to a couple of frames a second. The taller
 * `maxHeight` is the portrait counterpart of the landscape default, so a phone
 * frame is not trimmed to a desktop aspect on the way through.
 */
const MOBILE_SCREENCAST_PROFILE: ScreencastProfile = {
  maxWidth: 900,
  maxHeight: 1600,
  quality: 55,
  maxDpr: 1.5,
};

export function screencastProfile(): ScreencastProfile {
  return isMobileApp() ? MOBILE_SCREENCAST_PROFILE : DESKTOP_SCREENCAST_PROFILE;
}

/** The device pixel ratio a `viewport` frame reports under `profile`. */
export function clampScreencastDpr(
  profile: ScreencastProfile,
  devicePixelRatio: number,
): number {
  if (profile.maxDpr === null) return devicePixelRatio;
  return Math.min(devicePixelRatio, profile.maxDpr);
}
