import { v4 as uuidv4 } from "uuid";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";

export interface PendingSendOwnerStamp {
  readonly episode: string;
}

interface SendOwnership {
  readonly ready: Promise<boolean>;
  readonly release: () => void;
  readonly stamp: PendingSendOwnerStamp;
  readonly onRelease: Set<() => void>;
  granted: boolean;
  exclusive: boolean;
  mounted: number;
}

const ownerships = new Map<string, SendOwnership>();
const handedThisSession = new Set<string>();

function sendLockName(id: string): string {
  return `traycer:pending-sandbox-send:${id}`;
}

function sendTenureLockName(id: string, stamp: PendingSendOwnerStamp): string {
  return `${sendLockName(id)}:tenure:${stamp.episode}`;
}

export function pendingSandboxSendOwnerStamp(
  id: string,
): PendingSendOwnerStamp | null {
  const owner = ownerships.get(id);
  return owner?.granted === true ? owner.stamp : null;
}

export async function pendingSandboxSendOwnerIsCurrent(
  id: string,
  stamp: PendingSendOwnerStamp,
): Promise<boolean> {
  const owner = pendingSandboxSendOwnerStamp(id);
  if (owner !== null) return owner.episode === stamp.episode;
  try {
    const { held } = await navigator.locks.query();
    const primary = held?.find((lock) => lock.name === sendLockName(id));
    const tenure = held?.find(
      (lock) => lock.name === sendTenureLockName(id, stamp),
    );
    return (
      primary?.clientId !== undefined &&
      tenure?.clientId === primary.clientId &&
      tenure.mode === "exclusive"
    );
  } catch {
    return false;
  }
}

/** A shared waiter runs as soon as the specific owner's exclusive witness releases. */
export function watchPendingSandboxSendTenure(
  id: string,
  stamp: PendingSendOwnerStamp,
  onLost: () => void,
): () => void {
  const owner = ownerships.get(id);
  if (owner?.granted === true && owner.stamp.episode === stamp.episode) {
    owner.onRelease.add(onLost);
    return () => {
      owner.onRelease.delete(onLost);
    };
  }
  const abort = new AbortController();
  const navigatorWithLocks: { readonly locks?: LockManager } = navigator;
  void navigatorWithLocks.locks
    ?.request(
      sendTenureLockName(id, stamp),
      { mode: "shared", signal: abort.signal },
      onLost,
    )
    .catch(() => {
      if (!abort.signal.aborted) onLost();
    });
  return () => abort.abort();
}

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
    stamp: { episode: uuidv4() },
    onRelease: new Set(),
    granted: false,
    exclusive: false,
    mounted: 0,
    release: () => {
      if (ownerships.get(id) !== ownership) return;
      ownerships.delete(id);
      unsubscribe();
      for (const onLost of ownership.onRelease) onLost();
      ownership.onRelease.clear();
      if (ownership.granted)
        usePendingSandboxSendStore
          .getState()
          .clearDispatchView(id, ownership.stamp);
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
    .request(sendLockName(id), { signal: abort.signal }, async () => {
      // A queued window's hydrated snapshot may have been delivered or
      // cancelled already. Preserve its unsubmitted composer stages.
      await Promise.all([
        useStagedSandboxStore.persist.rehydrate(),
        usePendingSandboxSendStore.persist.rehydrate(),
      ]);
      if (abort.signal.aborted) return;
      await locks
        .request(
          sendTenureLockName(id, ownership.stamp),
          { signal: abort.signal },
          async () => {
            if (abort.signal.aborted) return;
            ownership.exclusive = true;
            grant(true);
            await held;
          },
        )
        .catch(() => grant(false));
    })
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
