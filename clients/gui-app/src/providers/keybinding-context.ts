/** Three independent leader dimensions (`mod`, `alt`, `modShift`). Visual hint eligibility, not raw key state. `modShift` is exact-owner-only so an unowned Cmd+Shift hold cannot reveal ordinary leader badges. */
import { createContext, use } from "react";
import {
  LEADER_SCOPE_CANVAS_TABS,
  LEADER_SCOPE_HEADER_TABS,
  LEADER_SCOPE_MODEL_PICKER,
  LEADER_SCOPE_SETTINGS,
} from "@/lib/keybindings/leader-scope";

// Shared cap for ⌘⇧-digit profile hints. Must match model.profile.byDigit.
export const SINGLE_DIGIT_LEADER_INDEX_LIMIT = 10;
const CANVAS_TAB_LEADER_INDEX_LIMIT = 9;

/** Physical 1-9 map to indexes 0-8; physical 0 is index 9. Do not render index+1 or the 10th slot advertises an untypable "10". */
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

/** modifier when this scope owns the hint and index is in range; else null. Generic in M so a mod/alt caller never sees modShift. */
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
 * Canvas-tab mod badge for the active pane whose tabs the shortcut will switch.
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
 * Header-tab alt badge. Settings/overlay scopes suppress it while they own alt.
 */
export function useTabLeaderModifierForIndex(index: number): "alt" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_HEADER_TABS,
    "alt",
    index,
    null,
  );
}

/** Settings-sidebar alt badge. The settings scope owns alt only while its section action is active. */
export function useSettingsLeaderModifierForIndex(index: number): "alt" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_SETTINGS,
    "alt",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}

/** Primary-leader badge for the model picker's provider rail. Lights up only while the picker scope owns `mod` (i.e. the picker is open). */
export function usePickerProviderLeaderForIndex(index: number): "mod" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_MODEL_PICKER,
    "mod",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}

/** Sub-leader badge for the model picker's reasoning footer. Lights up only while the picker scope owns `alt` (picker open AND reasoning actionable). */
export function usePickerReasoningLeaderForIndex(index: number): "alt" | null {
  return useLeaderModifierForScope(
    LEADER_SCOPE_MODEL_PICKER,
    "alt",
    index,
    SINGLE_DIGIT_LEADER_INDEX_LIMIT,
  );
}

/** Non-null while the picker owns modShift (open and 2+ profiles). Distinct index space from the rail's mod and the footer's alt. */
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
