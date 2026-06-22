import { createContext, use } from "react";

/**
 * Whether the surrounding pane tab layer is its pane's front (selected) tab.
 * Mounted-but-unselected keep-alive bodies are concealed with `display:none`
 * (`visibility:hidden` for terminals), so an unselected body is off screen
 * even though it stays mounted. Consumers combine this with `usePaneVisible()`
 * to know whether the surface is actually visible; pane focus
 * (`globallyActive`) is deliberately NOT part of this signal - a tab in an
 * unfocused split pane is still on screen.
 *
 * Defaults to `true` so isolated renders (tests, stories) behave as visible.
 * Component-free module per the repo's `*-context.ts` convention.
 */
export const TabBodySelectedContext = createContext<boolean>(true);

export function useTabBodySelected(): boolean {
  return use(TabBodySelectedContext);
}
