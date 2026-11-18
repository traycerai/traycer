import {
  createKeyedSeenStore,
  keyedSeen,
  type SeenRecord,
} from "@/lib/persist/keyed-seen-store";
import { persistKey, STORE_KEYS } from "@/lib/persist/keys";

/** Bounded, like every per-person seen record: the oldest pair drops first. */
export const TEAM_CONTINUE_CAUTION_SEEN_CAP = 500;

/**
 * Which (person, team) pairs have confirmed the team-continue caution: asked
 * once per person per team, then not again.
 */
export const useTeamContinueCautionSeenStore = createKeyedSeenStore(
  persistKey(STORE_KEYS.teamContinueCautionSeen),
  TEAM_CONTINUE_CAUTION_SEEN_CAP,
);

export function teamContinueCautionSeen(
  seen: SeenRecord,
  viewerUserId: string,
  teamId: string,
): boolean {
  return keyedSeen(seen, viewerUserId, teamId);
}
