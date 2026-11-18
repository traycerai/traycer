import { SYSTEM_ACTOR_ID } from "@/lib/identity/person-identity";

const STARTED_BY = "Started by";

/** `null` when nothing said who started it, or the host wrote `"system"`. */
export function chatStarterPerson(starterUserId: string | null): string | null {
  return starterUserId === null || starterUserId === SYSTEM_ACTOR_ID
    ? null
    : starterUserId;
}

/** A starter the app cannot name is shown by id. */
export function startedByText(
  starterUserId: string,
  displayName: string | null,
): string {
  return `${STARTED_BY} ${displayName ?? starterUserId}`;
}
