import { useState, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import {
  A2AOpenStoreContext,
  createA2AOpenStore,
  type A2AOpenState,
} from "./a2a-open-store-context";

interface A2AOpenStoreProviderProps {
  readonly children: ReactNode;
  /** `null` uses a fresh per-mount store (test isolation - see
   *  `ChatExpansionTestProviders`); production passes the registry-backed
   *  store keyed by tile instance id (ticket 5) so it survives a remount of
   *  that SAME instance - retention-cap or top-level eviction, or a hosted-
   *  eligibility flip; no longer an inner tab switch, and never a close (which
   *  evicts it) or a reopen (fresh instance id). See `retained-pane-chats.ts`. */
  readonly store: StoreApi<A2AOpenState> | null;
}

export function A2AOpenStoreProvider(props: A2AOpenStoreProviderProps) {
  const [fallbackStore] = useState(() => createA2AOpenStore(null));
  const store = props.store ?? fallbackStore;
  return (
    <A2AOpenStoreContext.Provider value={store}>
      {props.children}
    </A2AOpenStoreContext.Provider>
  );
}
