import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";

/**
 * The order in which this process is allowed to touch the `primary` jar
 * (universal-sign-in ticket 03).
 *
 * Everything that writes or empties the jar runs through here: the observed
 * sign-in merge, "clear cookies for this site", the host-driven evict, and
 * "forget all browser logins". Before it existed, the applier's "is a clear
 * running?" check was a read taken at one moment and acted on at a later one,
 * with an `await` in between - so a clear could begin, and finish, between the
 * check and the merge that trusted it. Serialising the two removes the interval
 * rather than narrowing it: the check and the write it authorises are now in the
 * same critical section, and the answer cannot change under them.
 *
 * The key is the registrable domain, so unrelated sites still proceed in
 * parallel - a merge for `example.com` must not wait behind a clear of
 * `other.test`, and only same-site work has an ordering to get wrong. "Forget
 * all" names no site, so it takes a barrier over every key instead.
 *
 * No timers anywhere: nothing here waits for a duration, and nothing gives up
 * after one. Work is admitted when the work before it has settled, which is a
 * fact rather than an estimate. Bounding the QUEUE is the caller's job - the
 * applier admits a frame through its per-connection budget before it queues.
 */
export class BrowserJarSerializer {
  /**
   * Tail of the work chain per domain key. An entry is deleted once it is both
   * settled and still the tail, so the map holds only the sites in flight.
   */
  private readonly domainChains = new Map<string, Promise<void>>();
  /** Every domain chain currently in flight, for a barrier to wait behind. */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * Resolves when no barrier is pending or running. Domain work captures it
   * before queueing, which is what stops work admitted after a barrier was
   * requested from slipping in front of it.
   */
  private barrierGate: Promise<void> = Promise.resolve();

  /** Runs `action` with no other jar work for the same registrable domain. */
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

  /**
   * Runs `action` with no other jar work at all - "forget all browser logins",
   * which empties every site at once and therefore has no key to queue behind.
   *
   * The gate is published SYNCHRONOUSLY, before the first await, so a
   * `runOnDomain` call made while the barrier is still waiting for the work
   * ahead of it queues behind the barrier rather than racing it.
   */
  runOnEveryDomain<T>(action: () => Promise<T>): Promise<T> {
    const previousBarrier = this.barrierGate;
    const ahead = [...this.inFlight];
    let openGate = (): void => undefined;
    this.barrierGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    return (async (): Promise<T> => {
      try {
        await previousBarrier;
        await Promise.all(ahead);
        return await action();
      } finally {
        openGate();
      }
    })();
  }
}

function ignore(): void {
  return undefined;
}
