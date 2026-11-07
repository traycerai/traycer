const SOUNDTRACK_SESSION_LOCK = "traycer:soundtrack-session";

export interface SoundtrackSessionLock {
  /**
   * Settles when this window's turn comes, even if it has let go by then; null
   * when it holds the lock already.
   */
  readonly held: Promise<void> | null;
  /**
   * Settles if the lock is taken and this window has to wait, and never if it
   * is free, so a free lock's short trip to the browser cannot read as a wait;
   * null when it holds the lock already.
   */
  readonly queued: Promise<void> | null;
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
    return { held: null, queued: null, release: () => undefined };
  }
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  let turnCame = false;
  // Asked just ahead of the request, in the order the browser takes them, so a
  // holder in the answer is another window, and never this one. Anyone queued is
  // queued behind a holder, so the holder is all there is to read. The request
  // does not wait for this: the place in the queue is taken here and now.
  const queued = new Promise<void>((resolve) => {
    void locks.query().then(
      (state) => {
        const taken = state.held?.some(
          (lock) => lock.name === SOUNDTRACK_SESSION_LOCK,
        );
        if (taken === true && !turnCame) resolve();
      },
      () => undefined,
    );
  });
  const held = new Promise<void>((resolve) => {
    void locks
      .request(SOUNDTRACK_SESSION_LOCK, () => {
        turnCame = true;
        resolve();
        return hold;
      })
      .catch(() => undefined);
  });
  return { held, queued, release };
}
