import { toast } from "sonner";

export const ONBOARDING_REMINDER_TOAST_ID = "traycer-getting-started";
/**
 * The move's invitation, under an id of its own: it is not the reminder's
 * other wording, and a reminder shown later must never stand in its place.
 */
export const MOVE_INVITATION_TOAST_ID = "traycer-move-invitation";
let identityGeneration = 0;

/** A retained reminder's actions expire with the identity that created it. */
export function captureOnboardingReminderIdentity(): () => boolean {
  const captured = identityGeneration;
  return () => captured === identityGeneration;
}

/** Navigation retains the reminder; identity teardown retires it and its actions. */
export function retireOnboardingReminder(): void {
  identityGeneration += 1;
  toast.dismiss(ONBOARDING_REMINDER_TOAST_ID);
  toast.dismiss(MOVE_INVITATION_TOAST_ID);
}
