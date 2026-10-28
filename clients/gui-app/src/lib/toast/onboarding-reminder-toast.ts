import { toast } from "sonner";

export const ONBOARDING_REMINDER_TOAST_ID = "traycer-getting-started";
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
}
