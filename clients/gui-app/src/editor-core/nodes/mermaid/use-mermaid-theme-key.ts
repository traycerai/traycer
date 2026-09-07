import { useSyncExternalStore } from "react";
import {
  getMermaidThemeVersion,
  subscribeMermaidTheme,
} from "./mermaid-service";

const SERVER_KEY = 0;

function getServerSnapshot(): number {
  return SERVER_KEY;
}

/** Increments on mermaid theme flip. useSyncExternalStore so concurrent reads and SSR snapshots stay consistent. */
export function useMermaidThemeKey(): number {
  return useSyncExternalStore(
    subscribeMermaidTheme,
    getMermaidThemeVersion,
    getServerSnapshot,
  );
}
