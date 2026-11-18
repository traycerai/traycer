import * as React from "react";

import {
  readSafeAreaInsets,
  readSafeAreaInsetsServerSnapshot,
  subscribeToSafeAreaInsets,
  type SafeAreaInsets,
} from "@/lib/safe-area-insets";

/**
 * The device insets as Radix collision padding, on the terms `tooltip.tsx`
 * established (the sanctioned inset read - see `lib/safe-area-insets.ts`).
 *
 * Radix collides against the viewport, which includes the strips the app never
 * paints into, so a surface anchored near an edge finds "space" under the
 * status bar or the landscape sensor housing and renders into it instead of
 * flipping or shifting away from it. Padding the collision box by the insets
 * makes that space stop existing, which is what `#root`'s padding already does
 * for everything that is not portalled.
 *
 * Subscribed rather than read once, because Radix takes the padding as a plain
 * value: a menu opened in portrait would otherwise hold portrait geometry
 * across a rotation for as long as it stays mounted. The snapshot's identity is
 * stable, so a resize that leaves the insets alone re-renders nobody.
 *
 * This is a DEFAULT for the menu/popover primitives, not a floor. A caller that
 * passes its own padding replaces it, which is correct where the boundary that
 * matters is not the device edge - the settings pickers collide against their
 * dialog.
 */
export function useSafeAreaCollisionPadding(): SafeAreaInsets {
  return React.useSyncExternalStore(
    subscribeToSafeAreaInsets,
    readSafeAreaInsets,
    readSafeAreaInsetsServerSnapshot,
  );
}
