import { create } from "zustand";
import {
  useCallback,
  useEffect,
  useId,
  type Ref,
  type RefCallback,
} from "react";

/**
 * Electron title-bar drag regions (`-webkit-app-region: drag`) swallow every
 * mouse event at the OS level, so a click there never reaches the renderer -
 * whatever is painted on top. An overlay over the header or the side strip
 * takes no clicks where a drag region lies under it, and a click on the empty
 * title-bar area cannot dismiss it (Radix never sees the outside pointer-down).
 *
 * While a suppressor is registered here the header and the side strip drop
 * their drag regions to `no-drag`. Every overlay primitive in `components/ui/`
 * registers one for as long as its content is mounted
 * (`useOverlayDragSuppressionRef`); `useTitleBarDragSuppression` is for a
 * surface that is not one of them. Keyed per registrant so several can hold
 * one independently and dragging only returns once all have released.
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

export function useTitleBarDragSuppression(
  key: string,
  suppressed: boolean,
): void {
  const setTitleBarDragSuppressed = useTitleBarDragStore(
    (state) => state.setSuppressed,
  );

  useEffect(() => {
    setTitleBarDragSuppressed(key, suppressed);
    return () => setTitleBarDragSuppressed(key, false);
  }, [key, suppressed, setTitleBarDragSuppressed]);
}

/**
 * The ref for an overlay primitive's content element (dialog, sheet, drawer,
 * popover, menus, select). An overlay can paint anywhere over the window,
 * including over a drag region, where its clicks would never arrive. The
 * suppressor is held exactly while the content element is in the DOM, which
 * is while the overlay presents: Radix renders the wrapper while closed but
 * mounts the element only when open (Select's closed item fragment takes no
 * ref).
 *
 * The release is a ref CLEANUP, never a `ref(null)` call: Radix's Presence
 * composes refs from the ones current at detach time, and a Select swapping
 * its content for the closed fragment has already replaced this ref there, so
 * a null call never arrives. A returned cleanup is captured at attach time and
 * always runs; a null call releases too, for composers that drop cleanups.
 * The caller's own ref is forwarded here, its cleanup included. Memoized so a
 * re-render does not re-attach it.
 */
export function useOverlayDragSuppressionRef<T>(
  ref: Ref<T> | undefined,
): RefCallback<T> {
  const key = `overlay:${useId()}`;
  const setTitleBarDragSuppressed = useTitleBarDragStore(
    (state) => state.setSuppressed,
  );
  return useCallback(
    (node: T | null) => {
      const releaseCallerRef = attachRef(ref, node);
      setTitleBarDragSuppressed(key, node !== null);
      if (node === null) return;
      return () => {
        setTitleBarDragSuppressed(key, false);
        releaseCallerRef();
      };
    },
    [key, ref, setTitleBarDragSuppressed],
  );
}

function attachRef<T>(ref: Ref<T> | undefined, node: T | null): () => void {
  if (typeof ref === "function") {
    const cleanup = ref(node);
    return typeof cleanup === "function" ? cleanup : () => ref(null);
  }
  if (ref !== null && ref !== undefined) {
    ref.current = node;
    return () => {
      ref.current = null;
    };
  }
  return () => undefined;
}
