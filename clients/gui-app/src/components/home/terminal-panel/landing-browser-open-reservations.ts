import { useSyncExternalStore } from "react";

/**
 * A LEAF, and it has to stay one: `react` is the only thing this module may
 * import.
 *
 * Every jsdom suite resets this set from `__tests__/test-browser-apis.ts`, so
 * whatever this file imports is dragged into the setup of ~1950 test files -
 * and both ways that can go were paid for in a single round. Imported EAGERLY,
 * a module reached from here is evaluated before the test file, and it keeps
 * the REAL binding for every dependency that file later `vi.mock`s: reaching
 * `landing-browser-presentation` for the cap below pulled in
 * `use-landing-browser-reconciliation`, whose suite's `desktop-window-id` mock
 * then stopped applying. Imported LAZILY from the reset hook instead, the same
 * graph is evaluated during TEARDOWN, where a suite's partial `vi.mock` of
 * anything inside it throws for a missing export - which is how one file-edit
 * recovery suite started failing on a `@/lib/persist` constant it has never
 * heard of.
 *
 * So the cap lives HERE rather than beside the selector that also reads it.
 * `landing-browser-open-reservations-leaf.test.ts` enforces the property; a
 * comment alone would not have survived either of those two attempts.
 */

/**
 * How many DEVICES one open panel keeps on a browser stream at a time.
 *
 * Counts hosts, not tabs - the panel puts every one of a device's browser tabs
 * in a SINGLE independent session, so a device costs one stream however many
 * rows it holds. That is the other cap's twin, and the two are about different
 * ceilings: `LANDING_BROWSER_TAB_CAP` (8, in `use-landing-browser-open-tab.tsx`)
 * restates the HOST's per-session tab limit, while this one is a budget against
 * the DESKTOP's `MAX_STREAMS_PER_WINDOW` (12, in
 * `clients/desktop/src/electron-main/browser-sessions/browser-sessions-owner.ts`).
 * A stream is a socket, a relay attach, an identity attestation and a whole
 * contributed-set replay, and the desktop refuses whichever was asked for LAST -
 * so an unbounded strip can cost the reader the tab on screen, or a task
 * canvas tile, for rows nobody is looking at.
 *
 * Four leaves the window room for the canvas tiles it also has to serve.
 */
export const LANDING_BROWSER_WATCHED_HOST_CAP = 4;

/**
 * One accepted ask's claim on a device.
 *
 * Opaque and identity-keyed on purpose: the hold IS the ownership. Releasing
 * takes the object the ask was given, so no caller can give back a claim it
 * does not have.
 */
export interface LandingBrowserOpenHold {
  readonly hostId: string;
}

/**
 * The devices this window holds a browser stream for on account of an
 * unanswered open, and the ONE place that set is decided.
 *
 * Two properties, and both were learned the hard way.
 *
 * ATOMIC. Admission has to hold across BOTH openers, so `reserve` decides and
 * records in one synchronous step. The chooser tested a rendered prop and the
 * popup queue tested a ref written in an effect, so two `open()` calls in one
 * React batch each read a value the other had not changed, both passed the
 * budget check, and an accepted open then lost its coordinator. Neither a
 * fresher ref nor a ref per opener closes that - both still read a pre-batch
 * value inside one act. Hence module state rather than React state: no await
 * and no render sits between deciding a host fits and recording that it does.
 *
 * OWNED PER ASK, which a count could never be. A count can say a device holds
 * nothing; it can never say whether the release in hand belongs to the ask that
 * took the hold. The case that proves it: a popup is in flight when the panel
 * unmounts, cleanup releases that ask and clears its queue, the panel remounts
 * and a new ask takes a fresh hold on the SAME device - and then the old
 * mutation answers. Its options-level `onSettled` is copied onto the Mutation
 * when it is built, so it runs with the observer long gone, and a release keyed
 * by host decremented the LIVE hold. Releasing the object instead makes that
 * settle a no-op, because the hold it carries is no longer in the set.
 *
 * It is also the SINGLE source the selector reads. The mutation cache and the
 * popup queue used to be consulted beside it, and two sources that agree by
 * argument are what this class of defect has been made of.
 *
 * Several holds per device are ordinary - a page raising popups faster than the
 * device answers, or the chooser opening on a device a page is also raising on.
 * The device stays watched until the LAST of them is released.
 */
const holds = new Map<string, Set<LandingBrowserOpenHold>>();

/** Identity-stable while MEMBERSHIP is unchanged, so consumers' memos hold. */
let snapshot: ReadonlyArray<string> = [];
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = [...holds.keys()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlyArray<string> {
  return snapshot;
}

/**
 * Take a hold on `hostId` for one ask, or refuse.
 *
 * Check and insert are one step by construction - there is no point between
 * them at which a second caller can see the old answer. A device already held
 * always succeeds: its stream is up, so the ask costs no new stream and
 * refusing it would break the popup queue this exists to serve. Only a device
 * that would ADD a hold is measured against the budget.
 *
 * Publishes only when MEMBERSHIP changes. A second hold on a device already in
 * the set leaves the snapshot's contents identical, and republishing it would
 * hand every consumer a new array identity for no change - which is exactly
 * what the stability this promises is about.
 */
export function reserveLandingBrowserOpen(
  hostId: string,
): LandingBrowserOpenHold | null {
  const hold: LandingBrowserOpenHold = { hostId };
  const held = holds.get(hostId);
  if (held !== undefined) {
    held.add(hold);
    return hold;
  }
  if (holds.size >= LANDING_BROWSER_WATCHED_HOST_CAP) return null;
  holds.set(hostId, new Set([hold]));
  publish();
  return hold;
}

/**
 * Give back one ask's hold.
 *
 * Idempotent PER ASK, and that is the whole point rather than a convenience: a
 * release for a hold the set no longer carries - already released, or taken by
 * a previous incarnation of the panel - removes nothing and frees nothing, so
 * it cannot decrement a claim some live ask is relying on.
 */
export function releaseLandingBrowserOpen(
  hold: LandingBrowserOpenHold | null,
): void {
  if (hold === null) return;
  const held = holds.get(hold.hostId);
  if (held === undefined || !held.delete(hold)) return;
  if (held.size > 0) return;
  holds.delete(hold.hostId);
  publish();
}

/** The held devices, for the panel's mount list. */
export function useLandingBrowserOpenReservations(): ReadonlyArray<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Module state outlives a test; every suite that reaches an opener must clear it. */
export function resetLandingBrowserOpenReservationsForTests(): void {
  holds.clear();
  publish();
}
