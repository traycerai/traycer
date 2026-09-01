import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_CLIENT_COMPATIBILITY_EPOCH } from "@traycer/protocol/framework/index";
import {
  getGuiClientIdentity,
  LOCAL_CLIENT_APP_VERSION,
} from "@/lib/host/client-identity";
import { setMobileApp } from "@/lib/mobile-app";

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
describe("getGuiClientIdentity", () => {
  afterEach(() => {
    setMobileApp(false);
  });

  it("declares the desktop kind and the shared reviewed epoch", () => {
    expect(getGuiClientIdentity().kind).toBe("desktop");
    // Read from the protocol package, NOT restated - a second copy of this
    // number is how one sender starts claiming a generation the others do not.
    expect(getGuiClientIdentity().compatibilityEpoch).toBe(
      CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    );
  });

  it("declares the mobile kind in the Capacitor shell, same epoch", () => {
    // The kind is diagnostic; the epoch is admission. A mobile build must
    // change only the former - a diverged mobile epoch would be a second
    // copy of the number the assertion above exists to prevent.
    setMobileApp(true);
    expect(getGuiClientIdentity().kind).toBe("mobile");
    expect(getGuiClientIdentity().compatibilityEpoch).toBe(
      CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    );
  });

  it("does not derive the epoch from the app version", () => {
    // Under vitest the version is the dev sentinel, whose SemVer is `0.0.0`.
    // An epoch derived from it would be 0 - which the host classifies as
    // `invalid-epoch` - so this assertion fails loudly the moment anyone ties
    // the two together.
    expect(getGuiClientIdentity().appVersion).toBe(LOCAL_CLIENT_APP_VERSION);
    expect(getGuiClientIdentity().compatibilityEpoch).toBeGreaterThan(0);
  });

  it("is value-constant across reads once the shell is set", () => {
    // The remote-session cache deliberately leaves identity out of its key on
    // exactly this basis: the shell flag is set once before first render and
    // every other member is baked at bundle time, so two reads can never
    // disagree. A future member resolved per call (a window id, a user id)
    // would break that invariant silently.
    expect(getGuiClientIdentity()).toEqual(getGuiClientIdentity());
  });
});
