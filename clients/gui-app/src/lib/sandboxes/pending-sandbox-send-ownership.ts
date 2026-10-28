import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";

interface SendOwnership {
  readonly ready: Promise<boolean>;
  readonly release: () => void;
  granted: boolean;
  exclusive: boolean;
  mounted: number;
}

const ownerships = new Map<string, SendOwnership>();
const handedThisSession = new Set<string>();

/** An originating window may cancel before its task has been confirmed. */
export function markPendingSandboxSendHanded(id: string): void {
  handedThisSession.add(id);
}
export function forgetPendingSandboxSendHanded(id: string): void {
  handedThisSession.delete(id);
}
export function pendingSandboxSendHandedHere(id: string): boolean {
  return handedThisSession.has(id);
}

/**
 * Reserve before publishing a new send, so another window cannot reclaim its
 * still-unconfirmed task while the originating window creates that task.
 * Delivery IDs remain stable in shells without Web Locks.
 */
export function reservePendingSandboxSendOwnership(id: string): SendOwnership {
  const existing = ownerships.get(id);
  if (existing !== undefined) return existing;
  const abort = new AbortController();
  let resolveReady = (_ready: boolean): void => undefined;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let releaseHold = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let unsubscribe = (): void => undefined;
  const ownership: SendOwnership = {
    ready,
    granted: false,
    exclusive: false,
    mounted: 0,
    release: () => {
      if (ownerships.get(id) !== ownership) return;
      ownerships.delete(id);
      unsubscribe();
      abort.abort();
      grant(false);
      releaseHold();
    },
  };
  const grant = (granted: boolean): void => {
    ownership.granted = granted;
    resolveReady(granted);
  };
  ownerships.set(id, ownership);
  unsubscribe = usePendingSandboxSendStore.subscribe((state) => {
    if (!Object.hasOwn(state.sends, id) || state.sends[id].delivery !== null) {
      ownership.release();
    }
  });
  const navigatorWithLocks: { readonly locks?: LockManager } = navigator;
  const locks = navigatorWithLocks.locks;
  if (locks === undefined) {
    grant(true);
    return ownership;
  }
  void locks
    .request(
      `traycer:pending-sandbox-send:${id}`,
      { signal: abort.signal },
      async () => {
        // A queued window's hydrated snapshot may have been delivered or
        // cancelled already. Preserve its unsubmitted composer stages.
        await Promise.all([
          useStagedSandboxStore.persist.rehydrate(),
          usePendingSandboxSendStore.persist.rehydrate(),
        ]);
        if (abort.signal.aborted) return;
        ownership.exclusive = true;
        grant(true);
        await held;
      },
    )
    .catch(() => {
      // An unavailable lock service uses the same idempotent identities as a
      // shell without Web Locks. Cancellation never grants ownership.
      grant(!abort.signal.aborted);
    });
  return ownership;
}

/** An image upload that outlived its driver no longer owns its delivery. */
export function ownsPendingSandboxSend(id: string): boolean {
  return ownerships.get(id)?.granted === true;
}

/** Only an exclusive lock proves the window creating an unconfirmed task left. */
export function ownsPendingSandboxSendExclusively(id: string): boolean {
  const ownership = ownerships.get(id);
  return ownership?.granted === true && ownership.exclusive;
}

/** Hold ownership for a mounted driver; a remount keeps its reservation. */
export function holdPendingSandboxSendOwnership(id: string): {
  readonly ready: Promise<boolean>;
  readonly release: () => void;
} {
  const ownership = reservePendingSandboxSendOwnership(id);
  ownership.mounted += 1;
  return {
    ready: ownership.ready,
    release: () => {
      ownership.mounted -= 1;
      queueMicrotask(() => {
        if (ownership.mounted === 0) ownership.release();
      });
    },
  };
}
