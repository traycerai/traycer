import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";

export const BARRIER_ACTION_TIMEOUT_MS = 30_000;

/** After expiry, keep the gate closed this long for an in-flight Electron call to land. */
export const BARRIER_SETTLE_GRACE_MS = BARRIER_ACTION_TIMEOUT_MS;

export class BrowserJarSerializer {
  private readonly domainChains = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();
  /** Domain work captures this before queueing so later work cannot slip in front of a barrier. */
  private barrierGate: Promise<void> = Promise.resolve();

  /**
   * Whole-jar read that must not see a jar mid-barrier.
   * Capture the gate and register in `inFlight` synchronously.
   */
  readBehindBarrier<T>(
    read: () => Promise<T>,
    waitMs: number | null,
  ): Promise<JarReadOutcome<T>> {
    const gate = this.barrierGate;
    const run = (async (): Promise<JarReadOutcome<T>> => {
      if (waitMs === null) {
        await gate;
      } else if (!(await settlesWithin(gate, waitMs))) {
        return { ok: false, reason: "barrier-held" };
      }
      return { ok: true, value: await read() };
    })();
    const settled = run.then(ignore, ignore);
    this.inFlight.add(settled);
    void settled.then(() => {
      this.inFlight.delete(settled);
    });
    return run;
  }

  runOnDomain<T>(domain: string, action: () => Promise<T>): Promise<T> {
    const key = registrableDomain(domain) ?? domain;
    const previous = this.domainChains.get(key);
    const gate = this.barrierGate;
    const run = (async (): Promise<T> => {
      await gate;
      if (previous !== undefined) await previous;
      return await action();
    })();
    const settled = run.then(ignore, ignore);
    this.domainChains.set(key, settled);
    this.inFlight.add(settled);
    void settled.then(() => {
      this.inFlight.delete(settled);
      if (this.domainChains.get(key) === settled) this.domainChains.delete(key);
    });
    return run;
  }

  /** Publish the gate synchronously, chained behind the barrier ahead. */
  runOnEveryDomain<T>(
    action: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    const previousBarrier = this.barrierGate;
    const ahead = [...this.inFlight];
    let openGate = (): void => undefined;
    const ownGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    this.barrierGate = previousBarrier.then(() => ownGate);
    // Abort before the gate opens; the race only stops the caller, never the action.
    const controller = new AbortController();
    return (async (): Promise<T> => {
      let expire = (): void => undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        expire = (): void => reject(barrierExpiredError(timeoutMs));
      });
      let running = false;
      let gaveUp = false;
      const run = (async (): Promise<T> => {
        await previousBarrier;
        await Promise.all(ahead);
        if (controller.signal.aborted) throw barrierExpiredError(timeoutMs);
        running = true;
        return await action(controller.signal);
      })();
      const settled = run.then(ignore, ignore);
      const timer = setTimeout(() => {
        gaveUp = true;
        controller.abort();
        if (!running) {
          expire();
          openGate();
          return;
        }
        // In-flight Electron calls are not cancelled; wait the grace before forcing the gate open.
        const grace = setTimeout(() => {
          expire();
          openGate();
        }, BARRIER_SETTLE_GRACE_MS);
        grace.unref();
        void settled.then(() => {
          clearTimeout(grace);
          openGate();
        });
      }, timeoutMs);
      timer.unref();
      try {
        return await Promise.race([run, expired]);
      } finally {
        clearTimeout(timer);
        if (!gaveUp) openGate();
      }
    })();
  }
}

export type JarReadOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "barrier-held" };

function settlesWithin(gate: Promise<void>, waitMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, waitMs);
    timer.unref();
    void gate.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function barrierExpiredError(timeoutMs: number): Error {
  return new Error(
    `The whole-jar barrier did not settle within ${timeoutMs}ms; the jar gate was forced open.`,
  );
}

function ignore(): void {
  return undefined;
}
