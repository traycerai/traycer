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
 */

const PROFILE = { userId: "user-1", userName: "U", email: "u@example.com" };
const CONTEXT = { userId: "user-1", username: "U" };
const HOST_ID = "host-pin-admission";

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
        { epicId: "e1", pinned: true, isLocalHome: true },
        HOST_ID,
      ),
    ).toBe(true);
  });

  it("admits a local-homed epic on a @1.1 host with the verdict held", () => {
    negotiate({ major: 1, minor: 1 });
    heldVerdict();

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true },
        HOST_ID,
      ),
    ).toBe(true);
  });

  it("refuses a local-homed epic on a @1.0 host with the verdict withheld - isLocalHome alone is not enough", () => {
    negotiate({ major: 1, minor: 0 });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true },
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
        { epicId: "e1", pinned: true, isLocalHome: true },
        HOST_ID,
      ),
    ).toBe(false);
  });

  it("fails closed when the host completed a handshake but did not advertise epic.setPinned", () => {
    recordNegotiatedHostManifest(HOST_ID, {});

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true },
        HOST_ID,
      ),
    ).toBe(false);
  });

  it("refuses a local-homed epic with a null host id, verdict withheld - the negotiation has nothing to read", () => {
    negotiate({ major: 1, minor: 1 });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: true },
        null,
      ),
    ).toBe(false);
  });

  it("refuses a cloud-homed epic with the verdict withheld, even on a @1.1 host - the negotiation alone is not enough", () => {
    negotiate({ major: 1, minor: 1 });

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: false },
        HOST_ID,
      ),
    ).toBe(false);
  });

  it("admits a cloud-homed epic once the verdict is held", () => {
    heldVerdict();

    expect(
      epicPinDispatchAdmitted(
        { epicId: "e1", pinned: true, isLocalHome: false },
        HOST_ID,
      ),
    ).toBe(true);
  });
});
