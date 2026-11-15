import { SYSTEM_ACTOR_ID } from "@/lib/identity/person-identity";

/** Board C15's words. */
const STARTED_BY = "Started by";

/**
 * The person a chat's "Started by" line names, or `null` for no line: nothing
 * said who started the chat, or the host wrote `"system"` (no person did).
 */
export function chatStarterPerson(starterUserId: string | null): string | null {
  return starterUserId === null || starterUserId === SYSTEM_ACTOR_ID
    ? null
    : starterUserId;
}

/**
 * "Started by <name>". A starter the app cannot name is shown by id, as every
 * other person with no record is.
 */
export function startedByText(
  starterUserId: string,
  displayName: string | null,
): string {
  return `${STARTED_BY} ${displayName ?? starterUserId}`;
}
