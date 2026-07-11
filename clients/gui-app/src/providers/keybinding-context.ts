/**
 * Three leader dimensions, tracked independently:
 *  - **Primary leader** (`mod`, default ⌘/Ctrl): drives the active Epic
 *    group's tab strip via `tab.switch.byDigit`, or whichever overlay scope
 *    currently owns `mod` (e.g. the model picker's provider rail).
 *  - **Sub-leader** (`alt`, default ⌥): drives the header tab strip via
 *    `epic.switch.byDigit`, the active settings sub-section via
 *    `app.settings.section.byDigit`, or an overlay scope that owns `alt`
 *    (e.g. the model picker's reasoning footer).
 *  - **Shifted primary leader** (`modShift`, default ⌘⇧): a third, disjoint
 *    index space - today only the model picker's profile dropdown owns it
 *    (`model.profile.byDigit`). Kept fully separate from `mod` so adding a
 *    profile can never shift the provider rail's digits, and vice versa.
 *
 * Ownership is resolved through the leader-scope stack (see
 * `lib/keybindings/leader-scope.ts`): `modOwnerScopeId` / `altOwnerScopeId` /
 * `modShiftOwnerScopeId` name the scope whose action currently owns each
 * modifier's visible hint. A clean bare hold always publishes the held
 * modifier's owner, and also publishes the OTHER modifiers' owners when a
 * DIFFERENT scope owns them - so two sibling app scopes (canvas tabs + header
 * tabs) show `⌘` and `⌥` bindings together, while a single overlay scope that
 * binds all three (the model picker: `⌘` rail, `⌥` reasoning, `⌘⇧` profile)
 * lights only the dimension for the modifier combo actually held. Consumer
 * hooks still gate their badges on their own scope id, so badges only light up
 * on the surface that actually handles the chord.
 *
 * This context exposes visual hint eligibility, not raw physical key state.
 * Digit shortcuts still dispatch immediately from the global listener.
 */
import { createContext, use } from "react";
import {
  LEADER_SCOPE_CANVAS_TABS,
  LEADER_SCOPE_HEADER_TABS,
  LEADER_SCOPE_MODEL_PICKER,
  LEADER_SCOPE_SETTINGS,
} from "@/lib/keybindings/leader-scope";

// Exported so the model picker's profile dropdown (and Settings' reuse of the
// same component) can cap its displayed ⌘⇧-digit shortcut hints at exactly the
// range `model.profile.byDigit` actually dispatches - one shared limit, no
// duplicated magic number to drift out of sync.
export const SINGLE_DIGIT_LEADER_INDEX_LIMIT = 10;
const CANVAS_TAB_LEADER_INDEX_LIMIT = 9;

/**
 * Digit a single-digit leader badge must display for `index`, matching the
 * `digitToIndex` convention in `lib/keybindings/dispatch.ts` and the
 * identical mapping in `use-picker-leader-scope.ts`: physical "1"-"9" reach
 * indexes 0-8, and physical "0" reaches index 9 - the 10th and last slot
 * `SINGLE_DIGIT_LEADER_INDEX_LIMIT` allows. Every badge gated by that limit
 * must render through this helper rather than a plain `index + 1`, or its
 * 10th entry advertises an untypable "10".
 */
export function singleDigitLeaderDigitFor(index: number): string {
  return index === SINGLE_DIGIT_LEADER_INDEX_LIMIT - 1
    ? "0"
    : String(index + 1);
}

export type LeaderModifier = "mod" | "alt" | "modShift";

export interface LeaderState {
  /** True while the primary-leader owner is qualified and visible. */
  readonly modHeld: boolean;
  /** True while the sub-leader owner is qualified and visible. */
  readonly altHeld: boolean;
  /** True while the ⌘⇧ profile-digit owner is qualified and visible. */
  readonly modShiftHeld: boolean;
  /** Scope id that owns the visible `mod` hint, or null. */
  readonly modOwnerScopeId: string | null;
  /** Scope id that owns the visible `alt` hint, or null. */
  readonly altOwnerScopeId: string | null;
  /** Scope id that owns the visible `modShift` hint, or null. */
  readonly modShiftOwnerScopeId: string | null;
  /** The active route’s pathname - exposed for diagnostics/consumers. */
  readonly pathname: string;
}

