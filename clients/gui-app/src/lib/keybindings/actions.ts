import type { ChordString } from "@/lib/keybindings/chord";
import { isMac } from "@/lib/keybindings/platform";

/**
 * Stable identifiers for every keyboard-bindable action in the app. Adding
 * a new action: append to `ACTION_IDS`, define metadata in
 * `ACTION_META`, and wire the handler in `dispatch.ts` (or register at
 * runtime via `registerDynamicActionHandler` from a context-aware bridge).
 *
 * Action `kind`:
 *  - `"chord"`: bound to a full chord like `mod+shift+h`. One binding
 *    triggers one handler.
 *  - `"digit"`: bound to a modifier-only chord like `mod`. At runtime the
 *    dispatcher pairs the held modifier with a concurrently-pressed digit
 *    (0..9) and calls a single handler that receives the digit. Used by
 *    `epic.switch.byDigit` (multi-digit header tab numbers) and scoped
 *    single-digit actions such as `tab.switch.byDigit`.
 */
export const ACTION_IDS = [
  "epic.switch.byDigit",
  "tab.switch.byDigit",
  "epic.new",
  "epic.duplicate-tab",
  "epic.next",
  "epic.prev",
  "epic.close",
  "tab.new",
  "tab.close",
  "tab.close-others",
  "tab.close-right",
  "tab.close-all",
  "tab.next",
  "tab.prev",
  "group.split.horizontal",
  "group.split.vertical",
  "group.split-right",
  "group.focus.up",
  "group.focus.down",
  "group.focus.left",
  "group.focus.right",
  "group.focus-editor",
  "tile.find.replace",
  "app.sidebar.toggle",
  "app.history.open",
  "app.settings.open",
  "app.settings.section.byDigit",
  "app.palette.open",
  "app.terminal.toggle",
  "app.terminal.new",
  "app.terminal.maximize",
  "app.zoom.in",
  "app.zoom.out",
  "app.zoom.reset",
  "composer.dictation.toggle",
  "composer.model-picker.toggle",
  "model.provider.byDigit",
  "model.reasoning.byDigit",
  "model.profile.byDigit",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export type ActionCategory = "epics" | "tabs" | "groups" | "app";

export type ActionKind = "chord" | "digit";

/**
 * An action's default chord. A bare string (or `null` for "unbound") is the
 * same on every platform. A `{ mac, other }` pair declares per-platform
 * defaults, resolved through `resolveActionDefaultChord` - used when a chord
 * must differ by OS (e.g. ⌃⌥M on macOS vs an AltGr-safe Alt+Shift+M elsewhere).
 */
export type ActionDefaultChord =
  | ChordString
  | null
  | { readonly mac: ChordString; readonly other: ChordString };

export interface ActionMeta {
  readonly id: ActionId;
  readonly label: string;
  readonly description: string;
  readonly category: ActionCategory;
  readonly kind: ActionKind;
  readonly defaultChord: ActionDefaultChord;
}

/** The platform-effective default chord for an action (`null` when unbound). */
export function resolveActionDefaultChord(
  meta: ActionMeta,
): ChordString | null {
  const def = meta.defaultChord;
  if (def === null || typeof def === "string") return def;
  return isMac() ? def.mac : def.other;
}

export const ACTION_META: Readonly<Record<ActionId, ActionMeta>> = {
  "epic.switch.byDigit": {
    id: "epic.switch.byDigit",
    label: "Switch epic by number",
    description:
      "Hold Option/Alt and type a tab number to jump to that Epic-level tab.",
    category: "epics",
    kind: "digit",
    defaultChord: "alt",
  },
  "tab.switch.byDigit": {
    id: "tab.switch.byDigit",
    label: "Switch tab by number",
    description:
      "Hold the primary leader modifier and press 1-9 to jump to that tab in the active Epic group, or in the start page's terminal panel.",
    category: "tabs",
    kind: "digit",
    defaultChord: "mod",
  },
  "epic.new": {
    id: "epic.new",
    label: "New task",
    description: "Open the landing page to start a new task.",
    category: "epics",
    kind: "chord",
    defaultChord: "mod+n",
  },
  "epic.duplicate-tab": {
    id: "epic.duplicate-tab",
    label: "Duplicate tab",
    description: "Duplicate the active Epic tab and its current tiling layout.",
    category: "epics",
    kind: "chord",
    defaultChord: "mod+shift+k",
  },
  "epic.next": {
    id: "epic.next",
    label: "Next Epic tab",
    description: "Activate the next Epic-level tab in the header strip.",
    category: "epics",
    kind: "chord",
    defaultChord: "mod+shift+]",
  },
  "epic.prev": {
    id: "epic.prev",
    label: "Previous Epic tab",
    description: "Activate the previous Epic-level tab in the header strip.",
    category: "epics",
    kind: "chord",
    defaultChord: "mod+shift+[",
  },
  "epic.close": {
    id: "epic.close",
    label: "Close active tab",
    description:
      "Close the active strip tab regardless of kind - epic, draft, history, or settings.",
    category: "epics",
    kind: "chord",
    defaultChord: "mod+shift+w",
  },
  "tab.new": {
    id: "tab.new",
    label: "New tab",
    description:
      "Open a new blank tab in the active group; the inline opener is focused so you can pick what to open. On the start page, opens a new terminal tab instead.",
    category: "tabs",
    kind: "chord",
    defaultChord: "mod+t",
  },
  "tab.close": {
    id: "tab.close",
    label: "Close tab",
    description:
      "Close the active tab. On the last tab in a non-root group, the group collapses and the sibling absorbs. On the start page, closes the active terminal tab.",
    category: "tabs",
    kind: "chord",
    defaultChord: "mod+w",
  },
  "tab.close-others": {
    id: "tab.close-others",
    label: "Close other tabs",
    description: "Close every tab in the focused group except the active one.",
    category: "tabs",
    kind: "chord",
    // ⌘⌥W - matches Safari's "Close Other Tabs".
    defaultChord: "mod+alt+w",
  },
  "tab.close-right": {
    id: "tab.close-right",
    label: "Close tabs to the right",
    description:
      "Close every tab to the right of the active tab in the focused group.",
    category: "tabs",
    kind: "chord",
    // ⌘⇧⌥] - the `]` echoes "Next tab" (⌘⇧]); ⌥ marks the destructive variant.
    defaultChord: "mod+shift+alt+]",
  },
  "tab.close-all": {
    id: "tab.close-all",
    label: "Close all tabs in group",
    description:
      "Close every tab in the focused group. Non-root groups collapse afterwards. On the start page, closes every terminal tab.",
    category: "tabs",
    kind: "chord",
    // ⌘⇧⌥W - the "close" W family; all three modifiers signal the widest scope.
    defaultChord: "mod+shift+alt+w",
  },
  "tab.next": {
    id: "tab.next",
    label: "Next tab",
    description:
      "Activate the next tab in the focused group, or in the start page's terminal panel.",
    category: "tabs",
    kind: "chord",
    defaultChord: "mod+]",
  },
  "tab.prev": {
    id: "tab.prev",
    label: "Previous tab",
    description:
      "Activate the previous tab in the focused group, or in the start page's terminal panel.",
    category: "tabs",
    kind: "chord",
    defaultChord: "mod+[",
  },
  "group.split.horizontal": {
    id: "group.split.horizontal",
    label: "Split group horizontally",
    description:
      "Split the focused group horizontally with an empty placeholder group on the right.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+d",
  },
  "group.split.vertical": {
    id: "group.split.vertical",
    label: "Split group vertically",
    description:
      "Split the focused group vertically with an empty placeholder group on the bottom.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+shift+d",
  },
  "group.split-right": {
    id: "group.split-right",
    label: "Split group to the right",
    description:
      "Create an empty new group on the right of the focused group; the new group becomes active.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+\\",
  },
  "group.focus.up": {
    id: "group.focus.up",
    label: "Focus group above",
    description: "Move group focus to the nearest group above.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+alt+arrowup",
  },
  "group.focus.down": {
    id: "group.focus.down",
    label: "Focus group below",
    description: "Move group focus to the nearest group below.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+alt+arrowdown",
  },
  "group.focus.left": {
    id: "group.focus.left",
    label: "Focus group left",
    description: "Move group focus to the nearest group on the left.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+alt+arrowleft",
  },
  "group.focus.right": {
    id: "group.focus.right",
    label: "Focus group right",
    description: "Move group focus to the nearest group on the right.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+alt+arrowright",
  },
  "group.focus-editor": {
    id: "group.focus-editor",
    label: "Focus active tab editor",
    description:
      "Place cursor in the editor of the active tab in the focused group.",
    category: "groups",
    kind: "chord",
    defaultChord: "mod+l",
  },
  "tile.find.replace": {
    id: "tile.find.replace",
    label: "Find and replace in active tile",
    description:
      "Open the active tile's find bar and expand the Replace row when the tile supports replacement.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+alt+f",
  },
  "app.sidebar.toggle": {
    id: "app.sidebar.toggle",
    label: "Toggle left panel",
    description: "Show or hide the Epic left panel; the rail stays visible.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+b",
  },
  "app.history.open": {
    id: "app.history.open",
    label: "Open history",
    description: "Open the Epic history, or focus the History tab if present.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+y",
  },
  "app.settings.open": {
    id: "app.settings.open",
    label: "Open settings",
    description: "Navigate to the settings screen.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+,",
  },
  "app.settings.section.byDigit": {
    id: "app.settings.section.byDigit",
    label: "Switch settings section by number",
    description:
      "While on the settings screen, hold Option/Alt and press a digit to jump to that section. Settings takes precedence over the header tab strip while frontmost.",
    category: "app",
    kind: "digit",
    defaultChord: "alt",
  },
  "app.palette.open": {
    id: "app.palette.open",
    label: "Open command palette",
    description:
      "Open the command palette to search commands, navigation targets, and recent actions.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+k",
  },
  "app.terminal.toggle": {
    id: "app.terminal.toggle",
    label: "Toggle terminal panel",
    description:
      "Show or hide the terminal panel on the start page. Opening it with no terminals starts one in the pinned workspace folder.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+j",
  },
  "app.terminal.new": {
    id: "app.terminal.new",
    label: "New terminal",
    description:
      "Open a new terminal tab in the start page's terminal panel, revealing the panel if it is collapsed.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+shift+j",
  },
  "app.terminal.maximize": {
    id: "app.terminal.maximize",
    label: "Maximize terminal panel",
    description:
      "Toggle the start page's terminal panel between maximized and its docked width, revealing the panel if it is collapsed.",
    category: "app",
    kind: "chord",
    // ⌘⌥J extends the ⌘J terminal family; ⌥ marks the layout variant, the
    // same convention as ⌘⌥W (close others) and ⌘⌥F (find and replace).
    defaultChord: "mod+alt+j",
  },
  "app.zoom.in": {
    id: "app.zoom.in",
    label: "Zoom in",
    description: "Increase the whole-app display zoom.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+=",
  },
  "app.zoom.out": {
    id: "app.zoom.out",
    label: "Zoom out",
    description: "Decrease the whole-app display zoom.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+-",
  },
  "app.zoom.reset": {
    id: "app.zoom.reset",
    label: "Reset zoom",
    description: "Reset whole-app display zoom to 100%.",
    category: "app",
    kind: "chord",
    defaultChord: "mod+0",
  },
  "composer.dictation.toggle": {
    id: "composer.dictation.toggle",
    label: "Voice input",
    description:
      "Dictate into the composer. Tap to start, tap again to stop; or hold to talk and release to stop. Speech is transcribed on-device.",
    category: "app",
    kind: "chord",
    // Control+Shift+M - uses the Control key specifically (the separate ⌃ key on
    // macOS), avoiding the Command-based conflicts: ⌘Space (Spotlight),
    // ⌘⇧Space (window summon), ⌘⇧V (split group vertically).
    defaultChord: "ctrl+shift+m",
  },
  "composer.model-picker.toggle": {
    id: "composer.model-picker.toggle",
    label: "Toggle model picker",
    description:
      "Open or close the model picker for the composer you're editing. Default ⌃⌥M on macOS; Alt+Shift+M on Windows/Linux (Alt+Shift dodges the Ctrl+Alt=AltGr trap).",
    category: "app",
    kind: "chord",
    // Per-platform: ⌃⌥M keeps Control distinct from ⌘ on macOS (so it matches
    // via the Control-aware encoder), while Alt+Shift+M avoids the Windows/Linux
    // Ctrl+Alt=AltGr conflict and doesn't collide with dictation's ⌃⇧M.
    defaultChord: { mac: "ctrl+alt+m", other: "alt+shift+m" },
  },
  "model.provider.byDigit": {
    id: "model.provider.byDigit",
    label: "Switch model provider by number",
    description:
      "While the model picker is open, hold the leader modifier and press a digit to switch the browsed provider rail. Suppresses epic-tab switching for as long as the picker is open.",
    category: "app",
    kind: "digit",
    defaultChord: "mod",
  },
  "model.reasoning.byDigit": {
    id: "model.reasoning.byDigit",
    label: "Switch thinking level by number",
    description:
      "While the model picker is open and the selected model exposes thinking levels, hold Option/Alt and press a digit to set that level.",
    category: "app",
    kind: "digit",
    defaultChord: "alt",
  },
  "model.profile.byDigit": {
    id: "model.profile.byDigit",
    label: "Switch profile by number",
    description:
      "While the model picker is open and the active provider has 2+ profiles, hold the leader modifier + Shift and press a digit to switch to that profile chip.",
    category: "app",
    kind: "digit",
    defaultChord: "mod+shift",
  },
  // In-app back/forward (`nav.back` / `nav.forward`) intentionally has NO
  // keyboard chord: `mod`/`alt`+Arrow both collide with native text-editing
  // caret movement inside the always-focused chat composer. Back/forward are
  // explicit affordances only — the header arrow buttons, the command palette
  // ("Go back" / "Go forward"), and mouse buttons 3/4 — all routed through the
  // shared `goBack`/`goForward` actions.
};
export function getDefaultBindings(): Readonly<
  Record<ActionId, ChordString | null>
> {
  const entries = ACTION_IDS.map((id) => [
    id,
    resolveActionDefaultChord(ACTION_META[id]),
  ]);
  return Object.fromEntries(entries) as Record<ActionId, ChordString | null>;
}
