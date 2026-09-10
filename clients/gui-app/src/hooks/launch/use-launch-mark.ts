import { useEffect, useState, useSyncExternalStore } from "react";
import { LOCAL_HOST_SLOW_START_THRESHOLD_MS } from "@/components/host/host-provisioning-controller";
import {
  hasHostRuntimeStarted,
  subscribeHostRuntimeStarted,
} from "@/lib/launch/launch-runtime-signal";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * How long the launch mark owns the screen on a signed-out launch, measured
 * from app start.
 *
 * A CEILING on a decorative surface, never a floor under a functional one.
 * Nothing waits on it: it covers the sign-in page, which has nothing to do
 * until a human presses a button, and it is dropped the moment the launch turns
 * out to be any other shape.
 */
export const LAUNCH_MARK_CEILING_MS = 2500;

/** The crossfade, which happens INSIDE the ceiling rather than after it. */
export const LAUNCH_MARK_EXIT_MS = 240;

const LAUNCH_MARK_HOLD_MS = LAUNCH_MARK_CEILING_MS - LAUNCH_MARK_EXIT_MS;

/**
 * When a launch that has told us nothing stops being a launch and starts being
 * a problem - the point where the real boot card, with its heading and its
 * `Open settings` escape hatch, takes the screen back from the mark.
 *
 * Borrowed rather than invented: `LOCAL_HOST_SLOW_START_THRESHOLD_MS` is the
 * app's existing answer to "this startup has gone on long enough that the user
 * needs words and a way out", and it is documented at its definition as a 10x
 * margin over a healthy boot with a reset on real progress. A second constant
 * would be a second opinion about the same moment.
 */
const LAUNCH_MARK_STALL_MS = LOCAL_HOST_SLOW_START_THRESHOLD_MS;

const APP_START_MS = Date.now();

function elapsedMs(): number {
  return Date.now() - APP_START_MS;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type LaunchMarkPhase = "hold" | "exit" | "done";

/**
 * The launch mark's phase: whether it still owns the window, and whether it is
 * crossfading out of it.
 *
 * ONE CLOCK, ANCHORED TO APP START. Every deadline below is measured from the
 * module's evaluation, not from a mount, so the surface means "this launch"
 * rather than "this component". A mount that happens partway through inherits
 * the remaining time instead of restarting it, and a mount after the ceiling
 * gets nothing - which is also what confines the whole thing to launch, with no
 * consumed-once flag to reset.
 *
 * THE FOUR SHAPES A LAUNCH CAN TAKE:
 *
 *  - **Auth has not answered.** The mark owns the window. This is the window
 *    that used to show the host boot card's "Starting Traycer…" to a signed-out
 *    user, which is host copy over a wait that contains no host work.
 *  - **Signed out.** The mark continues, uninterrupted, to the ceiling and
 *    crossfades into the sign-in page.
 *  - **Admitted** (`signed-in` or `unverified`). The mark yields AT ONCE and
 *    the existing boot card and readiness gate take over unchanged. No timer is
 *    involved in that decision, which is what keeps readiness ungated by
 *    animation - and `unverified` yielding here is also what puts a refused
 *    shell straight in front of the sentence explaining why it was refused.
 *  - **Stalled.** Nothing has resolved by {@link LAUNCH_MARK_STALL_MS}, so the
 *    real boot card takes the screen back with its heading and `Open settings`.
 *    A wordless mark forever is the one failure mode this surface could
 *    introduce, and this is the guard against it.
 *
 * Reduced motion keeps the mark as the pre-auth cover - a static one, since
 * every animation on it is declared inside `prefers-reduced-motion:
 * no-preference` - but takes away the signed-out hold. The hold buys nothing
 * without the motion it exists to show, and `prefers-reduced-motion` asks for
 * less movement, not for a slower app.
 */
export function useLaunchMark(): LaunchMarkPhase {
  const authStatus = useAuthStore((state) => state.status);
  const runtimeStarted = useSyncExternalStore(
    subscribeHostRuntimeStarted,
    hasHostRuntimeStarted,
  );
  const [, tick] = useState(0);
  const [stalled, setStalled] = useState(
    () => elapsedMs() >= LAUNCH_MARK_STALL_MS,
  );
  // A one-way latch: once the launch turns out to be an admitted one, a
  // reduced-motion one, or a stalled one, the mark is finished for this page
  // load and no later change of heart may bring it back. Signing out inside
  // the first couple of seconds is the case that would otherwise resurrect it,
  // because the phase below is a pure function of the clock, and the clock does
  // not know the mark was already dismissed.
  //
  // Adjusted DURING RENDER rather than from an effect. React re-runs this
  // component immediately with the new value and commits only the second
  // result, so the dismissed mark never reaches the DOM - where an effect would
  // paint it for a frame first. The `!consumed` guard is what terminates it.
  const [consumed, setConsumed] = useState(false);
  const bypassed =
    stalled || (runtimeStarted && (admitsLocalPlane(authStatus) || reduced()));
  if (bypassed && !consumed) {
    setConsumed(true);
  }

  const phase = resolvePhase(consumed || bypassed, runtimeStarted);

  // Nothing is remembered between renders, so there is no phase state to fall
  // out of step with the clock and none to settle behind a bypass. These
  // timers exist only to bring the component back at the two moments the
  // derivation's answer changes.
  useEffect(() => {
    if (phase === "done" || !runtimeStarted) return;
    const deadline =
      phase === "hold" ? LAUNCH_MARK_HOLD_MS : LAUNCH_MARK_CEILING_MS;
    const timer = setTimeout(
      () => tick((value) => value + 1),
      Math.max(0, deadline - elapsedMs()),
    );
    return () => clearTimeout(timer);
  }, [phase, runtimeStarted]);

  useEffect(() => {
    if (stalled || runtimeStarted) return;
    const timer = setTimeout(
      () => setStalled(true),
      Math.max(0, LAUNCH_MARK_STALL_MS - elapsedMs()),
    );
    return () => clearTimeout(timer);
  }, [stalled, runtimeStarted]);

  return phase;
}

function resolvePhase(
  consumed: boolean,
  runtimeStarted: boolean,
): LaunchMarkPhase {
  if (consumed) return "done";
  // Before the runtime exists auth has not answered, so the mark holds
  // regardless of the store's initial `signed-out` - see
  // `launch-runtime-signal.ts` for why that default is not an answer.
  if (!runtimeStarted) return "hold";
  return phaseFromClock();
}

/**
 * The signed-out arc, read straight off the one clock rather than stepped
 * through stored states.
 */
function phaseFromClock(): LaunchMarkPhase {
  const elapsed = elapsedMs();
  if (elapsed < LAUNCH_MARK_HOLD_MS) return "hold";
  if (elapsed < LAUNCH_MARK_CEILING_MS) return "exit";
  return "done";
}

/**
 * Read per render rather than captured once: a viewer can change the setting
 * mid-launch, and the query is cheap.
 */
function reduced(): boolean {
  return prefersReducedMotion();
}

/**
 * Whether the launch mark is still covering the window, for the surfaces that
 * must stay quiet underneath it.
 */
export function launchMarkOwnsWindow(phase: LaunchMarkPhase): boolean {
  return phase !== "done";
}
