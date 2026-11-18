/**
 * A `document.startViewTransition` the test drives (5.2).
 *
 * jsdom implements none of the View Transition API, so a suite that installs
 * nothing exercises `runLayoutEditorMotion`'s FALLBACK branch only - and on
 * that branch the session change is synchronous, which is precisely what the
 * production path is not. Both halves of the door defer their `apply` into the
 * update callback, and the bugs that live there (an exit whose teardown lands
 * after a re-open has already begun) are invisible without one of these.
 *
 * Shared rather than restated per suite: `editor-motion.test.ts` and
 * `editor-session.test.ts` need the same driveable transition, and two copies
 * are two chances for one to stop matching what the browser does.
 */
export class FakeViewTransition {
  private settle: (() => void) | null = null;
  private fail: (() => void) | null = null;
  readonly finished: Promise<void>;

  constructor(private readonly update: () => void) {
    this.finished = new Promise<void>((resolve, reject) => {
      this.settle = resolve;
      this.fail = () => reject(new Error("update callback threw"));
    });
  }

  runUpdate(): void {
    this.update();
  }

  finish(): void {
    this.settle?.();
  }

  /**
   * What a throwing update callback looks like from here. A skipped transition
   * fulfils `finished` instead, which is `finish()`.
   */
  reject(): void {
    this.fail?.();
  }
}

/**
 * Installs the fake and hands back the list it appends every started
 * transition to, newest last, plus the uninstall the suite's `afterEach` owes.
 */
export function installFakeViewTransitions(): {
  readonly transitions: Array<FakeViewTransition>;
  readonly uninstall: () => void;
} {
  const transitions: Array<FakeViewTransition> = [];
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    writable: true,
    value: (update: () => void) => {
      const transition = new FakeViewTransition(update);
      transitions.push(transition);
      return transition;
    },
  });
  return {
    transitions,
    uninstall: () => {
      Reflect.deleteProperty(document, "startViewTransition");
    },
  };
}
