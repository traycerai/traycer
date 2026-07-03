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
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  buildFontFamilyValue,
} from "@/lib/default-font-stacks";
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

// Chosen font names are set as an inline override of the same CSS variable
// the stylesheet default lives on, with the default stack appended as a
// fallback; `null` removes the override so the stylesheet default applies.
function applyUiFontFamily(family: string | null): void {
  const style = window.document.documentElement.style;
  if (family === null) {
    style.removeProperty("--traycer-font-ui");
    return;
  }
  style.setProperty(
    "--traycer-font-ui",
    buildFontFamilyValue(family, DEFAULT_UI_FONT_STACK),
  );
}

function applyCodeFontFamily(family: string | null): void {
  const style = window.document.documentElement.style;
  if (family === null) {
    style.removeProperty("--traycer-font-mono");
    return;
  }
  style.setProperty(
    "--traycer-font-mono",
    buildFontFamilyValue(family, DEFAULT_MONO_FONT_STACK),
  );
}

export function ThemeProvider(props: ThemeProviderProps) {
  const {
    themePreset,
    pointerCursors,
    uiFontSize,
    codeFontSize,
    uiFontFamily,
    codeFontFamily,
  } = useSettingsStore(
    useShallow((s) => ({
      themePreset: s.themePreset,
      pointerCursors: s.pointerCursors,
      uiFontSize: s.uiFontSize,
      codeFontSize: s.codeFontSize,
      uiFontFamily: s.uiFontFamily,
      codeFontFamily: s.codeFontFamily,
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

  useEffect(() => {
    applyUiFontFamily(uiFontFamily);
  }, [uiFontFamily]);

  useEffect(() => {
    applyCodeFontFamily(codeFontFamily);
  }, [codeFontFamily]);

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
