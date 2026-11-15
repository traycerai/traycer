import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useSyncExternalStore,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * Sends `call`, a call outside the query cache, each time the returned `ask`
 * runs, and holds `hostId`'s cloud-recovery doorbell
 * (`CloudRecoveryDoorbellMount`) while `held`, asking once on each of its
 * rings meanwhile. `held` is for a call that failed with a transient cloud
 * failure, which the doorbell's sweep of failed reads cannot ask again.
 *
 * The holder keeps `held` true while the call a ring asked is in flight, and
 * when that call fails transiently again: releasing in between would close
 * the doorbell and dial it anew, and the host rings on every open.
 *
 * A ring that comes after an `ask`, of a doorbell another holder keeps open,
 * is remembered without holding it. The call may then fail with an answer
 * from before the cloud came back, and that doorbell rings no more for it,
 * so the hold that failure takes asks once more, however many rang. Each
 * `ask` forgets the rings that came before it, so only a ring after the
 * latest call began is owed; a send that bypassed `ask` would leave it an
 * earlier call's ring.
 */
export function useCloudRecoveryRing(input: {
  readonly hostId: string;
  readonly held: boolean;
  readonly call: () => void;
}): () => void {
  const { hostId, held, call } = input;
  const holds = ringHoldsFor(useQueryClient());
  const ringOwed = useRef(false);
  const stopWatch = useRef<(() => void) | null>(null);
  const ask = useCallback(() => {
    ringOwed.current = false;
    // Heard from the step that sends the call, so no ring after the call
    // began can come before the watch does.
    stopWatch.current ??= holds.watch(hostId, () => {
      ringOwed.current = true;
    });
    call();
  }, [holds, hostId, call]);
  useEffect(
    () => () => {
      stopWatch.current?.();
      stopWatch.current = null;
    },
    [holds, hostId],
  );
  const askAgain = useEffectEvent(ask);
  useEffect(() => {
    if (!held) return undefined;
    const release = holds.hold(hostId, () => askAgain());
    if (ringOwed.current) askAgain();
    return release;
  }, [holds, hostId, held]);
  return ask;
}

/** The hosts whose doorbell a `useCloudRecoveryRing` caller holds, sorted. */
export function useHostsHoldingCloudRecoveryRing(
  client: QueryClient,
): readonly string[] {
  const holds = ringHoldsFor(client);
  return useSyncExternalStore(holds.subscribe, holds.getSnapshot);
}

/** Calls each holder of `hostId`'s doorbell, once, for one ring. */
export function ringCloudRecoveryHolds(
  client: QueryClient,
  hostId: string,
): void {
  ringHoldsFor(client).ring(hostId);
}

const NO_HOSTS: readonly string[] = [];

const registries = new WeakMap<QueryClient, RingHolds>();

function ringHoldsFor(client: QueryClient): RingHolds {
  const existing = registries.get(client);
  if (existing !== undefined) return existing;
  const created = new RingHolds();
  registries.set(client, created);
  return created;
}

class RingHolds {
  private readonly holdsByHost = new Map<string, Set<() => void>>();
  /** Hears `hostId`'s rings without holding its doorbell open. */
  private readonly watchersByHost = new Map<string, Set<() => void>>();
  private snapshot: readonly string[] = NO_HOSTS;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): readonly string[] => this.snapshot;

  /** Adds one hold of `hostId`'s doorbell; the returned function releases it. */
  hold(hostId: string, onRing: () => void): () => void {
    // Its own function, so two holds that pass the same callback stay two.
    const hold = (): void => onRing();
    const holds = this.holdsByHost.get(hostId) ?? new Set<() => void>();
    holds.add(hold);
    this.holdsByHost.set(hostId, holds);
    this.publish();
    return () => {
      holds.delete(hold);
      if (holds.size === 0 && this.holdsByHost.get(hostId) === holds) {
        this.holdsByHost.delete(hostId);
      }
      this.publish();
    };
  }

  /**
   * Hears `hostId`'s rings until the returned function is called, without
   * holding its doorbell: a host nobody holds is not dialed for a watcher.
   */
  watch(hostId: string, onRing: () => void): () => void {
    const watch = (): void => onRing();
    const watchers = this.watchersByHost.get(hostId) ?? new Set<() => void>();
    watchers.add(watch);
    this.watchersByHost.set(hostId, watchers);
    return () => {
      watchers.delete(watch);
      if (watchers.size === 0 && this.watchersByHost.get(hostId) === watchers) {
        this.watchersByHost.delete(hostId);
      }
    };
  }

  ring(hostId: string): void {
    for (const hold of [...(this.holdsByHost.get(hostId) ?? [])]) hold();
    for (const watch of [...(this.watchersByHost.get(hostId) ?? [])]) watch();
  }

  private publish(): void {
    const next = [...this.holdsByHost.keys()].sort();
    if (
      next.length === this.snapshot.length &&
      next.every((hostId, index) => hostId === this.snapshot[index])
    ) {
      return;
    }
    this.snapshot = next.length === 0 ? NO_HOSTS : next;
    for (const listener of [...this.listeners]) listener();
  }
}
