import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { isSettingsPath } from "@/stores/tabs/kinds/settings";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { duplicateEpicTab, openNewEpic } from "@/lib/commands/actions";
import { openActiveTileFindWithReplace } from "@/lib/commands/tile-find";
import { toggleActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { tabMatchesPath, tabResolveIntent } from "@/stores/tabs/registry";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import type {
  NavigateNestedFocus,
  PrepareNestedFocusTarget,
} from "@/lib/epic-nested-focus-navigation";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import {
  ACTION_IDS,
  ACTION_META,
  type ActionId,
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
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings-sections";

const GROUP_EDITOR_FOCUS_TARGET_SELECTOR =
  "[data-composer-editor], [data-artifact-editor]";

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
   * Canonical tab activation seam. Routes a `TabNavigationIntent`
   * through `navigateToTabIntent` so every keybinding-triggered tab
   * switch performs the same activate-then-navigate dance as a UI
   * click - see `lib/tab-navigation.ts`.
   */
  readonly navigateToTabIntent: (intent: TabNavigationIntent) => void;
  readonly navigateNestedFocus?: NavigateNestedFocus;
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

export function findActionForChord(chord: ChordString): ActionId | null {
  const bindings = useKeybindingStore.getState().bindings;
  for (const id of ACTION_IDS) {
    if (ACTION_META[id].kind !== "chord") continue;
    if (bindings[id] === chord) return id;
  }
  return null;
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
    ((digits: ReadonlyArray<number>) => boolean) | null;
  readonly sequenceState:
    ((digits: ReadonlyArray<number>) => LeaderDigitSequenceState) | null;
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
          run: () => action.dispatch(digit),
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
  return (
    isSettingsPath(pathname) ||
    (getSystemTabModalApi()?.isOverlayActive("settings") ?? false)
  );
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
  "epic.next": (r) => moveHeaderTabFocus(r, 1),
  "epic.prev": (r) => moveHeaderTabFocus(r, -1),
  "epic.close": (r) => closeActiveEpic(r),
  "tab.new": (r) => openBlankTabInActiveGroup(r),
  "tab.close": (r) => closeActiveTab(r),
  "tab.close-others": (r) => closeOtherTabsInActive(r),
  "tab.close-right": (r) => closeRightTabsInActive(r),
  "tab.close-all": (r) => closeAllTabsInActive(r),
  "tab.next": (r) => moveTabFocus(r, 1),
  "tab.prev": (r) => moveTabFocus(r, -1),
  "group.split.horizontal": (r) => splitActiveGroup(r, "horizontal"),
  "group.split.vertical": (r) => splitActiveGroup(r, "vertical"),
  "group.split-right": (r) => splitActiveGroupRight(r),
  "group.focus.up": (r) => focusGroupInDirection(r, "up"),
  "group.focus.down": (r) => focusGroupInDirection(r, "down"),
  "group.focus.left": (r) => focusGroupInDirection(r, "left"),
  "group.focus.right": (r) => focusGroupInDirection(r, "right"),
  "group.focus-editor": (r) => focusActiveGroupEditor(r),
  "tile.find.replace": () => openActiveTileFindWithReplace(),
  "app.history.open": (r) => {
    r.navigateToEpicList();
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
  // No `nav.back` / `nav.forward` entries: in-app back/forward has no keyboard
  // chord (see ACTION_META). The palette + header buttons call the shared
  // `goBack`/`goForward` actions directly via the router seam.
};

export function dispatchAction(
  id: ActionId,
  router: KeybindingRouter,
): boolean {
  const dynamic = dynamicHandlerRegistry.get(id);
  if (dynamic !== undefined) {
    dynamic();
    return true;
  }
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
// A toggle (e.g. the model picker) would otherwise flip open/closed rapidly
// while the chord is held. The provider still reserves the chord on repeat
// (preventDefault) but skips re-dispatch.
const REPEAT_SENSITIVE_ACTIONS: ReadonlySet<ActionId> = new Set([
  "composer.model-picker.toggle",
]);

export function isRepeatSensitiveAction(id: ActionId): boolean {
  return REPEAT_SENSITIVE_ACTIONS.has(id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function switchToTabByIndex(router: KeybindingRouter, index: number): boolean {
  const allTabs = getHeaderTabs();
  if (index < 0 || index >= allTabs.length) return false;
  const tab = allTabs[index];
  router.navigateToTabIntent(tabResolveIntent(tab));
  return true;
}

function moveHeaderTabFocus(router: KeybindingRouter, delta: -1 | 1): boolean {
  const allTabs = getHeaderTabs();
  if (allTabs.length === 0) return false;
  const pathname = router.getPathname();
  const activeIndex = allTabs.findIndex((tab) => tabMatchesPath(tab, pathname));
  if (activeIndex === -1) return false;
  const next = allTabs[(activeIndex + delta + allTabs.length) % allTabs.length];
  router.navigateToTabIntent(tabResolveIntent(next));
  return true;
}

function switchToSettingsSection(
  router: KeybindingRouter,
  index: number,
): boolean {
  if (index < 0 || index >= SETTINGS_SECTIONS.length) return false;
  router.navigateSettingsSection(SETTINGS_SECTIONS[index].id);
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
  const parts = router.getPathname().split("/");
  if (parts.length !== 4) return null;
  const [_root, scope, epicId, tabId] = parts;
  if (scope !== "epics" || epicId === "" || tabId === "") return null;
  const tab = useEpicCanvasStore.getState().tabsById[tabId];
  if (tab === undefined || tab.epicId !== epicId) return null;
  return tab.tabId;
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

function moveTabFocus(router: KeybindingRouter, delta: number): boolean {
  const tab = getActiveTab(router);
  if (tab === null) return false;
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tab.tabId];
  if (canvas === undefined || canvas.activePaneId === null) return false;
  const pane = findPaneById(canvas.root, canvas.activePaneId);
  if (pane === null || pane.tabInstanceIds.length === 0) return false;
  const idx =
    pane.activeTabId === null
      ? 0
      : pane.tabInstanceIds.indexOf(pane.activeTabId);
  if (idx === -1) return false;
  const count = pane.tabInstanceIds.length;
  const nextInstanceId = pane.tabInstanceIds[(idx + delta + count) % count];
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareSetActiveTileTabFocusTarget(tab.tabId, pane.id, nextInstanceId),
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
  runNestedFocus(router, tab, () =>
    useEpicCanvasStore
      .getState()
      .prepareSetActiveTilePaneFocusTarget(tab.tabId, nextId),
  );
  focusGroupEditor(nextId);
  return true;
}

function focusGroupEditor(groupId: string): boolean {
  if (typeof document === "undefined") return false;
  const group = document.querySelector<HTMLElement>(groupIdSelector(groupId));
  const editor = group?.querySelector<HTMLElement>(
    GROUP_EDITOR_FOCUS_TARGET_SELECTOR,
  );
  if (editor === undefined || editor === null) return false;
  editor.focus({ preventScroll: true });
  return true;
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
  return `[data-group-id="${escapeAttributeSelectorValue(groupId)}"]`;
}

function escapeAttributeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
