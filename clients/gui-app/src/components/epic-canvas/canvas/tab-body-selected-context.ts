import { createContext, use } from "react";

/**
 * Mounted-but-unselected keep-alive bodies are concealed with `display:none` (`visibility:hidden` for terminals), so an unselected body is off screen even though it stays mounted.
 */
export const TabBodySelectedContext = createContext<boolean>(true);

export function useTabBodySelected(): boolean {
  return use(TabBodySelectedContext);
}
