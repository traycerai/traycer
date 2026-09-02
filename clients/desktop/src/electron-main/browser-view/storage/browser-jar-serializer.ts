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
 * Ordering never waits on a duration: work is admitted when the work before it
 * has SETTLED, which is a fact rather than an estimate. The single timer below
 * is a liveness escape and decides no ordering - see
 * {@link BARRIER_ACTION_TIMEOUT_MS}. Bounding the QUEUE is the caller's job -
 * the applier admits a frame through its per-connection budget before it
 * queues.
 */
/**
 * How long a whole-jar barrier may hold the gate closed before it is forced
 * open (browser-security-hardening H11).
 *
 * NOT an ordering decision, and not an estimate of how long a forget takes:
 * ordering here rests on a fact - the gate opens when the barrier's own work
 * settles, and every path through `runOnEveryDomain` already opens it in a
 * `finally`, success or failure. That fact covers everything except the one
 * case no fact can: a Chromium call that never settles at all (a wedged CDP
 * attach inside "forget all browser logins"). A promise that never resolves
 * emits no event to order against, so the only way to bound it is elapsed
 * time. Without this, one wedged call froze every cookie operation in the
 * process for its whole lifetime.
 *
 * Chosen an order of magnitude above any real forget (which clears partitions
 * locally, in well under a second) so it can only ever fire on a wedge, never
 * on a slow machine.
 *
 * Two things it is NOT. It is not a per-action budget: the bound is armed
 * before the wait for the work ahead, so a barrier queued behind another
 * shares the elapsed time with it and a chain of them is bounded in total
 * rather than each getting a fresh 30s to act in - and a barrier whose time
 * runs out while it is still waiting GIVES UP (its caller learns so, its
 * action never runs) rather than running late under no barrier; a forget-all
 * confirmed while a login import sits on a minutes-long keystore prompt
 * fails and is retried after, it does not empty the jar behind the user's
 * back. And it is not what orders a
 * forget against a host's observations - that is the forget ledger's revision
 * and its ack (`browser-forget-ledger.ts`), which decide on facts and would
 * still hold if this bound fired mid-forget. This only stops a wedged call
 * from freezing every cookie operation in the process for its lifetime.
 */
/**
 * The whole-jar barrier's budget for forget-all: a clear that has not settled
 * in this long is wedged, and the per-domain work queued behind it is let
 * through. A caller with a longer bounded action (the login import, which
 * writes every chosen site) passes its own budget and reads the abort signal.
 */
export const BARRIER_ACTION_TIMEOUT_MS = 30_000;

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
   * ahead of it queues behind the barrier rather than racing it. It is
   * CHAINED behind the barrier ahead's gate: whatever this barrier's timer
   * does, its gate cannot open while the one before it still holds the jar.
   *
   * A barrier whose time runs out while it is still WAITING gives up: the
   * caller is answered with the expiry, and the action never starts. The one
   * outcome worse than a forget-all that failed is one that reported failure
   * and then emptied the jar minutes later, under no barrier at all. A
   * barrier whose time runs out while its action is RUNNING aborts the
   * signal and opens its gate; the action reads the signal between its steps
   * and stops.
   */
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
    // Aborted the moment the barrier expires, BEFORE the gate opens: an
    // action that is still running when its time is up (a long login import)
    // must stop mutating the jar, since the work queued behind it is about to
    // be admitted. The action reads the signal between its steps; the race
    // below only stops the caller waiting, never the action itself.
    const controller = new AbortController();
    return (async (): Promise<T> => {
      // Armed before the first await so it covers the whole barrier: the wait
      // for the work ahead can wedge on the same kind of hung call the action
      // can.
      let expire = (): void => undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        expire = (): void => reject(barrierExpiredError(timeoutMs));
      });
      const timer = setTimeout(() => {
        // The action first, then the gate: queued per-domain work must not
        // stay blocked on a call that is never coming back, and must not be
        // admitted under one that is still writing.
        controller.abort();
        openGate();
        expire();
      }, timeoutMs);
      timer.unref();
      const run = (async (): Promise<T> => {
        await previousBarrier;
        await Promise.all(ahead);
        // Expired during the wait: the caller has its answer and the gate is
        // given up, so nothing may start now - least of all a forget-all the
        // user was just told did not happen.
        if (controller.signal.aborted) throw barrierExpiredError(timeoutMs);
        return await action(controller.signal);
      })();
      // The race answers the caller once. A `run` that settles after that -
      // the cancel above, or an action rejecting past its expiry - has nobody
      // left to answer, and must not surface as an unhandled rejection.
      void run.catch(ignore);
      try {
        return await Promise.race([run, expired]);
      } finally {
        // Clearing before `openGate` is what keeps `expired` from rejecting
        // after the race has already settled.
        clearTimeout(timer);
        openGate();
      }
    })();
  }
}

function barrierExpiredError(timeoutMs: number): Error {
  return new Error(
    `The whole-jar barrier did not settle within ${timeoutMs}ms; the jar gate was forced open.`,
  );
}

function ignore(): void {
  return undefined;
}
