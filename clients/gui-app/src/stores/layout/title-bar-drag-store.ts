import { create } from "zustand";

/**
 * Electron title-bar drag regions (`-webkit-app-region: drag`) swallow every
 * mouse event at the OS level, so a click there never reaches the renderer -
 * which means a popover anchored in the header can't be dismissed by clicking
 * the empty title-bar area (Radix never sees the outside pointer-down).
 *
 * While such an overlay is open it registers a suppressor here; the header then
 * drops its drag regions to `no-drag` so a title-bar click lands as an ordinary
 * outside pointer-down and the overlay dismisses. Keyed per overlay so several
 * can register independently and dragging only returns once all have closed.
 */
interface TitleBarDragState {
  readonly suppressors: ReadonlySet<string>;
  readonly setSuppressed: (key: string, suppressed: boolean) => void;
}

export const useTitleBarDragStore = create<TitleBarDragState>((set) => ({
  suppressors: new Set<string>(),
  setSuppressed: (key, suppressed) =>
    set((state) => {
      if (state.suppressors.has(key) === suppressed) return state;
      const suppressors = new Set(state.suppressors);
      if (suppressed) suppressors.add(key);
      else suppressors.delete(key);
      return { suppressors };
    }),
}));

export function useTitleBarDraggingSuppressed(): boolean {
  return useTitleBarDragStore((state) => state.suppressors.size > 0);
}
