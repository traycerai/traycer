import {
  cancelPanePreview,
  useSurfaceDemandStore,
} from "@/stores/tabs/surface-demand";
import { cssEscape } from "@/lib/dom/css-escape";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { requestPaneOpenerFocus } from "@/lib/canvas/focus-pane-opener";
import { reopenClosedTab } from "@/lib/tab-recovery/reopen";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { inVisualOrder } from "@/stores/tabs/tab-visual-order-store";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { duplicateEpicTab, openNewEpic } from "@/lib/commands/actions";
import { openActiveTileFindWithReplace } from "@/lib/commands/tile-find";
import { toggleActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import { openActiveDraftsControl } from "@/lib/commands/active-drafts-control-registry";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { closeLayoutEditorForCloseTabChord } from "@/lib/layout/editor-session";
import { tabResolveIntent } from "@/stores/tabs/registry";
import { tabRefKey } from "@/stores/tabs/layout";
import {
  selectHostFocusedRef,
  selectHostRouteBackingRef,
} from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import { isHomeTabEnabled } from "@/stores/layout/layout-store";
import type { TabActivationIntent } from "@/lib/tab-navigation/intents";
import type {
  NavigateNestedFocus,
  PrepareNestedFocusTarget,
} from "@/lib/epic-nested-focus-navigation";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import {
  ACTION_IDS,
  ACTION_META,
  resolveActionDefaultChord,
  resolveActionSecondaryChord,
  type ActionId,
  type TerminalPolicy,
} from "@/lib/keybindings/actions";
import {
  digitFromCode,
  modifierMaskFromEvent,
  modifierMaskMatches,
  type ChordString,
  type ModifierMask,
} from "@/lib/keybindings/chord";
import {
  LEADER_SCOPE_CANVAS_TABS,
  LEADER_SCOPE_HEADER_TABS,
  LEADER_SCOPE_SETTINGS,
  type LeaderDigitSequenceState,
  getLeaderScopesTopDown,
  registerLeaderScopeAtBottom,
} from "@/lib/keybindings/leader-scope";
import {
  findNeighbor,
  readTileRects,
  type FocusDirection,
} from "@/lib/keybindings/tile-geometry";
import {
  visibleSettingsSections,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { findHostedTileElement } from "@/components/epic-canvas/surface-host/hosted-tile-resolver";

const SELECTED_GROUP_TAB_SELECTOR =
  '[data-tab-instance-id][data-selected="true"]';
const PRIMARY_CHAT_COMPOSER_SELECTOR =
  "[data-chat-composer] [data-composer-editor]";
const ARTIFACT_EDITOR_SELECTOR = "[data-artifact-editor]";

// ---------------------------------------------------------------------------
// Narrow router adapter - decouples dispatch from `@tanstack/react-router`'s
// full `AppRouter` type so tests can supply a tiny fake without reaching for
// `as unknown as AppRouter`.
// ---------------------------------------------------------------------------

export interface KeybindingRouter {
  readonly getPathname: () => string;
  readonly navigateHome: () => void;
  readonly navigateSettings: () => void;
  readonly navigateToEpic: (epicId: string) => void;
  readonly navigateToEpicTab: (
    tab: Pick<EpicViewTab, "tabId" | "epicId">,
  ) => void;
  readonly navigateToEpicList: () => void;
  readonly navigateSettingsSection: (sectionId: SettingsSectionId) => void;
  /**
   * Canonical tab activation seam. Routes a `TabActivationIntent`
   * through `navigateToTabIntent` so every keybinding-triggered tab
   * switch performs the same activate-then-navigate dance as a UI
   * click - see `lib/tab-navigation.ts`.
   */
  readonly navigateToTabIntent: (intent: TabActivationIntent) => void;
  readonly navigateNestedFocus?: NavigateNestedFocus;
  readonly navigateNestedFocusToPrimaryEditor?: NavigateNestedFocus;
  /**
   * In-app history back/forward. Delegate to the shared
   * `goBack`/`goForward` actions on the CURRENT router (the live
   * instance in `<RouterProvider>`), so keybinding, mouse, header, and
   * palette all walk the same persistent history. No-op when the current
   * history carries no controller brand (browser/web build).
   */
  readonly goBack: () => void;
  readonly goForward: () => void;
  /**
   * History-navigation availability + boundary state, read off the
   * CURRENT router's persistent-history controller. The palette source
   * gates on `isHistoryNavAvailable` (desktop-only feature signal) and
   * reads through this seam instead of TanStack `useRouter()`, since the
   * palette mounts ABOVE `<RouterProvider>` where router context is null.
   */
  readonly isHistoryNavAvailable: () => boolean;
  readonly canGoBack: () => boolean;
  readonly canGoForward: () => boolean;
}

// ---------------------------------------------------------------------------
// Dynamic handler registry - context-bound actions (e.g. sidebar toggle)
// can only be dispatched from inside the component tree that owns their
// state. A bridge registers on mount and unregisters on unmount; if no
// handler is registered when the chord fires, the action no-ops.
// ---------------------------------------------------------------------------

type ActionHandler = () => void;

const dynamicHandlerRegistry = new Map<ActionId, ActionHandler>();

export function registerDynamicActionHandler(
  id: ActionId,
  handler: ActionHandler,
): () => void {
  dynamicHandlerRegistry.set(id, handler);
  return () => {
    if (dynamicHandlerRegistry.get(id) === handler) {
      dynamicHandlerRegistry.delete(id);
    }
  };
}

// ---------------------------------------------------------------------------
// Chord lookup
// ---------------------------------------------------------------------------

export interface ActionChordMatch {
  readonly actionId: ActionId;
  readonly terminalPolicy: TerminalPolicy;
}

export function findActionMatchForChord(
  chord: ChordString,
): ActionChordMatch | null {
  const bindings = useKeybindingStore.getState().bindings;
  for (const id of ACTION_IDS) {
    const meta = ACTION_META[id];
    if (meta.kind !== "chord") continue;
    const binding = bindings[id];
    if (binding === null) continue;
    if (binding === chord) {
      const terminalPolicy =
        binding === resolveActionDefaultChord(meta)
          ? meta.terminalPolicy
          : "app";
      return { actionId: id, terminalPolicy };
    }
  }

  for (const id of ACTION_IDS) {
    const meta = ACTION_META[id];
    if (meta.kind !== "chord" || bindings[id] === null) continue;
    const secondaryChord = resolveActionSecondaryChord(meta);
    if (secondaryChord === chord) {
      return {
        actionId: id,
        terminalPolicy: meta.secondaryTerminalPolicy ?? meta.terminalPolicy,
      };
    }
  }
  return null;
}

export function findActionForChord(chord: ChordString): ActionId | null {
  return findActionMatchForChord(chord)?.actionId ?? null;
}

// ---------------------------------------------------------------------------
// Digit action lookup - a `kind: "digit"` action fires when its modifier-only
// chord mask matches the current modifiers AND a digit key is the event's
// primary key. Resolution walks the leader-scope stack top-down: the first
// ACTIVE action (across the topmost scopes first) whose bound chord matches the
// event's modifier mask wins, and the match carries thunks for single-digit or
// sequence dispatch. Because every scope binds modifier-specific chords,
// suppression is automatically per-modifier (an `alt` event falls through a
// scope that only claims `mod`).
// ---------------------------------------------------------------------------

export interface DigitActionMatch {
  readonly actionId: ActionId;
  readonly digit: number;
  readonly run: () => boolean;
  readonly dispatchSequence:
    | ((digits: ReadonlyArray<number>) => boolean)
    | null;
  readonly sequenceState:
    | ((digits: ReadonlyArray<number>) => LeaderDigitSequenceState)
    | null;
}

export function matchDigitAction(
  event: KeyboardEvent,
): DigitActionMatch | null {
  const digit = digitFromCode(event.code);
  if (digit === null) return null;
  const mask = modifierMaskFromEvent(event);
  // Require at least one modifier - a bare digit must not hijack typing.
  if (!mask.mod && !mask.shift && !mask.alt) return null;

  const bindings = useKeybindingStore.getState().bindings;
  for (const scope of getLeaderScopesTopDown()) {
    for (const action of scope.actions) {
      if (!action.isActive()) continue;
      const chord = bindings[action.actionId];
      if (chord === null) continue;
      if (modifierMaskMatches(chord, mask)) {
        return {
          actionId: action.actionId,
          digit,
          // Fast is a toggle: reserve repeated keydowns without flipping it
          // again. Other digit actions keep their existing repeat behavior.
          run: () =>
            event.repeat &&
            action.actionId === "model.reasoning.byDigit" &&
            digit === 0
              ? true
              : action.dispatch(digit),
          dispatchSequence: action.dispatchSequence,
          sequenceState: action.sequenceState,
        };
      }
    }
  }
  return null;
}

// The exact mask each hint dimension matches - `"mod"` is mod-only (no shift,
// no alt), `"alt"` is alt-only, `"modShift"` is mod+shift-only (no alt) - so a
// scope binding one dimension (e.g. the model picker's `⌘⇧` profile digit)
// never bleeds into another's hint pass (`⌘` rail, `⌥` reasoning).
const EXACT_LEADER_MASKS: Readonly<
  Record<"mod" | "alt" | "modShift", ModifierMask>
> = {
  mod: { mod: true, shift: false, alt: false },
  alt: { mod: false, shift: false, alt: true },
  modShift: { mod: true, shift: true, alt: false },
};

/**
 * The scope id that currently OWNS `modifier` for visual hints, or null when no
 * active scope binds it. Mirrors `matchDigitAction`'s top-down walk but keys off
 * the modifier-only chord, so consumer badges can scope themselves to their own
 * scope (e.g. header-tab badges only light up when the header scope owns `alt`).
 */
export function resolveLeaderOwner(
  modifier: "mod" | "alt" | "modShift",
): string | null {
  const targetMask = EXACT_LEADER_MASKS[modifier];
  const bindings = useKeybindingStore.getState().bindings;
  for (const scope of getLeaderScopesTopDown()) {
    for (const action of scope.actions) {
      if (!action.isActive()) continue;
      const chord = bindings[action.actionId];
      if (chord === null) continue;
      if (modifierMaskMatches(chord, targetMask)) return scope.id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Base leader scopes: always-present app surfaces registered once at provider
// mount with the live router so their handlers can navigate. Later registrations
// sit higher, so settings can claim `alt` above the header when active, and
// overlays (model picker) can claim `mod`/`alt` above every base scope.
// ---------------------------------------------------------------------------

export function registerBaseLeaderScope(router: KeybindingRouter): () => void {
  const unregisterSettings = registerLeaderScopeAtBottom({
    id: LEADER_SCOPE_SETTINGS,
    actions: [
      {
        actionId: "app.settings.section.byDigit",
        isActive: () => isSettingsScope(router.getPathname()),
        dispatch: (digit) =>
          switchToSettingsSection(router, digitToIndex(digit)),
        dispatchSequence: null,
        sequenceState: null,
      },
    ],
  });
  const unregisterCanvasTabs = registerLeaderScopeAtBottom({
    id: LEADER_SCOPE_CANVAS_TABS,
    actions: [
      {
        actionId: "tab.switch.byDigit",
        isActive: () => getActiveTab(router) !== null,
        dispatch: (digit) =>
          switchActivePaneTabByIndex(router, singleDigitToTabIndex(digit)),
        dispatchSequence: null,
        sequenceState: null,
      },
    ],
  });
  const unregisterHeaderTabs = registerLeaderScopeAtBottom({
    id: LEADER_SCOPE_HEADER_TABS,
    actions: [
      {
        actionId: "epic.switch.byDigit",
        isActive: () => true,
        dispatch: (digit) =>
          switchToTabByIndex(router, singleDigitToTabIndex(digit)),
        dispatchSequence: (digits) =>
          switchToTabByIndex(router, digitsToIndex(digits)),
        sequenceState: tabDigitSequenceState,
      },
    ],
  });
  return () => {
    unregisterSettings();
    unregisterCanvasTabs();
    unregisterHeaderTabs();
  };
}

function isSettingsScope(pathname: string): boolean {
  // The settings overlay owns the whole screen regardless of strip layout, so
  // its section digits stay live.
  if (getSystemTabModalApi()?.isOverlayActive("settings") ?? false) return true;
  if (!isSettingsPath(pathname)) return false;
  // Otherwise gate on the ACTUAL focused ref, not just the pathname. With
  // `[Settings | empty]` focused on the empty side, `routeBackingSide` keeps the
  // URL on /settings but the Settings tab does not own focus - an Alt-digit
  // section command must no-op instead of stealing focus back to Settings.
  return selectHostFocusedRef(useTabsStore.getState())?.kind === "settings";
}

function digitToIndex(digit: number): number {
  return digit === 0 ? 9 : digit - 1;
}

function singleDigitToTabIndex(digit: number): number {
  return digit - 1;
}

function digitsToIndex(digits: ReadonlyArray<number>): number {
  const slot = Number.parseInt(
    digits.map((digit) => String(digit)).join(""),
    10,
  );
  return slot - 1;
}

function tabDigitSequenceState(
  digits: ReadonlyArray<number>,
): LeaderDigitSequenceState {
  if (digits.length === 0 || digits[0] === 0) return "invalid";
  const tabCount = getHeaderTabs().length;
  const index = digitsToIndex(digits);
  if (index < 0 || index >= tabCount) return "invalid";
  return hasLongerTabSlotWithPrefix(digits, tabCount) ? "ambiguous" : "exact";
}

function hasLongerTabSlotWithPrefix(
  digits: ReadonlyArray<number>,
  tabCount: number,
): boolean {
  const prefix = digits.map((digit) => String(digit)).join("");
  return Array.from({ length: tabCount }, (_, index) => String(index + 1)).some(
    (slot) => slot.length > prefix.length && slot.startsWith(prefix),
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type StaticHandler = (router: KeybindingRouter) => boolean;

const STATIC_HANDLERS: Readonly<Partial<Record<ActionId, StaticHandler>>> = {
  "epic.new": (r) => {
    openNewEpic(r);
    return true;
  },
  "epic.duplicate-tab": (r) => duplicateActiveEpicTab(r),
  "epic.close": (r) => closeActiveEpic(r),
  "tab.reopen": (r) => {
    void reopenClosedTab(r);
    return true;
  },
  "tab.new": (r) => openBlankTabInActiveGroup(r),
  "tab.close": (r) => closeActiveTab(r),
  "tab.close-others": (r) => closeOtherTabsInActive(r),
  "tab.close-right": (r) => closeRightTabsInActive(r),
  "tab.close-all": (r) => closeAllTabsInActive(r),
  "group.split.horizontal": (r) => splitActiveGroup(r, "horizontal"),
  "group.split.vertical": (r) => splitActiveGroup(r, "vertical"),
  "group.split-right": (r) => splitActiveGroupRight(r),
  "group.focus.up": (r) => focusGroupInDirection(r, "up"),
  "group.focus.down": (r) => focusGroupInDirection(r, "down"),
  "group.focus.left": (r) => focusGroupInDirection(r, "left"),
  "group.focus.right": (r) => focusGroupInDirection(r, "right"),
  "group.focus-editor": (r) => focusActiveGroupEditor(r),
  "tile.find.replace": () => openActiveTileFindWithReplace(),
  "nav.back": (r) => {
    if (!r.isHistoryNavAvailable() || !r.canGoBack()) return false;
    r.goBack();
    return true;
  },
  "nav.forward": (r) => {
    if (!r.isHistoryNavAvailable() || !r.canGoForward()) return false;
    r.goForward();
    return true;
  },
  "app.history.open": (r) => {
    r.navigateToEpicList();
    return true;
  },
  // Reports `false` while the Home tab is off, so the provider leaves the chord
  // unhandled rather than swallowing it for a surface this build has not got.
  "app.home.open": (r) => {
    if (!isHomeTabEnabled()) return false;
    r.navigateHome();
    return true;
  },
  "app.settings.open": (r) => {
    r.navigateSettings();
    return true;
  },
  // Composer-scoped, but routed centrally (not externally-handled): the active
  // composer's picker registers a controller; here we just toggle the top one.
  // No-op (false) when no composer is active, matching the "hidden/disabled"
  // surfaces.
  "composer.model-picker.toggle": () => toggleActiveModelPicker(),
  "composer.drafts": () => openActiveDraftsControl("shortcut"),
};

export function openDrafts(entryPoint: "palette"): boolean {
  if (openActiveDraftsControl(entryPoint)) return true;
  useDesktopDialogStore.getState().openDrafts(entryPoint);
  return true;
}

export function dispatchAction(
  id: ActionId,
  router: KeybindingRouter,
): boolean {
  return dispatchKeydownAction(id, router, false);
}

export function dispatchKeydownAction(
  id: ActionId,
  router: KeybindingRouter,
  repeat: boolean,
): boolean {
  if (
    (id === "tab.close" || id === "epic.close") &&
    closeLayoutEditorForCloseTabChord()
  )
    return true;
  const dynamic = dynamicHandlerRegistry.get(id);
  if (dynamic !== undefined) {
    resetTabCycle(router);
    dynamic();
    return true;
  }
  if (id === "epic.next" || id === "epic.prev") {
    return moveTabCycle(router, "header", id === "epic.next" ? 1 : -1, repeat);
  }
  if (id === "tab.next" || id === "tab.prev") {
    return moveTabCycle(router, "canvas", id === "tab.next" ? 1 : -1, repeat);
  }
  resetTabCycle(router);
  const handler = STATIC_HANDLERS[id];
  return handler === undefined ? false : handler(router);
}

// Actions that are listed/rebindable here but dispatched OUTSIDE this central
// dispatcher (owned by a capture-phase hook). The provider must NOT reserve
// (preventDefault/stopPropagation) their chords, or it would swallow the key
// when the external owner is inactive. Note: this is NOT the same as "has no
// handler right now" - dynamic-handler actions (palette/sidebar) legitimately
// have no handler while their bridge is unmounted yet must still be reserved.
const EXTERNALLY_HANDLED_ACTIONS: ReadonlySet<ActionId> = new Set([
  "composer.dictation.toggle",
]);

export function isExternallyHandled(id: ActionId): boolean {
  return EXTERNALLY_HANDLED_ACTIONS.has(id);
}

// Actions whose chord must fire once per physical press, never on OS key-repeat.
// A toggle (the model picker, the terminal panel's open and maximize states)
// would otherwise flip rapidly while the chord is held and settle in a
// timing-dependent state; a spawner (new terminal) would open one shell per
// repeat event. The provider still reserves the chord on repeat
// (preventDefault) but skips re-dispatch. `tab.new` is repeat-safe on the epic
// canvas (the store reuses an active blank tab), but on the landing page it
// shares the new-terminal handler, so it needs the same protection.
const REPEAT_SENSITIVE_ACTIONS: ReadonlySet<ActionId> = new Set([
  "composer.drafts",
  "composer.model-picker.toggle",
  "app.terminal.toggle",
  "app.terminal.new",
  "app.browser.new",
  "app.terminal.maximize",
  "tab.new",
  // Unbound by default, so only a user-chosen chord can be held - and holding
  // it would walk the status bar between header and footer once per repeat.
  "app.status-bar.toggle",
  // Unbound by default too; a held chord would flip the tabs between the top
  // and the side once per repeat.
  "app.tabs.vertical.toggle",
  // A held chord would walk the strip between the rail and expanded.
  "app.tabs.vertical.collapse",
]);

export function isRepeatSensitiveAction(id: ActionId): boolean {
  return REPEAT_SENSITIVE_ACTIONS.has(id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A digit opens the tab its badge is on, and next/previous step to the row
// drawn beside the current one: both follow the strip's drawn order.
function switchToTabByIndex(router: KeybindingRouter, index: number): boolean {
  const allTabs = inVisualOrder(getHeaderTabs());
  if (index < 0 || index >= allTabs.length) return false;
  const tab = allTabs[index];
  router.navigateToTabIntent(tabResolveIntent(tab));
  return true;
}

type TabCycleKind = "header" | "canvas";

interface TabCycleSnapshot {
  readonly scope: string;
  readonly ids: ReadonlyArray<string>;
  readonly activeId: string | null;
  readonly commit: (id: string, preview: boolean) => void;
  readonly cancelPreview: (id: string) => void;
}

interface TabCycleSession {
  readonly kind: TabCycleKind;
  readonly scope: string;
  readonly ids: ReadonlyArray<string>;
  readonly cancelPreview: (id: string) => void;
  committedId: string | null;
  targetId: string;
  frame: number | null;
  timer: number | null;
}

const tabCycles = new WeakMap<KeybindingRouter, TabCycleSession>();
const repeatingTabCycles = new Set<TabCycleSession>();

function readTabCycle(
  router: KeybindingRouter,
  kind: TabCycleKind,
): TabCycleSnapshot | null {
  if (kind === "header") {
    // Next/previous step to the row drawn beside the current one.
    const tabs = inVisualOrder(getHeaderTabs());
    const state = useTabsStore.getState();
    // An empty split side still cycles from the member backing its route.
    const focused =
      selectHostFocusedRef(state) ?? selectHostRouteBackingRef(state);
    if (focused === null || tabs.length === 0) return null;
    return {
      scope: "header",
      cancelPreview: (id) => {
        const demand = useSurfaceDemandStore.getState();
        const current = useTabsStore.getState();
        const selected =
          selectHostFocusedRef(current) ?? selectHostRouteBackingRef(current);
        const tab = getHeaderTabs().find(
          (candidate) => tabRefKey(candidate) === id,
        );
        if (
          demand.topLevelPreviewKeys.includes(id) &&
          selected !== null &&
          tabRefKey(selected) === id &&
          tab !== undefined
        ) {
          router.navigateToTabIntent({
            ...tabResolveIntent(tab),
            demand: "settled",
          });
        }
      },
      ids: tabs.map(tabRefKey),
      // Activation updates the layout before the router commits its pathname.
      activeId: tabRefKey(focused),
      commit: (id, preview) => {
        const tab = tabs.find((candidate) => tabRefKey(candidate) === id);
        if (tab !== undefined)
          router.navigateToTabIntent({
            ...tabResolveIntent(tab),
            demand: preview ? "preview" : "settled",
          });
      },
    };
  }
  const tab = getActiveTab(router);
  if (tab === null) return null;
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tab.tabId];
  if (canvas === undefined || canvas.activePaneId === null) return null;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null || pane.tabInstanceIds.length === 0) return null;
  return {
    scope: `${tab.tabId}:${pane.id}`,
    cancelPreview: (id) => cancelPanePreview(pane.id, id),
    ids: pane.tabInstanceIds,
    activeId: pane.activeTabId,
    commit: (id, preview) => {
      if (preview) {
        useEpicCanvasStore
          .getState()
          .setTileTabDemand(tab.tabId, pane.id, id, "preview");
      } else {
        runNestedFocus(router, tab, () =>
          useEpicCanvasStore
            .getState()
            .prepareSetActiveTileTabFocusTarget(tab.tabId, pane.id, id),
        );
      }
    },
  };
}

function cycleMatches(
  session: TabCycleSession,
  snapshot: TabCycleSnapshot | null,
): snapshot is TabCycleSnapshot {
  return (
    snapshot !== null &&
    snapshot.scope === session.scope &&
    snapshot.activeId === session.committedId &&
    snapshot.ids.length === session.ids.length &&
    snapshot.ids.every((id, index) => id === session.ids[index])
  );
}

function clearTabCycleTimers(session: TabCycleSession): void {
  if (session.frame !== null) window.cancelAnimationFrame(session.frame);
  if (session.timer !== null) window.clearTimeout(session.timer);
  session.frame = null;
  session.timer = null;
}

export function resetTabCycle(router: KeybindingRouter): void {
  const session = tabCycles.get(router);
  if (session === undefined) return;
  clearTabCycleTimers(session);
  tabCycles.delete(router);
  if (repeatingTabCycles.has(session)) {
    const snapshot = readTabCycle(router, session.kind);
    // Settle only the selection we still own, never a cancelled pending target.
    if (cycleMatches(session, snapshot) && session.committedId !== null) {
      snapshot.commit(session.committedId, false);
    } else if (session.committedId !== null) {
      session.cancelPreview(session.committedId);
    }
  }
  repeatingTabCycles.delete(session);
}

/** Re-read live membership and focus before any delayed write. */
export function validateTabCycle(router: KeybindingRouter): void {
  const session = tabCycles.get(router);
  if (session === undefined) return;
  if (!cycleMatches(session, readTabCycle(router, session.kind))) {
    resetTabCycle(router);
  }
}

export function flushTabCycle(router: KeybindingRouter): void {
  const session = tabCycles.get(router);
  if (session === undefined) return;
  const pending = session.frame !== null;
  clearTabCycleTimers(session);
  // A dialog can open after the last keydown but before this frame/key release.
  if (pending && isKeybindingDialogOpen(document.activeElement)) {
    resetTabCycle(router);
    return;
  }
  const snapshot = readTabCycle(router, session.kind);
  if (!cycleMatches(session, snapshot)) {
    resetTabCycle(router);
    return;
  }
  if (session.targetId === snapshot.activeId) return;
  session.committedId = session.targetId;
  snapshot.commit(session.targetId, repeatingTabCycles.has(session));
}

function moveTabCycle(
  router: KeybindingRouter,
  kind: TabCycleKind,
  delta: -1 | 1,
  repeat: boolean,
): boolean {
  const snapshot = readTabCycle(router, kind);
  let session = tabCycles.get(router);
  if (
    !repeat ||
    session === undefined ||
    session.kind !== kind ||
    !cycleMatches(session, snapshot)
  ) {
    resetTabCycle(router);
    session = undefined;
  }
  if (snapshot === null) return false;
  const currentId = session?.targetId ?? snapshot.activeId;
  const index = currentId === null ? 0 : snapshot.ids.indexOf(currentId);
  if (index === -1) return false;
  const targetId =
    snapshot.ids[(index + delta + snapshot.ids.length) % snapshot.ids.length];
  session ??= {
    kind,
    scope: snapshot.scope,
    ids: snapshot.ids,
    cancelPreview: snapshot.cancelPreview,
    committedId: snapshot.activeId,
    targetId,
    frame: null,
    timer: null,
  };
  session.targetId = targetId;
  tabCycles.set(router, session);
  if (repeat) {
    repeatingTabCycles.add(session);
  }
  if (!repeat) {
    flushTabCycle(router);
  } else if (session.frame === null) {
    session.frame = window.requestAnimationFrame(() => flushTabCycle(router));
    // Hidden/occluded windows may never receive a frame.
    session.timer = window.setTimeout(() => flushTabCycle(router), 100);
  }
  return true;
}

// Indexes the OFFERED sections, which is the same list the sidebar renders and
// badges - a digit means "the nth row of the rail", so a build that offers
// fewer sections must resolve the digit against the shorter list or the badge
// and the shortcut name different rows.
function switchToSettingsSection(
  router: KeybindingRouter,
  index: number,
): boolean {
  const sections = visibleSettingsSections();
  if (index < 0 || index >= sections.length) return false;
  router.navigateSettingsSection(sections[index].id);
  return true;
}

function getActiveEpicTabId(router: KeybindingRouter): string | null {
  const systemTabModal = getSystemTabModalApi();
  if (
    systemTabModal?.isOverlayActive("settings") === true ||
    systemTabModal?.isOverlayActive("history") === true
  ) {
    return null;
  }
  if (useLandingDraftStore.getState().activeDraftId !== null) return null;
  const focusedRef = selectHostFocusedRef(useTabsStore.getState());
  if (focusedRef?.kind !== "epic") return null;
  const parts = router.getPathname().split("/");
  if (parts.length !== 4) return null;
  const [_root, scope, epicId, tabId] = parts;
  if (scope !== "epics" || epicId === "" || tabId === "") return null;
  const tab = useEpicCanvasStore.getState().tabsById[tabId];
  if (
    tab === undefined ||
    tab.epicId !== epicId ||
    tab.tabId !== focusedRef.id ||
    isPhaseMigrationSurface(tab)
  ) {
    return null;
  }
  return tab.tabId;
}

function isPhaseMigrationSurface(tab: EpicViewTab): boolean {
  return tab.surfaceMode?.kind === "phase-migration";
}

function getActiveTab(router: KeybindingRouter): EpicViewTab | null {
  const tabId = getActiveEpicTabId(router);
  if (tabId === null) return null;
  return useEpicCanvasStore.getState().tabsById[tabId] ?? null;
}

function runNestedFocus(
  router: KeybindingRouter,
  tab: { readonly epicId: string; readonly tabId: string },
  prepare: PrepareNestedFocusTarget,
) {
  if (router.navigateNestedFocus === undefined) return prepare();
  return router.navigateNestedFocus(tab.epicId, tab.tabId, prepare);
}

function duplicateActiveEpicTab(router: KeybindingRouter): boolean {
  const tabId = getActiveEpicTabId(router);
  if (tabId === null) return false;
  const duplicated = duplicateEpicTab(tabId);
  if (duplicated === null) return false;
  router.navigateToEpicTab(duplicated);
  return true;
}

function getActiveGroupId(tabId: string): string | null {
  return (
    useEpicCanvasStore.getState().canvasByTabId[tabId]?.activePaneId ?? null
  );
}

function getActiveGroupAndTab(
  tabId: string,
): { groupId: string; tabId: string | null } | null {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return null;
  if (canvas.activePaneId === null) return null;
  const group = findPaneById(canvas.root, canvas.activePaneId);
  if (group === null) return null;
  return { groupId: group.id, tabId: group.activeTabId };
}

function closeActiveEpic(router: KeybindingRouter): boolean {
  const tabId = getActiveEpicTabId(router);
  if (tabId === null) return false;
  const state = useEpicCanvasStore.getState();
  state.closeTab(tabId);
  const next = useEpicCanvasStore.getState().activeTabId;
  const nextTab =
    next === null ? null : useEpicCanvasStore.getState().tabsById[next];
  if (nextTab !== null && nextTab !== undefined) {
    router.navigateToEpicTab(nextTab);
  } else {
    router.navigateHome();
  }
  return true;
}

function closeActiveTab(router: KeybindingRouter): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tab.tabId];
  if (canvas === undefined || canvas.activePaneId === null) return false;
  const root = canvas.root;
  if (root === null) return false;
  const target = findPaneById(root, canvas.activePaneId);
  if (target === null) return false;
  if (target.activeTabId === null) {
    if (target.tabInstanceIds.length > 0) return false;
    if (root.kind !== "group") return false;
    runNestedFocus(router, tab, () =>
      useEpicCanvasStore
        .getState()
        .prepareCloseCanvasPaneFocusTarget(tab.tabId, target.id),
    );
    return true;
  }
  const activeTabId = target.activeTabId;
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareCloseCanvasTabFocusTarget(tab.tabId, target.id, activeTabId),
  );
  return true;
}

function closeOtherTabsInActive(router: KeybindingRouter): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const target = getActiveGroupAndTab(tab.tabId);
  if (target === null || target.tabId === null) return false;
  const targetTabId = target.tabId;
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareCloseOtherCanvasTabsFocusTarget(
        tab.tabId,
        target.groupId,
        targetTabId,
      ),
  );
  return true;
}

function closeRightTabsInActive(router: KeybindingRouter): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const target = getActiveGroupAndTab(tab.tabId);
  if (target === null || target.tabId === null) return false;
  const targetTabId = target.tabId;
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareCloseRightCanvasTabsFocusTarget(
        tab.tabId,
        target.groupId,
        targetTabId,
      ),
  );
  return true;
}

