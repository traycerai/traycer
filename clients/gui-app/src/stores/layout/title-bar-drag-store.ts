import { create } from "zustand";
import { useEffect } from "react";

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
