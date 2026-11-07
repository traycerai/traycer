const LOCK_NAME = "traycer:soundtrack-session";

interface Place {
  readonly granted: () => Promise<void>;
  readonly done: () => void;
}

/**
 * The one exclusive, first-come lock `holdSoundtrackSessionLock` asks for, shared
 * by every window in a test as one app origin's Web Locks are.
 *
 * A request takes its place in the queue when it is made, and a query's snapshot
 * is taken when it is asked, as the browser's lock task queue does. Left alone,
 * the grant and the answer reach their window at once. After `holdAnswers`, they
 * reach it only when the test delivers them, each kind on its own, which is the
 * gap a real browser has between a lock changing hands and the window hearing.
 */
export class FakeLockManager {
  private owner: Place | null = null;
  private readonly waiting: Place[] = [];
  private holdingBack = false;
  private readonly grants: Array<() => void> = [];
  private readonly answers: Array<() => void> = [];

  /** From now on, grants and query answers wait for the test to deliver them. */
  holdAnswers(): void {
    this.holdingBack = true;
  }

  /** Delivers every query answer held back. */
  deliverQuery(): void {
    for (const answer of this.answers.splice(0)) answer();
  }

  /** Delivers every grant held back, to the windows whose turn it is. */
  deliverGrant(): void {
    for (const grant of this.grants.splice(0)) grant();
  }

  query(): Promise<LockManagerSnapshot> {
    const snapshot: LockManagerSnapshot = {
      held: this.owner === null ? [] : [{ name: LOCK_NAME }],
    };
    return new Promise((resolve) => {
      const answer = (): void => {
        resolve(snapshot);
      };
      if (this.holdingBack) this.answers.push(answer);
      else answer();
    });
  }

  request(_name: string, granted: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const place: Place = { granted, done: resolve };
      if (this.owner === null) this.give(place);
      else this.waiting.push(place);
    });
  }

  private give(place: Place): void {
    this.owner = place;
    const grant = (): void => {
      void place.granted().then(() => {
        this.owner = null;
        const next = this.waiting.shift();
        if (next !== undefined) this.give(next);
        place.done();
      });
    };
    if (this.holdingBack) this.grants.push(grant);
    else grant();
  }
}
