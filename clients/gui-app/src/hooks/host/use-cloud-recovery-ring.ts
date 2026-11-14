import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * Holds `hostId`'s cloud-recovery doorbell (`CloudRecoveryDoorbellMount`)
 * while `held`, and calls `onRing` once on each of its rings meanwhile. It is
 * for a call outside the query cache that failed with a transient cloud
 * failure, which the doorbell's sweep of failed reads cannot ask again.
 *
 * The holder keeps `held` true while the call a ring made is in flight, and
 * when that call fails transiently again: releasing in between would close
 * the doorbell and dial it anew, and the host rings on every open.
 *
 * While `pending` and not yet `held`, a ring of a doorbell another holder
 * keeps open is remembered without holding it. The call may then fail with
 * an answer from before the cloud came back, and that doorbell rings no more
 * for it, so the hold that failure takes spends the remembered ring once,
 * however many rang. Each new pending call starts owing nothing.
 */
export function useCloudRecoveryRing(input: {
  readonly hostId: string;
  readonly held: boolean;
  readonly pending: boolean;
  readonly onRing: () => void;
}): void {
  const { hostId, held, pending } = input;
  const holds = ringHoldsFor(useQueryClient());
  const onRing = useEffectEvent(input.onRing);
  const ringOwed = useRef(false);
  useEffect(() => {
    if (!pending || held) return undefined;
    ringOwed.current = false;
    return holds.watch(hostId, () => {
      ringOwed.current = true;
    });
  }, [holds, hostId, pending, held]);
  useEffect(() => {
    if (!held) return undefined;
    const release = holds.hold(hostId, () => onRing());
    if (ringOwed.current) {
      ringOwed.current = false;
      onRing();
    }
    return release;
  }, [holds, hostId, held]);
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