function closeAllTabsInActive(router: KeybindingRouter): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const groupId = getActiveGroupId(tab.tabId);
  if (groupId === null) return false;
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareCloseAllCanvasTabsFocusTarget(tab.tabId, groupId),
  );
  return true;
}

function switchActivePaneTabByIndex(
  router: KeybindingRouter,
  index: number,
): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tab.tabId];
  if (canvas === undefined || canvas.activePaneId === null) return false;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null) return false;
  if (index < 0 || index >= pane.tabInstanceIds.length) return false;
  const nextInstanceId = pane.tabInstanceIds[index];
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareSetActiveTileTabFocusTarget(tab.tabId, pane.id, nextInstanceId),
  );
  return true;
}

function openBlankTabInActiveGroup(router: KeybindingRouter): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const groupId = getActiveGroupId(tab.tabId);
  if (groupId === null) return false;
  // Reuse-if-active-is-blank is handled in the store action, so repeated
  // presses just re-focus the existing blank tab.
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareOpenBlankTabInPaneFocusTarget(tab.tabId, groupId),
  );
  requestPaneOpenerFocus(tab.tabId, groupId);
  return true;
}

function splitActiveGroup(
  router: KeybindingRouter,
  axis: "horizontal" | "vertical",
): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const groupId = getActiveGroupId(tab.tabId);
  if (groupId === null) return false;
  // The new empty pane self-renders the inline opener (PaneOpener); no trigger.
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareSplitPaneEmptyFocusTarget(tab.tabId, groupId, axis),
  );
  return true;
}

