import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/index";
import { getClientAppVersion } from "@/lib/app-version";
import { isMobileApp } from "@/lib/mobile-app";

/**
 * The deterministic diagnostic version a DEVELOPMENT renderer reports.
 *
 * `VITE_APP_VERSION` is exported by `release-desktop.yml` and the mobile
 * release lanes, so it is present in every released renderer and absent under
 * `bun run dev` / vitest. Reporting a fixed sentinel there rather than
 * "unknown" keeps a developer's host logs readable without inventing a
 * version that could be mistaken for a release - `0.0.0` sorts below every
 * real build and `-local` says why.
 *
 * It changes NOTHING about admission: the epoch below is the real one in dev
 * too, and a floored host gates on that alone.
 *
 * The fallback is gated on `import.meta.env.DEV` and NOT applied to a
 * production bundle, deliberately. A released renderer whose stamp went
 * missing must report "no version" - which the host records as
 * `observedClientAppVersionStatus: "missing"` - rather than quietly wearing a
 * developer-looking string that reads like it was meant.
 *
 * A production bundle should never get here at all: the desktop release runs
 * `scripts/validate-client-identity-release.cjs desktop --version=...` (build
 * repo) before packaging, which refuses a missing or non-strict-SemVer
 * `DESKTOP_VERSION`. This branch is the behaviour if that gate is ever
 * bypassed, not a substitute for it.
 */
export const LOCAL_CLIENT_APP_VERSION = "0.0.0-local";

/**
 * THE GUI's client identity - one reviewed value, read by every transport this
 * renderer builds (local unary, local stream, remote mux).
 *
 * A function rather than a module constant for exactly one reason: `kind`
 * depends on `isMobileApp()`, which the Capacitor entry sets AFTER the static
 * import graph (this module included) has evaluated - a constant would be
 * decided before the shell had said who it is. Every member is still a
 * process constant: the shell flag is set once before first render, the epoch
 * is a reviewed source-level decision, and the build version is baked at
 * bundle time. The first call happens no earlier than transport construction,
 * well after the entry ran, so every call returns the same values - which is
 * what lets the remote-session cache leave the identity out of its key.
 */
export function getGuiClientIdentity(): FirstPartyClientIdentity {
  return {
    kind: isMobileApp() ? "mobile" : "desktop",
    compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    appVersion:
      getClientAppVersion() ??
      (import.meta.env.DEV ? LOCAL_CLIENT_APP_VERSION : null),
  };
}
