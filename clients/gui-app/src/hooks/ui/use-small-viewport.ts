import { useSyncExternalStore } from "react";

// Match Tailwind's sm exactly; the app-wide phone shell switches at md.
const SMALL_VIEWPORT_QUERY = "(width < 40rem)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(SMALL_VIEWPORT_QUERY);
  query.addEventListener("change", onChange);
  // Re-ask if WKWebView coalesces or drops change, as in subscribeToMobileQuery (use-narrow-window.ts).
  window.addEventListener("resize", onChange);
  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

export function useIsSmallViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(SMALL_VIEWPORT_QUERY).matches,
    () => false,
  );
}
