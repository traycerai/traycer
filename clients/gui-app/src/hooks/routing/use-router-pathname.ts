import { useSyncExternalStore } from "react";

/**
 * Narrow structural interface - anything with a TanStack-style history.
 * The real `AppRouter` from `@/router` satisfies it via duck typing; tests
 * pass a tiny stub without faking the full router surface.
 */
export interface RouterWithHistory {
  readonly history: {
    subscribe(callback: () => void): () => void;
    readonly location: { readonly pathname: string };
  };
}

/**
 * Reactive subscription to the router's pathname. Used by the gate-bypass
 * decision in `TraycerAppRouter` so all gates re-evaluate on every
 * navigation, including programmatic `router.navigate(...)` (which
 * `popstate` does not fire on).
 */
export function useRouterPathname(router: RouterWithHistory): string {
  return useSyncExternalStore(
    (callback) => router.history.subscribe(callback),
    () => router.history.location.pathname,
    () => router.history.location.pathname,
  );
}
