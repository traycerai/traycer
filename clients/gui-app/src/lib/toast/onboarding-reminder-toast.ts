import { toast } from "sonner";

export const ONBOARDING_REMINDER_TOAST_ID = "traycer-getting-started";
/**
 * The move's invitation, under an id of its own: it is not the reminder's
 * other wording, and a reminder shown later must never stand in its place.
 */
export const MOVE_INVITATION_TOAST_ID = "traycer-move-invitation";
let identityGeneration = 0;
let invitationOutstanding = false;

/** A retained reminder's actions expire with the identity that created it. */
export function captureOnboardingReminderIdentity(): () => boolean {
  const captured = identityGeneration;
  return () => captured === identityGeneration;
}

/**
 * Whether a move invitation is on screen with no answer from the person yet.
 *
 * It lives beside the toast's own identity rather than in the component that
 * published it, because the toast outlives that component: the Start page is
 * left and comes back, and the invitation stays up throughout. A reminder
 * mounted in between must still know it is not its turn.
 */
export function moveInvitationIsOutstanding(): boolean {
  return invitationOutstanding;
}

/** The invitation is up. */
export function markMoveInvitationShown(): void {
  invitationOutstanding = true;
}

/** The person answered it: pressed it, said Not now, or ×'d it. */
export function markMoveInvitationAnswered(): void {
  invitationOutstanding = false;
}

/** Navigation retains the reminder; identity teardown retires it and its actions. */
export function retireOnboardingReminder(): void {
  identityGeneration += 1;
  invitationOutstanding = false;
  toast.dismiss(ONBOARDING_REMINDER_TOAST_ID);
  toast.dismiss(MOVE_INVITATION_TOAST_ID);
}
