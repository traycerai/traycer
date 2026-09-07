import { isMobileApp } from "@/lib/mobile-app";

/**
 * Whether keyboard-shortcut hints may be shown.
 * The single place this policy is decided - every surface that advertises a chord asks here (directly, or through `<ShortcutHint>` / a self-gating hint component) rather than carrying its own condition.
 */
export function shortcutHintsVisible(): boolean {
  return !isMobileApp();
}
