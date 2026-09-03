import type { ChordString } from "@traycer-clients/shared/keybindings/chord-core";
import type { BrowserViewReservedChord } from "@traycer-clients/shared/platform/browser-view";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { ActionId } from "@/lib/keybindings/actions";
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
 * `@/lib/keybindings/conflicts.ts` reads the browser-scoped rows so the
 * rebinding UI can warn about a chord a focused browser tile would swallow -
 * the two sides cannot drift.
 *
 * The BROWSER-SCOPED rows are literal tokens, because they are not app
 * bindings at all: they are what a browser does with those keys, and the
 * rebinding UI warns (through `browserScopedChordLabel`) that a focused tile
 * swallows them. The APP-FORWARDED rows are derived from the reader's LIVE
 * bindings instead - see {@link reservedBrowserChordsFor}.
 */
const BROWSER_SCOPED_CHORDS: readonly BrowserViewReservedChord[] = [
  { token: "mod+w", command: "closeTab" },
  { token: "mod+t", command: "newTab" },
  { token: "mod+l", command: "focusAddressBar" },
];

/**
 * The app actions main replays into the host renderer, by ACTION rather than by
 * chord.
 *
 * A token here would be the action's DEFAULT chord, and a reader who rebinds or
 * unbinds one of these gets the worst of both: the renderer's live registry is
 * out of the input path while a guest has focus, so their configured
 * replacement reaches the page while the stale default still fires the action.
 * Naming the action and resolving it at registration is what keeps the reserved
 * set and the bindings the same fact.
 */
const APP_FORWARDED_ACTIONS: readonly ActionId[] = [
  "app.palette.open",
  "epic.close",
  "tab.next",
  "tab.prev",
  "epic.next",
  "epic.prev",
  // The Start Page panel's own three, forwarded for the surface that created
  // the problem: a panel browser tab is a native guest, so `terminalPolicy:
  // "app"` - which is about an xterm swallowing a chord - does nothing here and
  // the app renderer never sees the key. Without these, a reader inside a
  // focused panel browser cannot open a tab of either kind or collapse the
  // panel, while the browser-scoped rows all still work.
  "app.browser.new",
  "app.terminal.new",
  "app.terminal.toggle",
];

/**
 * The policy for one set of bindings.
 *
 * An action the reader has UNBOUND reserves nothing - there is no chord to
 * claim, and reserving its old default would take a key away from the page for
 * an action that can no longer run. An app-forwarded binding that collides with
 * a browser-scoped row is dropped rather than duplicated: the browser row wins,
 * which is what the rebinding UI already warns will happen.
 */
export function reservedBrowserChordsFor(
  bindings: Readonly<Record<ActionId, ChordString | null>>,
): readonly BrowserViewReservedChord[] {
  const browserScoped = new Set(
    BROWSER_SCOPED_CHORDS.map((reserved) => reserved.token),
  );
  const seen = new Set<string>();
  const forwarded = APP_FORWARDED_ACTIONS.flatMap(
    (action): BrowserViewReservedChord[] => {
      const chord = bindings[action];
      if (chord === null || browserScoped.has(chord) || seen.has(chord)) {
        return [];
      }
      seen.add(chord);
      return [{ token: chord, command: null }];
    },
  );
  return [...BROWSER_SCOPED_CHORDS, ...forwarded];
}

/**
 * Chords a focused browser tile claims for the browser rather than the app.
 *
 * Reads the BROWSER-SCOPED rows only, which is the whole of what this answers:
 * an app-forwarded chord is not swallowed, it is replayed, so the rebinding UI
 * has nothing to warn about there. That is also why this needs no bindings
 * argument even though the reserved set now depends on them.
 */
export function browserScopedChordLabel(chord: ChordString): string | null {
  const row = BROWSER_SCOPED_CHORDS.find(
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
 * Push the policy for these bindings into the complete desktop preload bridge
 * when present.
 *
 * Idempotent and HMR-safe: main REPLACES its whole table on every call, so a
 * re-registration after hot reload can never duplicate or drift - which is also
 * what makes it safe to call again on every rebind, and why the caller
 * subscribes rather than diffing.
 */
export function registerReservedBrowserChords(
  runnerHost: IRunnerHost,
  bindings: Readonly<Record<ActionId, ChordString | null>>,
): void {
  const browserView = runnerHost.browserView;
  if (browserView === null) return;
  void browserView
    .setReservedChords(reservedBrowserChordsFor(bindings))
    .catch(ignoreError);
}
