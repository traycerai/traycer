import { useThisComputer } from "@/components/settings/move/this-computer";
import { useThisComputersMove } from "@/components/settings/move/use-this-computers-move";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/**
 * Whether this computer's move ask holds the feature announcements back: one
 * ask at a time, as they already wait for the tour and the first-task guide.
 *
 * The ask is owed while this computer's status is still being read or names
 * a move the person has not answered on the Start page, and it stands while
 * the move sheet is open. Without the hold, a person who skips the tour gets
 * an announcement beside the move note, and following the note opens the
 * sheet with the announcement over its footer: the toaster paints at the
 * same bottom-right corner, above every sheet (`components/ui/sonner.tsx`).
 *
 * Held, never dropped: the announcement's claim is not taken while held, so
 * it shows once the move is answered and the sheet closes. A computer that
 * moved, runs a team's settings, or cannot answer (`unknown`) holds nothing.
 */
export function useMoveAskHoldsAnnouncements(enabled: boolean): boolean {
  const computer = useThisComputer();
  const move = useThisComputersMove(computer, enabled);
  const answered = useOnboardingStore((state) => state.moveInvitationAnswered);
  const sheetOpen = useMoveSheetStore((state) => state.target !== null);
  if (sheetOpen) return true;
  if (move === "pending") return true;
  return move === "not_moved" && !answered;
}
