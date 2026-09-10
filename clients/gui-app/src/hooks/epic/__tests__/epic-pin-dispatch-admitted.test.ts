import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { epicPinDispatchAdmitted } from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * `06641bf75` - the `unverified` local-home carve-out for `epic.setPinned`
 * dispatch (gap "the `unverified` carve-out - dispatch" in the lane 9
 * evidence artifact, §3.1). `epicPinDispatchAdmitted` is admitted through
 * EITHER the local-home exemption (`isLocalHome` AND a `@1.1`-negotiated
 * host) OR a held cloud verdict - never through one conjunct alone. Every row
 * below matches the artifact's matrix; the `@1.0`/legacy-host rows exist
 * specifically so a suite covering only `isLocalHome: true` + `@1.1` cannot
 * be mistaken for one that tests `variables.isLocalHome` in isolation.
 *
 * Every row passes `hostId: null` - "no caller named a host" - so the second
 * argument is the host under test, exactly as when these rows were written. The
 * NAMED case is covered separately below: `hostId` now takes precedence over
 * that argument, and a matrix that never set it could not tell the difference.
 */

const PROFILE = { userId: "user-1", userName: "U", email: "u@example.com" };
const CONTEXT = { userId: "user-1", username: "U" };
const HOST_ID = "host-pin-admission";
// The two-host pair for the precedence rows at the end. Distinct values, because
// every "the epic's host, not the window's" claim is vacuous if they collapse.
const OWNING_HOST_ID = "host-owning-the-epic";
const WINDOW_HOST_ID = "host-the-window-follows";

function withheldVerdict(): void {
  useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
}

function heldVerdict(): void {
  useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
}

function negotiate(version: { major: number; minor: number }): void {
  recordNegotiatedHostManifest(HOST_ID, { "epic.setPinned": version });
}

afterEach(() => {
  resetNegotiatedManifests();
  useAuthStore.getState().setSignedOut();
});

describe("epicPinDispatchAdmitted", () => {
  beforeEach(() => {
    withheldVerdict();
  });

  it("admits a local-homed epic on a @1.1 host with the verdict withheld", () => {
    negotiate({ major: 1, minor: 1 });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: null },
        HOST_ID,
      ),
    ).toBe(true);
  });

  it("admits a local-homed epic on a @1.1 host with the verdict held", () => {
    negotiate({ major: 1, minor: 1 });
    heldVerdict();

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: null },
        HOST_ID,
      ),
    ).toBe(true);
  });

  it("refuses a local-homed epic on a @1.0 host with the verdict withheld - isLocalHome alone is not enough", () => {
    negotiate({ major: 1, minor: 0 });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: null },
        HOST_ID,
      ),
    ).toBe(false);
  });

  it("fails closed when the host never negotiated epic.setPinned at all", () => {
    // No `recordNegotiatedHostManifest` call at all: the registry has no
    // handshake for this host, so `readNegotiatedMethodVersion` answers
    // `null` (unknown) rather than a version - the "unknown" and "absent"
    // arms both land on the cloud gate, which is withheld here.
    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: null },
        HOST_ID,
      ),
    ).toBe(false);
  });

  it("fails closed when the host completed a handshake but did not advertise epic.setPinned", () => {
    recordNegotiatedHostManifest(HOST_ID, {});

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: null },
        HOST_ID,
      ),
    ).toBe(false);
  });

  it("refuses a local-homed epic with a null host id, verdict withheld - the negotiation has nothing to read", () => {
    negotiate({ major: 1, minor: 1 });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: null },
        null,
      ),
    ).toBe(false);
  });

  it("refuses a cloud-homed epic with the verdict withheld, even on a @1.1 host - the negotiation alone is not enough", () => {
    negotiate({ major: 1, minor: 1 });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: false, hostId: null },
        HOST_ID,
      ),
    ).toBe(false);
  });

  it("admits a cloud-homed epic once the verdict is held", () => {
    heldVerdict();

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: false, hostId: null },
        HOST_ID,
      ),
    ).toBe(true);
  });

  it("asks about the EPIC's host when the variables name one, not the window's", () => {
    // The precedence the host fix introduces. The window's host has NOT
    // negotiated `@1.1`; the epic's has. Before, the gate asked the window and
    // refused a write the owning host would have served - and in the mirror
    // arrangement below it ADMITTED one the owning host cannot.
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    recordNegotiatedHostManifest(OWNING_HOST_ID, {
      "epic.setPinned": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(WINDOW_HOST_ID, {
      "epic.setPinned": { major: 1, minor: 0 },
    });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: OWNING_HOST_ID },
        WINDOW_HOST_ID,
      ),
    ).toBe(true);
  });

  it("refuses when the NAMED host is the one that cannot serve it", () => {
    // The mirror, and the arrangement that was actually shipping: the window's
    // host negotiated `@1.1` so the old gate admitted, while the epic lives on a
    // host that did not - where the write falls through to a cloud arm for an
    // epic with no cloud row. Naming the epic's host is what makes the gate ask
    // about the machine that will run the resolver.
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    recordNegotiatedHostManifest(OWNING_HOST_ID, {
      "epic.setPinned": { major: 1, minor: 0 },
    });
    recordNegotiatedHostManifest(WINDOW_HOST_ID, {
      "epic.setPinned": { major: 1, minor: 1 },
    });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true, hostId: OWNING_HOST_ID },
        WINDOW_HOST_ID,
      ),
    ).toBe(false);
  });
});
