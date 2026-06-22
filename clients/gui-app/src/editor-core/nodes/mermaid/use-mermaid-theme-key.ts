import { useSyncExternalStore } from "react";
import {
  getMermaidThemeVersion,
  subscribeMermaidTheme,
} from "./mermaid-service";

const SERVER_KEY = 0;

function getServerSnapshot(): number {
  return SERVER_KEY;
}

/**
 * Reactive hook over mermaid's theme-change broadcast. Returns a number that
 * increments on every theme flip - pass it as a dependency to render effects
 * that should re-run when the page theme changes.
 *
 * Backed by `useSyncExternalStore` rather than a manual `useEffect` +
 * `subscribeMermaidTheme(...)` + local state, so concurrent React reads
 * remain consistent and SSR snapshots stay stable.
 */
export function useMermaidThemeKey(): number {
  return useSyncExternalStore(
    subscribeMermaidTheme,
    getMermaidThemeVersion,
    getServerSnapshot,
  );
}
