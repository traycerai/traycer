const LOCK_NAME = "traycer:soundtrack-session";

interface Place {
  readonly granted: () => Promise<void>;
  readonly done: () => void;
}

/**
 * The one exclusive, first-come lock `holdSoundtrackSessionLock` asks for, shared
 * by every window in a test as one app origin's Web Locks are.
 *
 * The browser's lock task queue processes each request (it takes its place) and
 * each query (it takes its snapshot) in turn, and keeps one window's own
 * operations in order but promises nothing across windows. Left alone, each
 * operation is processed as it is made. After `holdOperations`, it waits for
 * `process`, which runs them in the order the test names. Apart from that, after
 * `holdAnswers` a grant and an answer reach their window only when the test
 * delivers them, each kind on its own, which is the gap a real browser has
 * between a lock changing hands and the window hearing.
 */
export class FakeLockManager {
  private owner: Place | null = null;
  private readonly waiting: Place[] = [];
  private holdingBack = false;
  private readonly grants: Array<() => void> = [];
  private readonly answers: Array<() => void> = [];
  private holdingOperations = false;
  private readonly operations: Array<() => void> = [];

  /** From now on, a request or a query waits, unprocessed, for `process`. */
  holdOperations(): void {
    this.holdingOperations = true;
  }

  /**
   * Processes the operations held, by the place each was made in, since the
   * first one held: 0 is the first request or query made after `holdOperations`.
   */
  process(order: readonly number[]): void {
    const operations = this.operations.splice(0);
    for (const place of order) operations[place]();
  }

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
    return new Promise((resolve) => {
      this.run(() => {
        const snapshot: LockManagerSnapshot = {
          held: this.owner === null ? [] : [{ name: LOCK_NAME }],
          pending: this.waiting.map(() => ({ name: LOCK_NAME })),
        };
        const answer = (): void => {
          resolve(snapshot);
        };
        if (this.holdingBack) this.answers.push(answer);
        else answer();
      });
    });
  }

  request(_name: string, granted: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      this.run(() => {
        const place: Place = { granted, done: resolve };
        if (this.owner === null) this.give(place);
        else this.waiting.push(place);
      });
    });
  }

  private run(operation: () => void): void {
    if (this.holdingOperations) this.operations.push(operation);
    else operation();
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
