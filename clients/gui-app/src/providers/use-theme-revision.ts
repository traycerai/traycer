import { useSyncExternalStore } from "react";
import { getThemeRevision, subscribeResolvedTheme } from "@/lib/theme-applier";

/** Updates only after the active palette has reached the CSS cascade. */
export function useThemeRevision(): number {
  return useSyncExternalStore(
    subscribeResolvedTheme,
    getThemeRevision,
    getThemeRevision,
  );
}
