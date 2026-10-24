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

/**
 * The consequences block's full render, recorded as SHOWN in the same store:
 * a staged sandbox has no host id yet, so it is keyed by its context (the
 * configuration, the audience category and the wording version).
 */
export function consequencesShownKey(context: string): string {
  return `consequences\u0000${context}`;
}

export function consequencesShown(
  seen: SeenRecord,
  viewerUserId: string,
  context: string,
): boolean {
  return keyedSeen(seen, viewerUserId, consequencesShownKey(context));
}
