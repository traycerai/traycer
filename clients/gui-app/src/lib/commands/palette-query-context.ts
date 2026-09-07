/**
 * Per-surface live query channel.
 * Each palette surface owns its own query state
 */
import { createContext, useContext } from "react";

const PaletteQueryContext = createContext<string>("");

export const PaletteQueryProvider = PaletteQueryContext.Provider;

export function usePaletteLiveQuery(): string {
  return useContext(PaletteQueryContext);
}
