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
 */
export function mostRecentOwnedEpic(
  profile: ProjectProfile,
  items: ReadonlyArray<HistoryItem>,
): HistoryItem | null {
  let best: HistoryItem | null = null;
  for (const item of items) {
    if (!profileOwnsEpic(profile, item.epicId, item.linkedWorkspaces)) continue;
    if (best === null || item.updatedAtMs > best.updatedAtMs) {
      best = item;
    }
  }
  return best;
}

/**
 * Canonical "open or focus the epic tab" intent for entering a profile, or
 * null when the profile owns no epic yet — the caller stays on the current
 * surface (a fresh project legitimately starts on the locked composer).
 */
export function buildProfileLandingEpicIntent(
  profile: ProjectProfile,
  items: ReadonlyArray<HistoryItem>,
): ProfileLandingEpicIntent | null {
  const target = mostRecentOwnedEpic(profile, items);
  if (target === null) return null;
  return openOrFocusEpicIntent({ epicId: target.epicId, focus: undefined });
}
