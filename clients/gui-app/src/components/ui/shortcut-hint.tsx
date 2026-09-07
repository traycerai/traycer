import type { ReactNode } from "react";

import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";

interface ShortcutHintProps {
  /** The hint and any chrome that exists only to carry it - a trailing `<Kbd>`, a "Shortcut" row, a legend strip.
   * Wrap enough that nothing empty is left behind, and never the labelled control itself. */
  readonly children: ReactNode;
}

/** Every surface that advertises a chord goes through this (or through a hint component that gates itself on
 * the same `shortcutHintsVisible`), so the policy is stated once instead of at each call site. */
export function ShortcutHint(props: ShortcutHintProps) {
  if (!shortcutHintsVisible()) return null;
  return <>{props.children}</>;
}
