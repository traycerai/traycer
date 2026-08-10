import type { HistoryItem } from "@/components/home/data/home-page.data";
import { openOrFocusEpicIntent } from "@/lib/tab-navigation";
import type { TabActivationIntent } from "@/lib/tab-navigation/intents";
import { profileOwnsEpic } from "./profile-membership";
import type { ProjectProfile } from "./types";

export type ProfileLandingEpicIntent = Extract<
  TabActivationIntent,
  { kind: "open-epic" }
>;

/**
 * Most recently updated epic OWNED by the profile. Unscoped epics (no linked
 * workspaces) are never landing targets: entering a project must not pull the
 * user into work the project does not own.
 *
 * `restrictToEpicIds` narrows the candidates to a given set (typically the
 * profile's OPEN tabs): a tab the user closed is not in the set, so it can
 * never be resurrected as a landing target. `null` means no restriction.
 */
export function mostRecentOwnedEpic(
  profile: ProjectProfile,
  items: ReadonlyArray<HistoryItem>,
  restrictToEpicIds: ReadonlySet<string> | null,
): HistoryItem | null {
  let best: HistoryItem | null = null;
  for (const item of items) {
    if (restrictToEpicIds !== null && !restrictToEpicIds.has(item.epicId)) {
      continue;
    }
    if (!profileOwnsEpic(profile, item.epicId, item.linkedWorkspaces)) continue;
    if (best === null || item.updatedAtMs > best.updatedAtMs) {
      best = item;
    }
  }
  return best;
}

/**
 * Canonical "open or focus the epic tab" intent for entering a profile, or
 * null when there is no valid landing target — the caller stays on the
 * current surface (a fresh project legitimately starts on the locked
 * composer).
 *
 * `openEpicIds` is the anti-zombie guard:
 * - `null` — the profile has no tab-strip snapshot yet (fresh profile, cold
 *   launch): landing on the most recent owned epic is the intended jump to a
 *   work surface.
 * - a set (even EMPTY) — the restored strip is the profile's work-surface
 *   authority: only an epic that is still OPEN may be targeted. An empty set
 *   means every tab was deliberately closed, so there is no target and the
 *   user stays on the current surface.
 */
export function buildProfileLandingEpicIntent(
  profile: ProjectProfile,
  items: ReadonlyArray<HistoryItem>,
  openEpicIds: ReadonlySet<string> | null,
): ProfileLandingEpicIntent | null {
  const target = mostRecentOwnedEpic(profile, items, openEpicIds);
  if (target === null) return null;
  return openOrFocusEpicIntent({ epicId: target.epicId, focus: undefined });
}
