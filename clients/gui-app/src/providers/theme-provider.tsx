import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { getResolvedTheme, subscribeResolvedTheme } from "@/lib/theme-applier";
import {
  ResolvedThemeContext,
  type ResolvedThemeContextValue,
} from "@/providers/use-resolved-theme";

interface ThemeProviderProps {
  children: ReactNode;
}

function applyPointerCursors(enabled: boolean): void {
  window.document.documentElement.classList.toggle("pointer-cursors", enabled);
}

function applyUiFontSize(size: number): void {
  window.document.documentElement.style.fontSize = `${size}px`;
}

function applyCodeFontSize(size: number): void {
  window.document.documentElement.style.setProperty(
    "--code-font-size",
    `${size}px`,
  );
}

export function ThemeProvider(props: ThemeProviderProps) {
  const { themePreset, pointerCursors, uiFontSize, codeFontSize } =
    useSettingsStore(
      useShallow((s) => ({
        themePreset: s.themePreset,
        pointerCursors: s.pointerCursors,
        uiFontSize: s.uiFontSize,
        codeFontSize: s.codeFontSize,
      })),
    );

  // Resolved light/dark mode is owned by `theme-applier.ts`; we only
  // mirror its snapshot into a React-readable value so consumers can use
  // it to key memos. The applier already wrote the cascade by the time
  // this returns the new snapshot.
  const resolvedTheme = useSyncExternalStore(
    subscribeResolvedTheme,
    getResolvedTheme,
    getResolvedTheme,
  );

  // Pointer-cursor and font-size flags don't participate in the xterm
  // race - no JS surface snapshots them via `getComputedStyle`. Effects
  // here are appropriate (single owner, runs after commit).
  useEffect(() => {
    applyPointerCursors(pointerCursors);
  }, [pointerCursors]);

  useEffect(() => {
    applyUiFontSize(uiFontSize);
  }, [uiFontSize]);

  useEffect(() => {
    applyCodeFontSize(codeFontSize);
  }, [codeFontSize]);

  const contextValue = useMemo<ResolvedThemeContextValue>(
    () => ({ resolvedTheme, themePreset }),
    [resolvedTheme, themePreset],
  );

  return (
    <ResolvedThemeContext.Provider value={contextValue}>
      {props.children}
    </ResolvedThemeContext.Provider>
  );
}
