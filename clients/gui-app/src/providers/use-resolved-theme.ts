import { createContext, use } from "react";
import type { ResolvedTheme } from "@/lib/theme-applier";
import type { ThemePreset } from "@/lib/theme-presets";

export type { ResolvedTheme };

export interface ResolvedThemeContextValue {
  readonly resolvedTheme: ResolvedTheme;
  readonly themePreset: ThemePreset;
}

export const ResolvedThemeContext =
  createContext<ResolvedThemeContextValue | null>(null);

/**
 * Read the resolved light/dark mode and active preset. Used by surfaces
 * that paint outside the Tailwind cascade (xterm.js, mermaid, canvas-
 * backed renderers) and need to recompute their palette when the user
 * toggles theme or the OS dark-mode preference flips while
 * `theme === "system"`.
 *
 * The DOM cascade is owned by `theme-applier.ts`, which mutates `<html>`
 * synchronously inside the Zustand store listener - *before* React
 * re-renders the consumer tree. By the time this hook's snapshot
 * propagates and a child component reads `getComputedStyle`, the cascade
 * already reflects the new theme.
 */
export function useResolvedTheme(): ResolvedThemeContextValue {
  const value = use(ResolvedThemeContext);
  if (value === null) {
    throw new Error("useResolvedTheme must be called inside <ThemeProvider>.");
  }
  return value;
}
