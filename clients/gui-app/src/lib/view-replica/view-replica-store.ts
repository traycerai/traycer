import { useCallback, useMemo, useSyncExternalStore } from "react";
import { createIndexedDbViewReplicaBackend } from "@traycer-clients/shared/view-replica/indexeddb-backend";
import {
  viewReplicaSlotKey,
  type ViewReplicaAddress,
} from "@traycer-clients/shared/view-replica/identity";
import type { ViewReplicaService } from "@traycer-clients/shared/view-replica/service";
import {
  ViewReplicaStore,
  type ViewReplicaEviction,
} from "@traycer-clients/shared/view-replica/store";
import type { CloudVerdictLoss } from "@/stores/auth/auth-store";
import { persistKey } from "@/lib/persist/keys";

/** One origin database for every account; pages are keyed account first. */
export const VIEW_REPLICA_DB_NAME = persistKey("view-replica-v1");

/**
 * This renderer's replica tier. Each window warms its own memory from the
 * shared database at sign-in and writes the answers it receives.
 */
export const viewReplicaStore = new ViewReplicaStore(
  createIndexedDbViewReplicaBackend(
    () => globalThis.indexedDB,
    VIEW_REPLICA_DB_NAME,
  ),
);

/**
 * The cached page at `address` that may paint now, or `null`: read from the
 * warmed store and admitted through the service's paint gate, synchronously.
 * Re-reads when the store changes or the gate's registration does, and
 * returns the same page object while neither has.
 */
export function useViewReplicaPaint<Page>(
  service: ViewReplicaService<Page>,
  address: ViewReplicaAddress | null,
): Page | null {
  const read = useMemo(() => createPaintReader(service), [service]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeStore = viewReplicaStore.subscribe(listener);
      const unsubscribeGate = service.subscribe(listener);
      return () => {
        unsubscribeStore();
        unsubscribeGate();
      };
    },
    [service],
  );
  return useSyncExternalStore(subscribe, () => read(address));
}

function createPaintReader<Page>(
  service: ViewReplicaService<Page>,
): (address: ViewReplicaAddress | null) => Page | null {
  let last: {
    readonly slot: string;
    readonly storeVersion: number;
    readonly gateVersion: number;
    readonly page: Page | null;
  } | null = null;
  return (address) => {
    if (address === null) return null;
    const slot = viewReplicaSlotKey(address);
    const storeVersion = viewReplicaStore.version();
    const gateVersion = service.version();
    if (
      last !== null &&
      last.slot === slot &&
      last.storeVersion === storeVersion &&
      last.gateVersion === gateVersion
    ) {
      return last.page;
    }
    const hit = viewReplicaStore.read(service, address);
    const page =
      hit === null
        ? null
        : service.paintableFrom(service.admitFirstPaint(hit.page));
    last = { slot, storeVersion, gateVersion, page };
    return page;
  };
}

/**
 * What losing the cloud verdict does to the replica, by why it was lost: an
 * unreachable authn or a refused token keeps the pages, a refused account
 * drops them. `ended-elsewhere` keeps them too: another window saw a refusal
 * this one cannot classify, and only a confirmed account refusal removes.
 */
export function viewReplicaEvictionForVerdictLoss(
  loss: CloudVerdictLoss,
  accountId: string,
): ViewReplicaEviction {
  switch (loss) {
    case "unreachable":
      return { kind: "transport-unavailable" };
    case "session-rejected":
    case "ended-elsewhere":
      return { kind: "credential-refused" };
    case "account-unavailable":
      return { kind: "account-refused", accountId };
  }
}
