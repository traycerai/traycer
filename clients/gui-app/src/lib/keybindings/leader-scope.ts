/**
 * Leader-scope stack: the single coordination point for "which surface owns a
 * leader modifier (mod/alt) right now". A scope bundles one or more digit
 * actions; the topmost ACTIVE scope that binds a given modifier wins and
 * suppresses every scope below it FOR THAT MODIFIER ONLY (per-modifier
 * fall-through). The bottom scopes are the always-present app surfaces
 * (header tabs, canvas tabs, settings sections); transient overlays such as the
 * model picker push their own scope while open and pop it on close.
 *
 * This module is intentionally store-agnostic: it holds the stack and notifies
 * subscribers when either membership or dynamic action availability changes.
 * Chord/binding resolution (which needs the keybinding store) lives in
 * `dispatch.ts`, which reads the stack via `getLeaderScopesTopDown`.
 */
import type { ActionId } from "@/lib/keybindings/actions";

/** Stable scope ids. Consumer hooks gate their badges on these. */
export const LEADER_SCOPE_HEADER_TABS = "header-tabs";
export const LEADER_SCOPE_CANVAS_TABS = "canvas-tabs";
export const LEADER_SCOPE_SETTINGS = "settings";
export const LEADER_SCOPE_MODEL_PICKER = "model-picker";
/**
 * The new-chat / new-terminal modal. It opts out of the keybinding provider's
 * dialog block (`data-leader-scope`) so a leader-aware overlay nested inside it
 * (the model picker) can run its ⌘/⌥ digit shortcuts, but owns no shortcuts of
 * its own. An absorber scope under this id claims both leaders so closed-picker
 * leader digits are swallowed instead of switching the tabs behind the modal.
 */
export const LEADER_SCOPE_NEW_CONVERSATION_MODAL = "new-conversation-modal";

export type LeaderDigitSequenceState = "invalid" | "exact" | "ambiguous";

export interface LeaderScopeAction {
  /** A `kind: "digit"` action whose bound chord decides the owning modifier. */
  readonly actionId: ActionId;
  /** Dynamic gate - the action only participates while this returns true. */
  readonly isActive: () => boolean;
  /** Run the action for one digit key. Returns true when it did something. */
  readonly dispatch: (digit: number) => boolean;
  /**
   * Optional multi-digit dispatcher for surfaces that expose numbered slots
   * beyond 9. Keep null for single-key digit scopes.
   */
  readonly dispatchSequence:
    ((digits: ReadonlyArray<number>) => boolean) | null;
  /**
   * Classifies the currently typed sequence without side effects. Required when
   * `dispatchSequence` is set, null otherwise.
   */
  readonly sequenceState:
    ((digits: ReadonlyArray<number>) => LeaderDigitSequenceState) | null;
}

export interface LeaderScope {
  readonly id: string;
  readonly actions: ReadonlyArray<LeaderScopeAction>;
}

const scopeStack: LeaderScope[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Push a scope onto the stack (top = highest priority) and return its
 * unregister. Later registrations sit above earlier ones, so the global scope
 * (registered once at provider mount) stays at the bottom and overlays layer
 * on top in open order.
 */
export function registerLeaderScope(scope: LeaderScope): () => void {
  scopeStack.push(scope);
  notify();
  return () => {
    const index = scopeStack.indexOf(scope);
    if (index === -1) return;
    scopeStack.splice(index, 1);
    notify();
  };
}

/**
 * Register an always-present base scope below any scopes that are already
 * mounted. Use this for app-level surfaces owned by `KeybindingProvider`; normal
 * transient overlays should use `registerLeaderScope` so they sit above base
 * scopes even when child effects run first.
 */
export function registerLeaderScopeAtBottom(scope: LeaderScope): () => void {
  scopeStack.unshift(scope);
  notify();
  return () => {
    const index = scopeStack.indexOf(scope);
    if (index === -1) return;
    scopeStack.splice(index, 1);
    notify();
  };
}

/** Notify subscribers that a registered scope's dynamic action gates changed. */
export function notifyLeaderScopesChanged(): void {
  notify();
}

/** Scopes from highest priority (most recently pushed) to lowest. */
export function getLeaderScopesTopDown(): ReadonlyArray<LeaderScope> {
  return scopeStack.slice().reverse();
}

/** Subscribe to stack changes (register/unregister). Returns an unsubscribe. */
export function subscribeLeaderScopes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
