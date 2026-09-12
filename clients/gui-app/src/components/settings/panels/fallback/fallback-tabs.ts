import type { FallbackPolicyField } from "./fallback-policy-draft";

/**
 * The Fallback page's four sections.
 *
 * The page used to stack all six of its groups in one scroll, which put every
 * setting a user might ever change in front of every user. These are the same
 * groups, regrouped - no control moved between them and none changed.
 *
 * Each name states what its tab holds. That is a rule with a history rather
 * than a preference: the Providers panel records that its own tab called
 * "General" "said nothing about what the tab holds", which is why the
 * per-failure matrix is `Overrides` here and not the `Advanced` it was called
 * on the single page.
 */
export type FallbackTabKey =
  | "plan"
  | "equivalentModels"
  | "destinations"
  | "overrides";

export interface FallbackTab {
  readonly key: FallbackTabKey;
  readonly label: string;
}

/** Display order, which is also the order a keyboard walks the rail. */
export const FALLBACK_TABS: readonly FallbackTab[] = [
  { key: "plan", label: "Plan" },
  { key: "equivalentModels", label: "Equivalent models" },
  { key: "destinations", label: "Destinations" },
  { key: "overrides", label: "Overrides" },
];

export const DEFAULT_FALLBACK_TAB: FallbackTabKey = "plan";

/**
 * Which tab a save status belongs to, or `null` for a status that is never
 * behind a tab at all.
 *
 * `enabled` is the `null`: the master toggle sits ABOVE the rail, because a
 * switch that makes all four tabs inert cannot live inside one of them, so its
 * status is always on screen and needs no tab to point at.
 *
 * This exists because the panel keeps ONE status place - `activeField` decides
 * where the single line renders - and a tabbed layout can put that place on a
 * tab the reader is not on. On one page the worst case was a line further down
 * the scroll; behind tabs it is a refusal nobody ever sees. The rail's dot is
 * keyed off this map for exactly that case.
 */
export function fallbackTabForField(
  field: FallbackPolicyField,
): FallbackTabKey | null {
  switch (field) {
    case "enabled":
      return null;
    // `danger` belongs here too: `Reset all` puts the whole policy back, so it
    // sits on the policy's home tab rather than on whichever tab happens to be
    // last in the rail.
    case "ladder":
    case "behavior":
    case "danger":
      return "plan";
    case "tierGroups":
      return "equivalentModels";
    case "allowedDestinations":
      return "destinations";
    case "overrides":
      return "overrides";
  }
}
