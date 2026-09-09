import {
  formatChord,
  type ChordString,
} from "@traycer-clients/shared/keybindings/chord-core";
import type { BrowserViewReservedChord } from "@traycer-clients/shared/platform/browser-view";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { ACTION_META, type ActionId } from "@/lib/keybindings/actions";
import { parseModifierChord } from "@/lib/keybindings/chord";
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
 * NATIVE ONLY, and there is a second half. A tile whose pixels are STREAMED
 * (`BrowserPeekTile`) has no main process in its input path: the app's own
 * keybinding registry is skipped for every action while a tile is armed
 * (`keybinding-provider.tsx`), and everything the screencast controller does
 * not claim is forwarded to the remote page. That controller is where the
 * browser-scoped rows have to be honoured for a streamed tile, and it now
 * claims every one of them: `focusAddressBar` (`mod+l`), reload (`mod+r`),
 * `newTab` (`mod+t`) and `closeTab` (`mod+w`), the last two through the
 * hosting surface's own handler and only where it has one. That gate is what
 * keeps a canvas viewer out of both: it opens no tabs and retires no row, so
 * it hands the controller nothing and those chords stay the page's.
 *
 * The APP-FORWARDED rows have a streamed equivalent too, and it is the
 * simplest one there could be. Forwarding means main replays the key into the
 * renderer so the renderer's own binding runs - and a streamed tile's renderer
 * is already holding the key, so there is nothing to replay: the only thing in
 * the way was the app registry skipping every action while a tile is armed.
 * `keybinding-provider.tsx` therefore stops skipping exactly the tokens this
 * function returns with a null `command`, and those bindings fire from the
 * registry as they always did. No second list: a row added below is honoured
 * on both halves the moment it appears here.
 *
 * The LANDING rows ride the same mechanism and keep their surface gate, which
 * on the streamed side is what round 7's rule asks for - the gate is in this
 * function, so a canvas-armed tile is never offered them and its ⌘J stays the
 * page's. The plain APP-FORWARDED rows are surface-independent on both halves
 * alike, because the palette and epic/tab navigation have handlers wherever
 * the reader is.
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
  "tab.reopen",
  "epic.close",
  "tab.next",
  "tab.prev",
  "epic.next",
  "epic.prev",
];

/**
 * The Start Page panel's own, forwarded for the surface that created the
 * problem: a panel browser tab is a native guest, so `terminalPolicy: "app"` -
 * which is about an xterm swallowing a chord - does nothing here and the app
 * renderer never sees the key. Without these, a reader inside a focused panel
 * browser cannot open a tab of either kind, collapse or maximize the panel,
 * close its tabs or reach one by number, while the browser-scoped rows all
 * still work.
 *
 * COMPLETENESS is the property, not the list. This must name every action the
 * panel registers a handler for under the same surface gate
 * (`landing-terminal-panel.tsx`), minus the ones a browser-scoped row already
 * claims - `tab.new` (⌘T) and `tab.close` (⌘W), which belong to the tile - and
 * minus the ones {@link APP_FORWARDED_ACTIONS} already covers surface-
 * independently (`tab.next` / `tab.prev`). Round 13 added three of them and
 * the omission of the other three was invisible for exactly the reason a
 * mechanism-shaped rule always is: nothing compares this list against the
 * panel's registrations. `forwards every chord the panel registers under the
 * same surface gate` in this module's suite is that comparison.
 *
 * Forwarded only WHILE the Start Page surface is active, which is the same gate
 * the panel registers their handlers under (`useLandingTerminalSurfaceActive`).
 * Main's table is per window, not per tile: with an epic canvas on screen the
 * replayed key would reach a renderer with no handler for it, so the chord
 * would be taken from the page - a canvas guest's ⌘J, say - for nothing.
 *
 * That was a claim about this file's INPUT before it was true of the storage.
 * Main kept one array for the whole app, so the last window to register set
 * the policy for every window: the sentence above read as a description of the
 * system and was really a requirement on it. Main now keys the table by the
 * sender window (`browser-view-chords.ts`), which is what makes it true.
 */
