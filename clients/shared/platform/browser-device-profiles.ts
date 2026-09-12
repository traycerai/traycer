/**
 * What KIND of device a browser tile is asking its page to believe it is.
 *
 * ## Why this carries no geometry
 *
 * Resizing a tile already changes the page's layout viewport: the guest fills an
 * element, so the element's box IS the viewport and CSS reflows against it for
 * free. What resizing cannot say is what kind of device that width belongs to - a
 * page at 390px with a fine pointer and this machine's pixel ratio still takes its
 * desktop branch, so `pointer: coarse` answers wrong and a `devicePixelRatio` read
 * reports the wrong number.
 *
 * So a profile is exactly the three things the element cannot express, and
 * deliberately NOT width and height. Sending geometry from here as well would put
 * two authorities on one number, and a page laid out at an override's height
 * inside a shorter box is clipped - the failure a geometry-free profile makes
 * structurally impossible.
 */

/**
 * The device classes a tile can adopt.
 *
 * Three phone sizes and two tablet orientations even though several currently
 * resolve to the same profile: the id names the INTENT, and a class that later
 * needs its own ratio can get one without a caller changing. The ids are also
 * persisted, so collapsing them would rewrite meaning stored on disk.
 */
export const BROWSER_DEVICE_PRESET_IDS = [
  "handset-compact",
  "handset-regular",
  "handset-large",
  "tablet-portrait",
  "tablet-landscape",
  "laptop",
  "desktop",
  "desktop-wide",
] as const;

export type BrowserDevicePresetId = (typeof BROWSER_DEVICE_PRESET_IDS)[number];

/**
 * The geometry-free half of a device class: what KIND of device a viewport
 * belongs to, for a tile whose size its own element decides.
 */
export interface BrowserViewDeviceProfile {
  readonly devicePixelRatio: number;
  readonly mobile: boolean;
  readonly touch: boolean;
}

/** A touch device, which is also what `mobile` means to Chromium's emulation. */
function touch(devicePixelRatio: number): BrowserViewDeviceProfile {
  return { devicePixelRatio, mobile: true, touch: true };
}

/** A pointer device: no touch, and not "mobile" for the purposes of emulation. */
function pointer(devicePixelRatio: number): BrowserViewDeviceProfile {
  return { devicePixelRatio, mobile: false, touch: false };
}

const DESKTOP_PROFILE = pointer(1);

/**
 * A `Map` rather than an object literal, because the key is a STRING off the
 * wire: an object lookup answers for inherited properties, so `"constructor"`
 * resolved to `Object.prototype.constructor` and sailed past the `??` fallback -
 * a function where a profile was expected. A Map has no prototype chain to walk.
 */
const BROWSER_DEVICE_PROFILES = new Map<string, BrowserViewDeviceProfile>([
  ["handset-compact", touch(3)],
  ["handset-regular", touch(3)],
  ["handset-large", touch(3)],
  ["tablet-portrait", touch(2)],
  ["tablet-landscape", touch(2)],
  ["laptop", pointer(2)],
  ["desktop", DESKTOP_PROFILE],
  ["desktop-wide", pointer(1)],
]);

/**
 * The profile for a device class, falling back to a plain desktop for a class
 * this build does not have.
 *
 * Takes a `string` rather than a {@link BrowserDevicePresetId} on purpose: the id
 * arrives from PERSISTED tile state written by another build, so a class retired
 * between two versions is a real value at runtime however closed the union is at
 * compile time. Typing the parameter as the union only moved the rejection to the
 * IPC boundary, where it became a validation failure for a tile the user had open
 * last week.
 *
 * Desktop is the fallback because it is the profile that emulates LEAST - an
 * unrecognised class should leave the page as this machine rather than guess a
 * ratio and a pointer it cannot justify.
 */
export function presetDeviceProfile(id: string): BrowserViewDeviceProfile {
  return BROWSER_DEVICE_PROFILES.get(id) ?? DESKTOP_PROFILE;
}
