import { useCallback } from "react";
import { create } from "zustand";
import type { StripSection } from "./strip-sections";

/**
 * Which Activity-view sections the person has folded, kept for the app
 * session and never persisted. A section with no entry is open.
 */
const useStripSectionFoldStore = create<{
  readonly folded: Readonly<Partial<Record<StripSection, boolean>>>;
}>(() => ({ folded: {} }));

/** Whether a section is folded, and how to flip it. */
export function useStripSectionFolded(
  section: StripSection,
): readonly [boolean, () => void] {
  const folded = useStripSectionFoldStore(
    (state) => state.folded[section] === true,
  );
  const toggle = useCallback((): void => {
    useStripSectionFoldStore.setState((state) => ({
      folded: { ...state.folded, [section]: state.folded[section] !== true },
    }));
  }, [section]);
  return [folded, toggle];
}
