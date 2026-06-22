/**
 * Per-surface live query channel. Each palette surface owns its own query state
 * - the modal ⌘K palette keeps it in the command-palette store, while every
 * inline in-pane opener keeps its own local `useState`. Opener sub-pages that
 * pre-filter large lists (Files / Diff) must filter by the query of the surface
 * they render in, NOT a single global store; otherwise typing in the modal
 * palette bleeds into the list of an open in-pane opener (they would share the
 * store query). Each surface provides its query through this context and the
 * sub-pages read it via `usePaletteLiveQuery`.
 */
import { createContext, useContext } from "react";

const PaletteQueryContext = createContext<string>("");

export const PaletteQueryProvider = PaletteQueryContext.Provider;

export function usePaletteLiveQuery(): string {
  return useContext(PaletteQueryContext);
}
