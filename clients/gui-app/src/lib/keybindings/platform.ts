/**
 * Platform helpers for keybinding labels and platform-primary modifier
 * matching. Runtime matching treats `mod` as Command on macOS and
 * Command/Control elsewhere; Control-specific macOS shortcuts are represented
 * with the separate `ctrl` token.
 */

// UA Client Hints - the modern platform signal, not yet in TS's lib.dom (5.9).
// Typed here via declaration merging so `navigator.userAgentData` is available
// without a cast.
declare global {
  interface Navigator {
    readonly userAgentData?: { readonly platform: string };
  }
}

// Detect macOS via `navigator.userAgentData.platform` ("macOS"), the modern
// standard signal. It is NOT affected by the desktop app's custom User-Agent
// (see desktop `configureUserAgent`): `setUserAgent` overrides the UA
// string/header, but UA Client Hints come from separate metadata the app never
// sets - so it reports "macOS" where a UA-string check would miss it. Fall back
// to the UA string for engines without UA-CH (Safari/Firefox), whose UA strings
// do contain the OS token.
function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaPlatform = navigator.userAgentData?.platform;
  // Treat an empty platform (some engines report "") like undefined and fall
  // through to the UA string, rather than concluding "not mac".
  if (uaPlatform !== undefined && uaPlatform !== "") {
    return uaPlatform.toLowerCase().includes("mac");
  }
  return navigator.userAgent.toLowerCase().includes("mac");
}

const IS_MAC = detectMac();

export function isMac(): boolean {
  return IS_MAC;
}

// Detect Windows via the same UA Client Hints signal as `detectMac`
// (`navigator.userAgentData.platform` reports "Windows"), falling back to the UA
// string ("Windows NT ...") for engines without UA-CH. Like the mac check it is
// robust against the desktop app's custom User-Agent, which never sets UA-CH
// metadata.
function detectWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaPlatform = navigator.userAgentData?.platform;
  if (uaPlatform !== undefined && uaPlatform !== "") {
    return uaPlatform.toLowerCase().includes("win");
  }
  return navigator.userAgent.toLowerCase().includes("win");
}

const IS_WINDOWS = detectWindows();

export function isWindows(): boolean {
  return IS_WINDOWS;
}

export function modLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

// The Control key specifically (⌃ on macOS, where it's distinct from ⌘). Used by
// chords that bind to Control rather than the platform-primary `mod`.
export function ctrlLabel(): string {
  return isMac() ? "⌃" : "Ctrl";
}

export function altLabel(): string {
  return isMac() ? "⌥" : "Alt";
}

export function shiftLabel(): string {
  return isMac() ? "⇧" : "Shift";
}

/**
 * Compact glyph for the leader modifier used in digit badges - always a
 * single character so the badge width stays stable when Alt (⌥) is the
 * leader. Non-Mac `mod` falls back to `⌃` (Control) rather than the
 * 4-letter "Ctrl" that `modLabel()` returns.
 */
export function leaderGlyph(modifier: "mod" | "alt"): string {
  if (modifier === "alt") return "⌥";
  return isMac() ? "⌘" : "⌃";
}
