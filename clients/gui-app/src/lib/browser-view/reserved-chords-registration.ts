import type { ChordString } from "@traycer-clients/shared/keybindings/chord-core";
import type { BrowserViewReservedChord } from "@traycer-clients/shared/platform/browser-view";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { ignoreError } from "./ignore-error";

/**
 * Guest-focused chords: `command` set acts on the browser tile; `command: null` is app-forwarded.
 * Anything absent belongs to the page.
 */
export const RESERVED_BROWSER_CHORDS: readonly BrowserViewReservedChord[] = [
  // Browser-scoped: the focused tile's own tab.
  { token: "mod+w", command: "closeTab" },
  { token: "mod+t", command: "newTab" },
  { token: "mod+l", command: "focusAddressBar" },
  // App-forwarded: app-level navigation that stays meaningful over a page.
  { token: "mod+k", command: null }, // app.palette.open
  { token: "mod+shift+w", command: null }, // epic.close
  { token: "mod+]", command: null }, // tab.next
  { token: "mod+[", command: null }, // tab.prev
  { token: "mod+shift+]", command: null }, // epic.next
  { token: "mod+shift+[", command: null }, // epic.prev
];

/** Chords a focused browser tile claims for the browser rather than the app. */
export function browserScopedChordLabel(chord: ChordString): string | null {
  const row = RESERVED_BROWSER_CHORDS.find(
    (reserved) => reserved.token === chord,
  );
  if (row === undefined || row.command === null) return null;
  return BROWSER_SCOPED_CHORD_LABELS[row.command];
}

const BROWSER_SCOPED_CHORD_LABELS = {
  closeTab: "Close the focused browser tab.",
  newTab: "New browser tab in the focused session.",
  focusAddressBar: "Focus the browser address bar.",
} as const;

/**
 * Push the policy into the complete desktop preload bridge when present.
 * Idempotent and HMR-safe: main REPLACES its whole table on every call, so a re-registration after hot reload can never duplicate or drift.
 */
export function registerReservedBrowserChords(runnerHost: IRunnerHost): void {
  const browserView = runnerHost.browserView;
  if (browserView === null) return;
  void browserView
    .setReservedChords(RESERVED_BROWSER_CHORDS)
    .catch(ignoreError);
}
