import type { TabRef } from "@/stores/tabs/types";

export type TabStructuralLockPredicate = (ref: TabRef) => boolean;
export type TabCloseLockPredicate = (ref: TabRef) => boolean;

type TabStructuralLockListener = () => void;

// Each feature runtime that locks refs installs its own predicate, and a ref
// is locked while any of them says so: the phase migration's surfaces and
// the fixed Tracy entry hold their locks side by side.
const structuralPredicates = new Set<TabStructuralLockPredicate>();
const closePredicates = new Set<TabCloseLockPredicate>();
let revision = 0;
const listeners = new Set<TabStructuralLockListener>();

/**
 * Installs one runtime-owned structural-lock policy beside the others. Tab
 * infrastructure only knows that a ref may be locked; feature runtimes retain
 * ownership of why. The returned function removes this policy alone.
 */
export function registerTabStructuralLockPredicate(
  next: TabStructuralLockPredicate,
): () => void {
  structuralPredicates.add(next);
  notifyTabStructuralLocksChanged();
  return () => {
    if (!structuralPredicates.delete(next)) return;
    notifyTabStructuralLocksChanged();
  };
}

export function isTabStructurallyLocked(ref: TabRef): boolean {
  for (const predicate of structuralPredicates) {
    if (predicate(ref)) return true;
  }
  return false;
}

/**
 * Installs one runtime-owned close policy beside the others. A feature may
 * allow grouped repair to close an errored surface while still keeping every
 * other structural operation locked until that surface converts to its
 * durable kind. The returned function removes this policy alone.
 */
export function registerTabCloseLockPredicate(
  next: TabCloseLockPredicate,
): () => void {
  closePredicates.add(next);
  notifyTabStructuralLocksChanged();
  return () => {
    if (!closePredicates.delete(next)) return;
    notifyTabStructuralLocksChanged();
  };
}

export function isTabCloseLocked(ref: TabRef): boolean {
  for (const predicate of closePredicates) {
    if (predicate(ref)) return true;
  }
  return false;
}

export function subscribeTabStructuralLocks(
  listener: TabStructuralLockListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTabStructuralLockRevision(): number {
  return revision;
}

/** Feature runtimes call this after an exact-ref lock state transition. */
export function notifyTabStructuralLocksChanged(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

export function resetTabStructuralLockForTesting(): void {
  structuralPredicates.clear();
  closePredicates.clear();
  notifyTabStructuralLocksChanged();
}
