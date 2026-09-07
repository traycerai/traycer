import { useEffect, useRef } from "react";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

// Its own module rather than an export beside the dialog it started in:
// a component file that also exports a hook breaks Fast Refresh for the
// whole file, and the Overview's CLI-floor remedy (`DesktopRemedyCheck`)
// runs the SAME guarded check for the same reason.
/**
 * Asks the updater ONCE, on mount, when it has never been asked.
 *
 * The desktop DOES auto-check at launch (`installAutoUpdater` ->
 * `checkForUpdatesNow(isDev, "automatic")` in
 * `clients/desktop/src/electron-main/app/updater.ts`), so most of the time the
 * updater has already answered by the time anyone sees this surface. But that
 * check is gated on `canCheckForUpdates` and happens exactly once, while this
 * surface is reachable hours later - a host can activate a floor, or a user can
 * point at a different host, long into a session. In those cases the updater
 * has genuinely never been asked, and without this the user is sent to download
 * by hand while their own updater could have delivered the build.
 *
 * IT READS THE BRIDGE, NOT THE RENDERED SNAPSHOT, and that is the whole
 * correctness of it. `useDesktopAppUpdates` primes its store ASYNCHRONOUSLY,
 * so the first render of any consumer sees the module's default
 * `idle / lastCheckedAt: null` placeholder no matter what the main process
 * actually holds. Deciding from that placeholder would fire a redundant check
 * on every single mount - precisely the loop this is supposed to avoid - and
 * would do it invisibly, because the placeholder and a genuinely-unchecked
 * updater are the same object shape.
 *
 * Two guards, closing different loops:
 *
 *  - `lastCheckedAt !== null` on the AUTHORITATIVE snapshot means a check has
 *    already happened in this process. "up-to-date" and "error" are real
 *    answers; re-asking them would turn a blocking dialog into a poller.
 *
 *    ONE GAP, deliberately left open: an AUTOMATIC check that ERRORS publishes
 *    nothing at all (`emitCheckErrorFromCatch` returns early for non-manual
 *    intent), so `lastCheckedAt` stays `null` and the next mount of this
 *    dialog asks again. That is one request per mount, bounded by the ref
 *    below and by main's own `checkInFlight` dedupe - not a loop - and asking
 *    again after a failed check is the behaviour you would want anyway. The
 *    alternative, tracking "we already tried" in renderer state, would survive
 *    neither a reload nor a second window.
 *  - `requested` is a per-mount ref, so a re-render (this dialog re-renders on
 *    every lease delivery) cannot start a second read while the first is in
 *    flight.
 *
 * The intent stays `"automatic"`. A `"manual"` check would render the pending
 * state below - which is the only reason to want it - but it also publishes
 * `checking`, then `up-to-date` or `error`, into the APP-WIDE snapshot every
 * other update surface reads. A dialog quietly making the header announce
 * "Traycer is up to date" is worse than a brief link-then-button flip.
 *
 * Both rejections are swallowed deliberately: the failure mode is "the manual
 * link is what the user gets", which is where the component was heading
 * anyway. An updater error stacked on top of "your app is too old" adds noise
 * to a state that already has one clear instruction.
 */
export function useUpdateCheckOnBlockingMount(
  bridge: DesktopAppUpdatesBridge | null,
): void {
  const requested = useRef(false);
  useEffect(() => {
    if (bridge === null || requested.current) return;
    requested.current = true;
    let cancelled = false;
    void bridge
      .getSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        if (!shouldCheckForUpdates(snapshot)) return;
        return bridge.checkForUpdates("automatic").then(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);
}

/**
 * Whether asking the updater again could change this surface's answer.
 *
 * EXACTLY ONE reason to ask: the updater has NEVER been asked - `idle` with no
 * `lastCheckedAt`. The launch check is gated on `canCheckForUpdates` and fires
 * once, while this surface is reachable hours later, so a genuinely
 * never-checked updater is worth one request.
 *
 * NOT a reason to ask, and this is the part worth knowing before anyone adds
 * one: the updater already HOLDING a build that cannot clear the host's floor.
 * That looks like the obvious second case - the user is on the releases link
 * while their own updater is seemingly one request away from the right build -
 * but the request cannot do anything. `checkForUpdatesNow` in
 * `clients/desktop/src/electron-main/app/updater.ts` returns the current
 * snapshot BEFORE any feed query when the status is `ready`, `downloading`, or
 * `available`, for EVERY intent (the `available` arm says so in as many
 * words). Only a channel change moves that snapshot back to a re-queryable
 * state, and it runs its own check. So asking here would dispatch an IPC that
 * provably changes nothing, and a renderer test could only ever assert that
 * the bridge recorded the call.
 *
 * The releases link is therefore the ONLY recovery past a stale cached build,
 * and the render gate above is what makes sure the user is sent there rather
 * than offered a build that restarts into the same rejection. Making the
 * in-app updater recover that case means changing main to discard an
 * `available` candidate on re-check - a desktop-side product decision, not
 * something this surface can reach.
 *
 * Also not a reason: an updater that already answered "nothing here"
 * (`idle` / `up-to-date` / `unavailable` / `error` after a check). That is a
 * real answer, and re-asking it on every mount is the poller the per-mount ref
 * exists to prevent.
 */
function shouldCheckForUpdates(snapshot: DesktopAppUpdateSnapshot): boolean {
  if (snapshot.installInFlight) return false;
  return snapshot.status === "idle" && snapshot.lastCheckedAt === null;
}
