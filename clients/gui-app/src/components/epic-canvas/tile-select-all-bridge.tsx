import { useEffect, type ReactNode } from "react";
import { hasPlatformModKey } from "@/lib/keybindings/chord";
import { isEditableEventTarget } from "@/lib/keybindings/editable-target";
import { selectAllInActiveTile } from "@/lib/commands/tile-select-all";
import { isCanvasCoveredByBlocker } from "@/stores/active-tile-owner";

/**
 * The app's single owner of Ctrl/Cmd+A.
 *
 * One window listener rather than one per tile: two tiles both claiming the key
 * would race on `preventDefault` and let DOM order pick the winner, which is
 * exactly what the active-owner resolution exists to prevent.
 *
 * Deliberately not a `lib/keybindings` action - select-all is not rebindable,
 * and routing it through chord dispatch would put it in the conflict table
 * against user bindings for no gain.
 *
 * A text field keeps the native behavior (select the field, not the tile), and
 * the default also runs untouched whenever no tile owns the key, so the desktop
 * Edit > Select All role stays correct off-canvas.
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
      // No owner, but an overlay is frontmost with the canvas still mounted
      // behind it. Chromium's document-wide default would select those hidden
      // tiles, so swallow the key instead. With nothing behind the overlay the
      // native default is correct and runs untouched.
      if (isCanvasCoveredByBlocker()) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return null;
}
