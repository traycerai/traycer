import * as React from "react";
import {
  isMobileViewport,
  useIsMobileViewport,
} from "@/hooks/ui/use-mobile-viewport";

/** The same query as the `short-landscape` Tailwind variant in `index.css`. */
const SHORT_LANDSCAPE_QUERY =
  "(max-height: 560px) and (orientation: landscape)";

function subscribeToShortLandscape(onChange: () => void): () => void {
  const query = window.matchMedia(SHORT_LANDSCAPE_QUERY);
  query.addEventListener("change", onChange);
  // The same self-heal as `use-narrow-window.ts`: a dropped `change` cannot
  // wedge the layout, because the resize accompanying it re-asks.
  window.addEventListener("resize", onChange);
  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

function readShortLandscapeQuery(): boolean {
  return window.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
}

/** `useShortLandscape` for a decision made once, outside render. */
export function readShortLandscape(): boolean {
  return isMobileViewport() && readShortLandscapeQuery();
}

function readFalse(): boolean {
  return false;
}

/** A phone on its side: too short for what stacks comfortably upright. */
export function useShortLandscape(): boolean {
  const phoneShell = useIsMobileViewport();
  const short = React.useSyncExternalStore(
    subscribeToShortLandscape,
    readShortLandscapeQuery,
    readFalse,
  );
  return phoneShell && short;
}
