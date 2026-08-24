import { describe, expect, it } from "vitest";
import { CURRENT_CLIENT_COMPATIBILITY_EPOCH } from "@traycer/protocol/framework/index";
import {
  GUI_CLIENT_IDENTITY,
  LOCAL_CLIENT_APP_VERSION,
} from "@/lib/host/client-identity";

/**
 * The GUI's first-party identity, pinned at its single source.
 *
 * The value itself is one object literal, so the interesting assertions are
 * about where its members come FROM. Two of them have already been proposed
 * as "simplifications" and both would be silent regressions:
 *
 *  - deriving the epoch from the app version (a backport carries a low SemVer
 *    and a current epoch, so the two cannot be one field), and
 *  - letting an unstamped RELEASE bundle wear the dev sentinel (which would
 *    make a missing `VITE_APP_VERSION` invisible in the field).
 */
describe("GUI_CLIENT_IDENTITY", () => {
  it("declares the desktop kind and the shared reviewed epoch", () => {
    expect(GUI_CLIENT_IDENTITY.kind).toBe("desktop");
    // Read from the protocol package, NOT restated - a second copy of this
    // number is how one sender starts claiming a generation the others do not.
    expect(GUI_CLIENT_IDENTITY.compatibilityEpoch).toBe(
      CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    );
  });

  it("does not derive the epoch from the app version", () => {
    // Under vitest the version is the dev sentinel, whose SemVer is `0.0.0`.
    // An epoch derived from it would be 0 - which the host classifies as
    // `invalid-epoch` - so this assertion fails loudly the moment anyone ties
    // the two together.
    expect(GUI_CLIENT_IDENTITY.appVersion).toBe(LOCAL_CLIENT_APP_VERSION);
    expect(GUI_CLIENT_IDENTITY.compatibilityEpoch).toBeGreaterThan(0);
  });

  it("is a process constant - the same object on every read", () => {
    // The remote-session cache deliberately leaves identity out of its key on
    // exactly this basis. A future member resolved per call (a window id, a
    // user id) would break that invariant silently.
    const first = GUI_CLIENT_IDENTITY;
    const second = GUI_CLIENT_IDENTITY;
    expect(first).toBe(second);
  });
});
