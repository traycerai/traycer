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
  const held = new Promise<void>((resolve) => {
    void locks
      .request(SOUNDTRACK_SESSION_LOCK, () => {
        turnCame = true;
        resolve();
        return hold;
      })
      .catch(() => undefined);
  });
  // Asked after the request, in the order the browser takes them, so the answer
  // has this window in it. Asked ahead of it, the answer could miss the whole
  // wait: another window can take the lock between the two. A window that has to
  // wait is pending here. One that holds the lock has had its turn by the time
  // the answer arrives, however many have queued behind it.
  const queued = new Promise<void>((resolve) => {
    void locks.query().then(
      (state) => {
        const waiting = state.pending?.some(
          (lock) => lock.name === SOUNDTRACK_SESSION_LOCK,
        );
        if (waiting === true && !turnCame) resolve();
      },
      () => undefined,
    );
  });
  return { held, queued, release };
}