const LANDING_FORWARDED_ACTIONS: readonly ActionId[] = [
  "app.browser.new",
  "app.terminal.new",
  "app.terminal.toggle",
  "app.terminal.maximize",
  "tab.close-all",
  "tab.switch.byDigit",
];

/**
 * The digits a leader action reserves: `1`-`9`, the range every leader scope
 * dispatches (`0` maps to index -1 and falls through).
 */
const LEADER_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * The tokens ONE forwarded action reserves, given the reader's live binding.
 *
 * A leader action's binding is not a chord - it is a modifier MASK (`"mod"`),
 * matched against the digit the reader actually pressed
 * (`matchDigitAction`). Reserving it verbatim would put a modifier-only token
 * in main's table, which matches no keystroke, and in the streamed half's
 * token set, which is compared against `resolveMatchingChord(event)` - a full
 * chord like `mod+1`. Either way ⌘1-⌘9 stay the page's.
 *
 * So a leader expands to its nine real chords, and it expands HERE rather than
 * at either call site. That is what keeps the table single: both halves read
 * the rows this function returns, so a row added above is honoured natively
 * AND streamed with no second edit, whatever its kind. The kind is read from
 * the action's own declaration (`ACTION_META`), so nothing about this has to
 * be restated per action either.
 */
function forwardedTokensFor(
  action: ActionId,
  chord: ChordString,
): readonly ChordString[] {
  if (ACTION_META[action].kind !== "digit") return [chord];
  const mask = parseModifierChord(chord);
  if (mask === null) return [];
  return LEADER_DIGITS.map((digit) =>
    formatChord({
      mod: mask.mod,
      ctrl: false,
      shift: mask.shift,
      alt: mask.alt,
      key: String(digit),
    }),
  );
}

/** Which surfaces are on screen, as far as the reserved set depends on them. */
export interface ReservedChordSurfaces {
  /** `selectLandingTerminalSurfaceActive`: the Start Page owns the screen. */
  readonly landingSurfaceActive: boolean;
}

/**
 * The policy for one set of bindings on the surfaces currently on screen.
 *
 * An action the reader has UNBOUND reserves nothing - there is no chord to
 * claim, and reserving its old default would take a key away from the page for
 * an action that can no longer run. An app-forwarded binding that collides with
 * a browser-scoped row is dropped rather than duplicated: the browser row wins,
 * which is what the rebinding UI already warns will happen.
 */
export function reservedBrowserChordsFor(
  bindings: Readonly<Record<ActionId, ChordString | null>>,
  surfaces: ReservedChordSurfaces,
): readonly BrowserViewReservedChord[] {
  const browserScoped = new Set(
    BROWSER_SCOPED_CHORDS.map((reserved) => reserved.token),
  );
  const seen = new Set<string>();
  const actions = surfaces.landingSurfaceActive
    ? [...APP_FORWARDED_ACTIONS, ...LANDING_FORWARDED_ACTIONS]
    : APP_FORWARDED_ACTIONS;
  const forwarded = actions.flatMap((action): BrowserViewReservedChord[] => {
    const chord = bindings[action];
    if (chord === null) return [];
    // Filtered per TOKEN rather than per action, which only matters once an
    // action reserves more than one: a leader whose ⌘3 collides with a
    // browser-scoped row loses ⌘3, not ⌘1-⌘9.
    return forwardedTokensFor(action, chord).flatMap((token) => {
      if (browserScoped.has(token) || seen.has(token)) return [];
      seen.add(token);
      return [{ token, command: null }];
    });
  });
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
 * what makes it safe to call again on every rebind and every surface change,
 * and why the caller subscribes rather than diffing.
 */
export function registerReservedBrowserChords(
  runnerHost: IRunnerHost,
  bindings: Readonly<Record<ActionId, ChordString | null>>,
  surfaces: ReservedChordSurfaces,
): void {
  const browserView = runnerHost.browserView;
  if (browserView === null) return;
  void browserView
    .setReservedChords(reservedBrowserChordsFor(bindings, surfaces))
    .catch(ignoreError);
}
