import type { TabRef } from "@/stores/tabs/types";

export type TabStructuralLockPredicate = (ref: TabRef) => boolean;
export type TabCloseLockPredicate = (ref: TabRef) => boolean;

type TabStructuralLockListener = () => void;

const UNLOCKED: TabStructuralLockPredicate = () => false;

let structuralPredicate = UNLOCKED;
let closePredicate: TabCloseLockPredicate = UNLOCKED;
let revision = 0;
const listeners = new Set<TabStructuralLockListener>();

/**
 * Installs the runtime-owned structural-lock policy. Tab infrastructure only
 * knows that a ref may be locked; feature runtimes retain ownership of why.
 */
export function registerTabStructuralLockPredicate(
  next: TabStructuralLockPredicate,
): () => void {
  const previous = structuralPredicate;
  structuralPredicate = next;
  notifyTabStructuralLocksChanged();
  return () => {
    if (structuralPredicate !== next) return;
    structuralPredicate = previous;
    notifyTabStructuralLocksChanged();
  };
}

export function isTabStructurallyLocked(ref: TabRef): boolean {
  return structuralPredicate(ref);
}

/**
 * Installs the runtime-owned close policy. A feature may allow grouped repair
 * to close an errored surface while still keeping every other structural
 * operation locked until that surface converts to its durable kind.
 */
export function registerTabCloseLockPredicate(
  next: TabCloseLockPredicate,
): () => void {
  const previous = closePredicate;
  closePredicate = next;
  notifyTabStructuralLocksChanged();
  return () => {
    if (closePredicate !== next) return;
    closePredicate = previous;
    notifyTabStructuralLocksChanged();
  };
}

export function isTabCloseLocked(ref: TabRef): boolean {
  return closePredicate(ref);
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
  structuralPredicate = UNLOCKED;
  closePredicate = UNLOCKED;
  notifyTabStructuralLocksChanged();
}
