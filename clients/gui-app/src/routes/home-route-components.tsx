import type { ReactNode } from "react";

/**
 * Route adapter for `/home`. The Home surface is mounted for the whole session
 * by `TopLevelTabHost`, outside the retention cap, so the route body itself has
 * nothing to render - the same shape as the `/epics` layout adapter.
 */
export function HomeRoute(): ReactNode {
  return null;
}
