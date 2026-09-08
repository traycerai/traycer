import type { ChordString } from "@traycer-clients/shared/keybindings/chord-core";
import type { BrowserViewReservedChord } from "@traycer-clients/shared/platform/browser-view";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { ignoreError } from "./ignore-error";

/**
 * THE guest-focused input policy. When a native browser tile has keyboard
 * focus, key delivery is guest `before-input-event` -> macOS app-menu
 * accelerator -> the page; the app renderer's keybinding registry is never in
 * the chain. Every chord that must still mean something in that state is
 * listed here, and nowhere else. Anything absent belongs to the page.
 *
 * Two dispositions, and the `command` field is the whole distinction:
 *
 * - BROWSER-SCOPED (`command` set) - the chord acts on the BROWSER, matching
 *   what every other browser does with it. Main claims the keystroke and names
 *   the command back to the focused tile, which runs it against its own
 *   session tab (`agent-browser-tile.tsx`). Without this, Cmd+W would reach
 *   the app menu's "Close Tab" and retire the app task tab instead.
 * - APP-FORWARDED (`command: null`) - the app must win even over the page.
 *   Main replays the keystroke into the host renderer so the renderer's
 *   existing binding runs. Keep this set SMALL and epic/app-navigation level:
 *   a chord a site may legitimately bind does not belong here.
 *
 * Not listed, deliberately: the zoom chords (Cmd +/-/0), which the guest
 * handler claims for the page's own zoom factor
 * (`browser-view-entry-factory.ts`), and Electron's role-built items
 * (reload, cut/copy/paste, select-all), which already act on the focused
 * web contents and are therefore correct as they are.
 *
 * `@/lib/keybindings/conflicts.ts` reads this table so the rebinding UI can
 * warn about a chord a focused browser tile would swallow - the two sides
 * cannot drift.
 *
 * ponytail: the app-forwarded tokens are the DEFAULT chords for their actions,
 * not the user's live bindings, so a rebound `epic.close` stops being
 * forwarded. Registration happens outside the bindings store today; wire it to
 * the store if anyone actually rebinds these.
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
 * Idempotent and HMR-safe: main REPLACES its whole table on every call, so a
 * re-registration after hot reload can never duplicate or drift.
 */
export function registerReservedBrowserChords(runnerHost: IRunnerHost): void {
  const browserView = runnerHost.browserView;
  if (browserView === null) return;
  void browserView
    .setReservedChords(RESERVED_BROWSER_CHORDS)
    .catch(ignoreError);
}
