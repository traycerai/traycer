import { useEffect, type ReactNode } from "react";
import { hasPlatformModKey } from "@/lib/keybindings/chord";
import { isEditableEventTarget } from "@/lib/keybindings/editable-target";
import { selectAllInActiveTile } from "@/lib/commands/tile-select-all";
import { isCanvasCoveredByBlocker } from "@/stores/active-tile-owner";

/**
 * One window listener rather than one per tile: two tiles both claiming the key would race on `preventDefault` and let DOM order pick the winner, which is exactly what the active-owner resolution exists to prevent.
 */
export function TileSelectAllBridge(): ReactNode {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "a" && event.key !== "A") return;
      if (!hasPlatformModKey(event)) return;
      if (event.altKey || event.shiftKey) return;
      if (isEditableEventTarget(event.target)) return;
      // preventDefault only once the selection actually moved - a tile that
      // owns the key but renders no selection root must not swallow it.
      if (selectAllInActiveTile()) {
        event.preventDefault();
        return;
      }
      // No owner, but an overlay is frontmost with the canvas still mounted behind it.
      // Chromium's document-wide default would select those hidden tiles, so swallow the key instead.
      if (isCanvasCoveredByBlocker()) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return null;
}