function splitActiveGroupRight(router: KeybindingRouter): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const groupId = getActiveGroupId(tab.tabId);
  if (groupId === null) return false;
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareSplitPaneEmptyFocusTarget(tab.tabId, groupId, "horizontal"),
  );
  return true;
}

function focusGroupInDirection(
  router: KeybindingRouter,
  dir: FocusDirection,
): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const groupId = getActiveGroupId(tab.tabId);
  if (groupId === null) return false;
  if (typeof document === "undefined") return false;
  const rects = readTileRects(document);
  const active = rects.find((r) => r.id === groupId);
  if (active === undefined) return false;
  const nextId = findNeighbor(active, rects, dir);
  if (nextId === null) return false;
  const prepare = () =>
    useEpicCanvasStore
      .getState()
      .prepareSetActiveTilePaneFocusTarget(tab.tabId, nextId);
  if (router.navigateNestedFocusToPrimaryEditor === undefined) {
    runNestedFocus(router, tab, prepare);
  } else {
    router.navigateNestedFocusToPrimaryEditor(tab.epicId, tab.tabId, prepare);
  }
  focusGroupEditor(nextId);
  return true;
}

function focusGroupEditor(groupId: string): boolean {
  if (typeof document === "undefined") return false;
  const group = document.querySelector<HTMLElement>(groupIdSelector(groupId));
  const selectedTab = group?.querySelector<HTMLElement>(
    SELECTED_GROUP_TAB_SELECTOR,
  );
  const editor =
    findComposerOrArtifactEditor(selectedTab) ??
    findComposerOrArtifactEditor(hostedRecordForSelectedTab(selectedTab));
  if (editor === null) return false;
  editor.focus({ preventScroll: true });
  return true;
}

