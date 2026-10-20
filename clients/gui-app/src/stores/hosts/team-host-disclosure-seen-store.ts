import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  createKeyedSeenStore,
  keyedSeen,
  type SeenRecord,
} from "@/lib/persist/keyed-seen-store";

/**
 * The team hosts whose first-tab disclosure each person has seen, keyed by
 * viewer and host. Also the newcomer signal: a team none of whose hosts has a
 * seen disclosure is one the person has never opened a tab in.
 */
export const TEAM_HOST_DISCLOSURE_SEEN_CAP = 500;

export const useTeamHostDisclosureSeenStore = createKeyedSeenStore(
  persistKey(STORE_KEYS.teamHostDisclosureSeen),
  TEAM_HOST_DISCLOSURE_SEEN_CAP,
);

export function teamHostDisclosureSeen(
  seen: SeenRecord,
  viewerUserId: string,
  hostId: string,
): boolean {
  return keyedSeen(seen, viewerUserId, hostId);
}
