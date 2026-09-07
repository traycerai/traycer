import * as React from "react";

import {
  readSafeAreaInsets,
  readSafeAreaInsetsServerSnapshot,
  subscribeToSafeAreaInsets,
  type SafeAreaInsets,
} from "@/lib/safe-area-insets";

/** Subscribed rather than read once, because Radix takes the padding as a plain value: a menu opened in
 * portrait would otherwise hold portrait geometry across a rotation for as long as it stays mounted. */
export function useSafeAreaCollisionPadding(): SafeAreaInsets {
  return React.useSyncExternalStore(
    subscribeToSafeAreaInsets,
    readSafeAreaInsets,
    readSafeAreaInsetsServerSnapshot,
  );
}
