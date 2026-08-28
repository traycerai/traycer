import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { ignoreError } from "./ignore-error";

/**
 * BT-303: renderer-owned reserved chords. These are chord tokens in the
 * gui-app keybinding vocabulary (`@/lib/keybindings/chord`); main resolves
 * them per-platform and intercepts them from focused browser tiles so the
 * host renderer still receives them.
 *
 * Keep this list to chords whose actions live OUTSIDE any page: opening the
 * command palette, switching canvas tabs, etc. Anything a site may
 * legitimately bind must NOT be listed here.
 */
const RESERVED_APP_CHORD_TOKENS: readonly string[] = [
  "mod+k", // app.palette.open
];

/**
 * Push the reserved set into the complete desktop preload bridge when present.
 * Idempotent and HMR-safe: main REPLACES its whole set on every call, so a
 * re-registration after hot reload can never duplicate or drift.
 */
export function registerReservedBrowserChords(runnerHost: IRunnerHost): void {
  const browserView = runnerHost.browserView;
  if (browserView === null) return;
  void browserView
    .setReservedChords(RESERVED_APP_CHORD_TOKENS)
    .catch(ignoreError);
}
