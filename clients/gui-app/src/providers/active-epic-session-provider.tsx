/**
 * Read-only `EpicSessionContext` provider for surfaces that live OUTSIDE the
 * keep-alive epic panes (the hoisted sidebar column). The active pane's
 * `EpicSessionProvider` owns the session lifecycle - it acquires the handle
 * with a mounted refcount, claims desktop ownership, and releases on host /
 * user swaps. This provider deliberately does none of that: it projects the
 * registry's current handle for `epicId` via `useSyncExternalStore` and
 * `registry.peek` so that
 *
 * - subscribing never bumps the registry's MRU order (`peek`, not `get`) -
 *   rendering the sidebar must not make an epic count as recently used, and
 * - no second refcount is taken - the pane provider already holds one, so
 *   prune/release semantics stay exactly as before the sidebar was hoisted.
 *
 * The handle is therefore null until the pane provider has acquired the
 * session (deep-link resolution, desktop ownership claim in flight) and flips
 * non-null on the registry's own emit - consumers show their loading variants
 * meanwhile, exactly like the old in-pane `EpicSessionGate` fallback.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

export interface ActiveEpicSessionProviderProps {
  readonly epicId: string;
  readonly children: ReactNode;
}

export function ActiveEpicSessionProvider(
  props: ActiveEpicSessionProviderProps,
): ReactNode {
  const { epicId, children } = props;
  const registry = getOpenEpicRegistry();
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(listener),
    [registry],
  );
  const getSnapshot = useCallback(
    (): OpenEpicStoreHandle | null => registry.peek(epicId),
    [registry, epicId],
  );
  const handle = useSyncExternalStore(subscribe, getSnapshot);

  return (
    <EpicSessionContext.Provider value={handle}>
      {children}
    </EpicSessionContext.Provider>
  );
}
