/**
 * Two leaders, tracked independently:
 *  - **Primary leader** (`mod`, default ⌘/Ctrl): drives the active Epic
 *    group's tab strip via `tab.switch.byDigit`, or whichever overlay scope
 *    currently owns `mod` (e.g. the model picker's provider rail).
 *  - **Sub-leader** (`alt`, default ⌥): drives the header tab strip via
 *    `epic.switch.byDigit`, the active settings sub-section via
 *    `app.settings.section.byDigit`, or an overlay scope that owns `alt`
 *    (e.g. the model picker's reasoning footer).
 *
 * Ownership is resolved through the leader-scope stack (see
 * `lib/keybindings/leader-scope.ts`): `modOwnerScopeId` / `altOwnerScopeId` name
 * the scope whose action currently owns each modifier's visible hint. A clean
 * bare hold always publishes the held modifier's owner, and also publishes the
 * OTHER modifier's owner when a DIFFERENT scope owns it - so two sibling app
 * scopes (canvas tabs + header tabs) show `⌘` and `⌥` bindings together, while a
 * single overlay scope that binds both modifiers (the model picker) lights only
 * the rail for the modifier actually held. Consumer hooks still gate their
 * badges on their own scope id, so badges only light up on the surface that
 * actually handles the chord.
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

const SINGLE_DIGIT_LEADER_INDEX_LIMIT = 10;
const CANVAS_TAB_LEADER_INDEX_LIMIT = 9;

export type LeaderModifier = "mod" | "alt";

export interface LeaderState {
  /** True while the primary-leader owner is qualified and visible. */
  readonly modHeld: boolean;
  /** True while the sub-leader owner is qualified and visible. */
  readonly altHeld: boolean;
  /** Scope id that owns the visible `mod` hint, or null. */
  readonly modOwnerScopeId: string | null;
  /** Scope id that owns the visible `alt` hint, or null. */
  readonly altOwnerScopeId: string | null;
  /** The active route’s pathname - exposed for diagnostics/consumers. */
  readonly pathname: string;
}

const DEFAULT_LEADER_STATE: LeaderState = {
  modHeld: false,
  altHeld: false,
  modOwnerScopeId: null,
  altOwnerScopeId: null,
  pathname: "/",
};

export const LeaderHeldContext =
  createContext<LeaderState>(DEFAULT_LEADER_STATE);

export function useLeaderState(): LeaderState {
  return use(LeaderHeldContext);
}

/**
 * Returns `modifier` when the visible hint for that modifier is owned by
 * `scopeId` and the index is within the supplied limit; null otherwise.
 * The single primitive every leader-badge consumer is built on.
 */
function useLeaderModifierForScope(
  scopeId: string,
  modifier: LeaderModifier,
  index: number,
  indexLimit: number | null,
): LeaderModifier | null {
  const leader = use(LeaderHeldContext);
  if (indexLimit !== null && index >= indexLimit) return null;
  if (modifier === "mod") {
    return leader.modHeld && leader.modOwnerScopeId === scopeId ? "mod" : null;
  }
  return leader.altHeld && leader.altOwnerScopeId === scopeId ? "alt" : null;
}

/**
 * Primary-leader badge for the active Epic group's tab strip. Lights up only
 * when the canvas-tab scope owns `mod`, and only for the active pane whose tabs
 * the shortcut will actually switch.
 */
export function useCanvasTabLeaderModifierForIndex(
  index: number,
  enabled: boolean,
): LeaderModifier | null {
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
export function useTabLeaderModifierForIndex(
  index: number,
): LeaderModifier | null {
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
export function useSettingsLeaderModifierForIndex(
  index: number,
): LeaderModifier | null {
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
export function usePickerProviderLeaderForIndex(
  index: number,
): LeaderModifier | null {
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
export function usePickerReasoningLeaderForIndex(
  index: number,
): LeaderModifier | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_MODEL_PICKER,
    "alt",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}