function findComposerOrArtifactEditor(
  scope: HTMLElement | null | undefined,
): HTMLElement | null {
  if (scope === null || scope === undefined) return null;
  return (
    scope.querySelector<HTMLElement>(PRIMARY_CHAT_COMPOSER_SELECTOR) ??
    scope.querySelector<HTMLElement>(ARTIFACT_EDITOR_SELECTOR)
  );
}

/**
 * A hosted chat's own composer/editor lives in `StableTileSurfaceHost`'s
 * plane - `selectedTab` (the pane's tab-body wrapper) only ever contains
 * `TileSurfaceSlot`'s empty geometry anchor for it. `selectedTab` still
 * carries the tab's own `data-tab-instance-id`, so no extra plumbing is
 * needed to locate the hosted record for the same instance.
 */
function hostedRecordForSelectedTab(
  selectedTab: HTMLElement | null | undefined,
): HTMLElement | null {
  const instanceId = selectedTab?.dataset.tabInstanceId;
  if (instanceId === undefined) return null;
  return findHostedTileElement(document, instanceId);
}

function focusActiveGroupEditor(router: KeybindingRouter): boolean {
  const tab = getActiveTab(router);
  if (tab !== null) {
    const target = getActiveGroupAndTab(tab.tabId);
    if (target !== null && focusGroupEditor(target.groupId)) return true;
  }
  return focusActiveComposer();
}

function groupIdSelector(groupId: string): string {
  return `[data-group-id="${cssEscape(groupId)}"]`;
}

export function isKeybindingDialogOpen(target: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  // Leader-hosting dialogs are transparent, but another open dialog still
  // blocks. A key inside a blocking dialog needs no document-wide lookup.
  const selector =
    '[role="dialog"][data-state="open"]:not([data-leader-scope])';
  if (target instanceof Element && target.closest(selector) !== null) {
    return true;
  }
  return document.querySelector(selector) !== null;
}
