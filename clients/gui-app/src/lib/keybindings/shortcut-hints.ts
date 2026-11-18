import { isMobileApp } from "@/lib/mobile-app";

/**
 * Whether keyboard-shortcut hints may be shown. The single place this policy
 * is decided - every surface that advertises a chord asks here (directly, or
 * through `<ShortcutHint>` / a self-gating hint component) rather than
 * carrying its own condition.
 *
 * The installed mobile app is the one shell whose primary input has no
 * modifier keys at all, so a `⌘↩` chip there names keys the user cannot press.
 * It is the PRODUCT signal, not a viewport one: a narrow desktop window still
 * has a keyboard and keeps its hints (see `lib/mobile-app.ts`).
 *
 * This hides the hint only. Every binding stays registered and dispatchable,
 * because a tablet running the installed app can have a hardware keyboard
 * attached - the keys work, they are just not advertised.
 */
export function shortcutHintsVisible(): boolean {
  return !isMobileApp();
}
