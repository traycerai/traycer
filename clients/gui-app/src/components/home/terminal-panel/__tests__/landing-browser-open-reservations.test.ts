import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { LANDING_BROWSER_WATCHED_HOST_CAP } from "../landing-browser-presentation";
import {
  releaseLandingBrowserOpen,
  reserveLandingBrowserOpen,
  resetLandingBrowserOpenReservationsForTests,
  useLandingBrowserOpenReservations,
  type LandingBrowserOpenHold,
} from "../landing-browser-open-reservations";

/**
 * The cap is an invariant of THIS set, not a claim about its callers - which is
 * why check and insert are one step - and a hold belongs to the ask that took
 * it rather than to its device. The openers' behaviour is covered end to end in
 * `landing-browser-watched-release`; these pin the operations those rely on.
 */
describe("landing browser open reservations", () => {
  afterEach(() => {
    resetLandingBrowserOpenReservationsForTests();
  });

  function hosts(count: number): readonly string[] {
    return Array.from({ length: count }, (_unused, i) => `host-${i + 1}`);
  }

  function reserveOrThrow(hostId: string): LandingBrowserOpenHold {
    const hold = reserveLandingBrowserOpen(hostId);
    if (hold === null) throw new Error(`refused a hold on ${hostId}`);
    return hold;
  }

  it("admits distinct devices up to the cap and refuses the next", () => {
    for (const hostId of hosts(LANDING_BROWSER_WATCHED_HOST_CAP)) {
      expect(reserveLandingBrowserOpen(hostId)).not.toBeNull();
    }

    expect(reserveLandingBrowserOpen("one-too-many")).toBeNull();
  });

  it("always admits a device it already holds, however full the budget is", () => {
    const held = hosts(LANDING_BROWSER_WATCHED_HOST_CAP);
    for (const hostId of held) reserveOrThrow(hostId);

    // Its stream is already up, so a second ask costs no new stream. Refusing
    // it would break the popup queue this exists to serve.
    expect(reserveLandingBrowserOpen(held[0])).not.toBeNull();
    expect(reserveLandingBrowserOpen("a-new-device")).toBeNull();
  });

  it("holds a device until its LAST ask is released, not its first", () => {
    const first = reserveOrThrow("busy");
    const second = reserveOrThrow("busy");
    for (const hostId of hosts(LANDING_BROWSER_WATCHED_HOST_CAP - 1)) {
      reserveOrThrow(hostId);
    }
    expect(reserveLandingBrowserOpen("new")).toBeNull();

    releaseLandingBrowserOpen(first);
    // Still held by its second ask, so the budget is still spent.
    expect(reserveLandingBrowserOpen("new")).toBeNull();

    releaseLandingBrowserOpen(second);
    expect(reserveLandingBrowserOpen("new")).not.toBeNull();
  });

  /**
   * The ownership property, and the one a per-host count could not express.
   *
   * A hold released twice - or released by a settle belonging to a panel that
   * has since unmounted - must not free a claim a LIVE ask is relying on.
   */
  it("ignores a release for a hold the set no longer carries", () => {
    const stale = reserveOrThrow("shared");
    releaseLandingBrowserOpen(stale);
    // A new ask takes a fresh hold on the same device.
    const live = reserveOrThrow("shared");
    for (const hostId of hosts(LANDING_BROWSER_WATCHED_HOST_CAP - 1)) {
      reserveOrThrow(hostId);
    }

    // Redden: releasing by host, or a non-idempotent release, frees `shared`
    // here and lets a fifth device in while `live` is still outstanding.
    releaseLandingBrowserOpen(stale);
    expect(reserveLandingBrowserOpen("new")).toBeNull();

    releaseLandingBrowserOpen(live);
    expect(reserveLandingBrowserOpen("new")).not.toBeNull();
  });

  it("ignores a release for a device holding nothing", () => {
    for (const hostId of hosts(LANDING_BROWSER_WATCHED_HOST_CAP)) {
      reserveOrThrow(hostId);
    }

    releaseLandingBrowserOpen({ hostId: "never-reserved" });
    expect(reserveLandingBrowserOpen("new")).toBeNull();
  });

  it("frees the slot on release, whatever the outcome was", () => {
    const holds = hosts(LANDING_BROWSER_WATCHED_HOST_CAP).map((hostId) =>
      reserveOrThrow(hostId),
    );
    expect(reserveLandingBrowserOpen("new")).toBeNull();

    releaseLandingBrowserOpen(holds[0]);

    expect(reserveLandingBrowserOpen("new")).not.toBeNull();
  });

  /**
   * The snapshot's identity is stable while MEMBERSHIP is unchanged.
   *
   * It publishes on every reserve and every release, which for a device that
   * was already held - or is still held after one of its asks leaves - hands
   * every consumer a fresh array for identical contents. The panel's mount list
   * is memoised on it, so that is churn in the one place this promises not to.
   */
  it("keeps one snapshot identity while membership does not change", () => {
    const view = renderHook(() => useLandingBrowserOpenReservations());
    // Every mutation inside `act`, so a publish that DOES happen has been
    // committed by the time the identity is read - otherwise this would pass
    // against a republishing store simply because React had not caught up.
    const taken: Array<LandingBrowserOpenHold> = [];

    act(() => {
      taken.push(reserveOrThrow("shared"));
    });
    const afterFirst = view.result.current;
    expect(afterFirst).toEqual(["shared"]);

    // A second hold on a device already in the set changes no membership.
    act(() => {
      taken.push(reserveOrThrow("shared"));
    });
    expect(view.result.current).toBe(afterFirst);

    // Nor does releasing one while the other still holds it.
    act(() => {
      releaseLandingBrowserOpen(taken[0]);
    });
    expect(view.result.current).toBe(afterFirst);

    // The last release DOES change it.
    act(() => {
      releaseLandingBrowserOpen(taken[1]);
    });
    expect(view.result.current).toEqual([]);
    view.unmount();
  });
});
