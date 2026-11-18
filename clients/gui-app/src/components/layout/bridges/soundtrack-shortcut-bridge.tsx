import { useEffect, type ReactNode } from "react";
import { toggleSoundtrack } from "@/lib/commands/actions/soundtrack";
import { isActionAvailable } from "@/lib/keybindings/actions";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";

/**
 * Registers the soundtrack's palette row and keybinding with the keybinding
 * registry, mounted once per window.
 */
export function SoundtrackShortcutBridge(): ReactNode {
  useEffect(() => {
    if (!isActionAvailable("soundtrack.toggle")) return undefined;
    return registerDynamicActionHandler("soundtrack.toggle", toggleSoundtrack);
  }, []);
  return null;
}
