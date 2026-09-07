import { isMobileApp } from "@/lib/mobile-app";

/**
 * The frame budget a `browser.screencast` viewer opens its stream with.
 * Every subscriber is sized independently by the host, so one client's profile never constrains another's view of the same tab.
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
 * The installed phone app reaches its host over the relay, where a frame's BYTE size - not its decode - is what sets the frame rate: the stream is paint-ack-gated end to end, so oversized frames surface as fewer frames per second rather than as congestion.
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
