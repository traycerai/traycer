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
 * Resolved light/dark and preset for surfaces outside Tailwind. `theme-applier.ts` mutates `<html>` before this hook's snapshot propagates.
 */
export function useResolvedTheme(): ResolvedThemeContextValue {
  const value = use(ResolvedThemeContext);
  if (value === null) {
    throw new Error("useResolvedTheme must be called inside <ThemeProvider>.");
  }
  return value;
}