const DEFAULT_LEADER_STATE: LeaderState = {
  modHeld: false,
  altHeld: false,
  modShiftHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  modShiftOwnerScopeId: null,
  pathname: "/",
};

export const LeaderHeldContext =
  createContext<LeaderState>(DEFAULT_LEADER_STATE);

export function useLeaderState(): LeaderState {
  return use(LeaderHeldContext);
}

/**
 * Returns `modifier` when the visible hint for that modifier is owned by
 * `scopeId` and the index is within the supplied limit; null otherwise. The
 * single primitive every leader-badge consumer is built on. Generic over the
 * specific dimension `M` so each caller below gets back exactly the literal
 * type it passed in (e.g. `"alt" | null`), not the full three-member
 * `LeaderModifier` union - callers that only ever bind `mod`/`alt` (epic tabs,
 * settings) don't have to account for a `modShift` value they can never see.
 */
function useLeaderModifierForScope<M extends LeaderModifier>(
  scopeId: string,
  modifier: M,
  index: number,
  indexLimit: number | null,
): M | null {
  const leader = use(LeaderHeldContext);
  if (indexLimit !== null && index >= indexLimit) return null;
  if (modifier === "mod") {
    return leader.modHeld && leader.modOwnerScopeId === scopeId
      ? modifier
      : null;
  }
  if (modifier === "alt") {
    return leader.altHeld && leader.altOwnerScopeId === scopeId
      ? modifier
      : null;
  }
  return leader.modShiftHeld && leader.modShiftOwnerScopeId === scopeId
    ? modifier
    : null;
}

/**
 * Primary-leader badge for the active Epic group's tab strip. Lights up only
 * when the canvas-tab scope owns `mod`, and only for the active pane whose tabs
 * the shortcut will actually switch.
 */
export function useCanvasTabLeaderModifierForIndex(
  index: number,
  enabled: boolean,
): "mod" | null {
  const modifier = useLeaderModifierForScope(
    LEADER_SCOPE_CANVAS_TABS,
    "mod",
    index,
    CANVAS_TAB_LEADER_INDEX_LIMIT,
  );
  return enabled ? modifier : null;
}

/**
 * Sub-leader badge for the header tab strip. Lights up only when the header tab
 * scope owns `alt` - settings and overlay scopes suppress these badges while
 * they own the same modifier.
 */
export function useTabLeaderModifierForIndex(index: number): "alt" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_HEADER_TABS,
    "alt",
    index,
    null,
  );
}

/**
 * Sub-leader badge for the Settings sidebar. The settings scope only owns `alt`
 * while its settings-section action is active (settings route or modal), so
 * gating on `alt` ownership by the settings scope captures that scoping.
 */
export function useSettingsLeaderModifierForIndex(index: number): "alt" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_SETTINGS,
    "alt",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}

/**
 * Primary-leader badge for the model picker's provider rail. Lights up only
 * while the picker scope owns `mod` (i.e. the picker is open).
 */
export function usePickerProviderLeaderForIndex(index: number): "mod" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_MODEL_PICKER,
    "mod",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}

/**
 * Sub-leader badge for the model picker's reasoning footer. Lights up only while
 * the picker scope owns `alt` (picker open AND reasoning actionable).
 */
export function usePickerReasoningLeaderForIndex(index: number): "alt" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_MODEL_PICKER,
    "alt",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}

/**
 * Third-tier hint-visibility signal for the model picker's `modShift` (⌘⇧
 * profile) dimension. Non-null only while the picker scope owns `modShift`
 * (picker open AND the active provider has 2+ profiles) - a distinct index
 * space from the provider rail's `mod` and the reasoning footer's `alt`.
 */
export function usePickerProfileLeaderForIndex(
  index: number,
): "modShift" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_MODEL_PICKER,
    "modShift",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}
