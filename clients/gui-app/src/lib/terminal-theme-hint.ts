import { use, useMemo } from "react";
import { formatHex, parse } from "culori";
import type { TerminalThemeHint } from "@traycer/protocol/host/terminal/unary-schemas";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import { readCssVar } from "@/lib/css-color";

// Per-appearance fallbacks matching the neutral canvas tokens, for the
// headless/jsdom case where the cascade resolves nothing.
const LIGHT_FALLBACK: TerminalThemeHint = {
  appearance: "light",
  foreground: "#252525",
  background: "#ffffff",
};
const DARK_FALLBACK: TerminalThemeHint = {
  appearance: "dark",
  foreground: "#fafafa",
  background: "#0a0a0a",
};

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * A CSS color expression reduced to the strict `#rrggbb` the terminal-create
 * protocol accepts (the host interpolates it into an OSC report written to
 * the PTY, so nothing wider may cross the wire). `null` for anything culori
 * cannot parse - including an unset variable's empty string.
 */
function hexify(value: string): string | null {
  if (value.length === 0) return null;
  const parsed = parse(value);
  if (parsed === undefined) return null;
  const formatted = formatHex(parsed).toLowerCase();
  return HEX_COLOR_PATTERN.test(formatted) ? formatted : null;
}

/**
 * The spawning client's resolved terminal appearance, sent on
 * `terminal.create` so the host can answer a TUI's OSC 10/11
 * foreground/background queries (TUI light/dark detection - the query fires
 * at startup, before this client's xterm has subscribed, so only the host
 * can answer it). Uses the same `--canvas`/`--canvas-foreground` tokens the
 * xterm theme itself renders with (see `terminal-theme.ts`), so the answer
 * matches what this viewer actually paints.
 */
export function buildTerminalThemeHint(
  resolvedTheme: "light" | "dark",
  doc: Document,
): TerminalThemeHint {
  const fallback = resolvedTheme === "dark" ? DARK_FALLBACK : LIGHT_FALLBACK;
  return {
    appearance: resolvedTheme,
    foreground:
      hexify(readCssVar(doc, "--canvas-foreground")) ?? fallback.foreground,
    background: hexify(readCssVar(doc, "--canvas")) ?? fallback.background,
  };
}

/**
 * React-side entry point, memoized on the same identity as
 * `useTerminalTheme` so the hint tracks live light/dark and preset switches.
 * The hint only matters at `terminal.create` time - a later theme change
 * does not (and cannot) re-answer a TUI that already probed.
 *
 * Tolerates a missing <ThemeProvider> (test harnesses render the terminal
 * bootstrap hook bare): the hint is a best-effort heuristic, so it degrades
 * to reading the `.dark` cascade marker `theme-applier.ts` owns instead of
 * making theme context a hard dependency of terminal creation.
 */
export function useTerminalThemeHint(): TerminalThemeHint {
  const themeContext = use(ResolvedThemeContext);
  const resolvedTheme = themeContext?.resolvedTheme ?? null;
  const themePreset = themeContext?.themePreset ?? null;
  return useMemo(() => {
    // Part of the memo identity for the same reason as `useTerminalTheme`:
    // the preset's values flow in through the CSS cascade, not the closure.
    themePreset;
    const appearance =
      resolvedTheme ??
      (document.documentElement.classList.contains("dark") ? "dark" : "light");
    return buildTerminalThemeHint(appearance, document);
  }, [resolvedTheme, themePreset]);
}
