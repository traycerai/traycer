import { useAuthStore } from "@/stores/auth/auth-store";
import { useLandingReceiptsStore } from "@/stores/onboarding/landing-receipts-store";
import { useOnboardingFlowStore } from "@/stores/onboarding/onboarding-flow-store";

/**
 * The tour's ACTIVATION TOKEN: a counter that moves, synchronously with the
 * store write, whenever the thing the tour is doing changes identity - the
 * flow store's `activationRevision` (a chain start, pause, resume, end or
 * replay, a replay of the very same unanchored tour included) or the
 * signed-in user (status OR user id: A signing out and B signing in keeps
 * the status).
 *
 * Everything that closes over "the current attempt" checks it: a Joyride
 * callback from before a replay, a receipt for an attempt announced under
 * the previous activation, an entry baseline taken for the previous one,
 * the once-per-activation entry navigation. DOM epochs and lesson ids
 * cannot do this job, and an effect would be one render late, which is
 * exactly the gap an old callback lands in. Pending receipts are dropped on
 * every move for the same reason.
 *
 * A singleton: there is one tour host per window, and the card needs to
 * read the token without a hook of its own (`focus intent` below).
 */

let token = 0;
const listeners = new Set<() => void>();
let watching = false;

function bump(): void {
  token += 1;
  useLandingReceiptsStore.getState().reset();
  for (const listener of listeners) listener();
}

function identityOf(state: {
  readonly status: string;
  readonly contextMetadata: { readonly userId: string } | null;
}): string {
  return `${state.status}|${state.contextMetadata?.userId ?? ""}`;
}

/**
 * The store subscriptions start on first use and are never stopped: the
 * ready host unmounts on every readiness drop, and a replay or a sign-out
 * that lands while it is down must still move the token before the host
 * comes back - otherwise a remount would treat the new activation as the
 * one it already entered, and old receipts would survive it.
 */
function ensureWatching(): void {
  if (watching) return;
  watching = true;
  useOnboardingFlowStore.subscribe((next, previous) => {
    if (next.activationRevision !== previous.activationRevision) bump();
  });
  useAuthStore.subscribe((next, previous) => {
    if (identityOf(next) !== identityOf(previous)) bump();
  });
}

export function getActivationToken(): number {
  ensureWatching();
  return token;
}

export function subscribeActivation(listener: () => void): () => void {
  ensureWatching();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Make sure the flow and auth stores are being watched (see above). */
export function startActivationWatch(): void {
  ensureWatching();
}

/** Tests only: a fresh token, no listeners disturbed. */
export function resetActivationForTests(): void {
  token += 1;
  armedFor = null;
}

// ── Focus intent ────────────────────────────────────────────────────────────
// Keyboard Next moves focus into the NEXT card, and only that one: the
// intent is armed against the current activation, and the next card that
// mounts consumes it only if the activation is still the same. A final
// Finish never arms it, so a later replay does not steal focus.

let armedFor: number | null = null;

export function armFocusNextCard(): void {
  armedFor = token;
}

export function consumeFocusNextCard(): boolean {
  const hit = armedFor === token;
  armedFor = null;
  return hit;
}
