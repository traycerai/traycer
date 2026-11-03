const SOUNDTRACK_SESSION_LOCK = "traycer:soundtrack-session";

export interface SoundtrackSessionLock {
  /**
   * Settles when this window's turn comes, even if it has let go by then; null
   * when it holds the lock already.
   */
  readonly held: Promise<void> | null;
  /** Lets the lock go. Released while queued, its turn passes straight through. */
  readonly release: () => void;
}

/**
 * Queues for the one soundtrack session the app plays at a time and holds it
 * until released, so that a second window's gesture cannot start a second
 * stream over the first. A window waiting in the queue takes over when the
 * session ends or its window closes, which the browser sees to. The app origin
 * is a privileged secure scheme, so Web Locks span its windows; a shell without
 * them (tests, a plain browser tab) holds it at once.
 */
export function holdSoundtrackSessionLock(): SoundtrackSessionLock {
  const navigatorWithLocks: { readonly locks?: LockManager } = navigator;
  const locks = navigatorWithLocks.locks;
  if (locks === undefined) {
    return { held: null, release: () => undefined };
  }
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  const held = new Promise<void>((resolve) => {
    void locks
      .request(SOUNDTRACK_SESSION_LOCK, () => {
        resolve();
        return hold;
      })
      .catch(() => undefined);
  });
  return { held, release };
}
