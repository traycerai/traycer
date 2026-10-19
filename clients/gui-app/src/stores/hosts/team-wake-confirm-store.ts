import { create } from "zustand";
import type { HostProfile } from "@traycer/protocol/host/host-status";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";

/**
 * Whether waking this sandbox asks first: a team sandbox's wake is billed to
 * the person who opens it, so a pick, a tile open, the card's Resume or Start
 * and the tile overlay's button all ask "Opening this resumes it on your
 * bundle" before they wake it. A team pod (`automation`) runs on the team's
 * free pod pool and never asks; nor does a personal sandbox, nor a frozen one,
 * whose wake is refused before it bills.
 */
export function teamWakeAsks(
  teamOwned: boolean,
  profile: HostProfile | null,
  frozen: boolean,
): boolean {
  return teamOwned && profile !== "automation" && !frozen;
}

/** A wake waiting on the person's answer, and the account that asked it. */
interface PendingTeamWake {
  readonly wake: () => void;
  readonly userId: string | null;
}

interface TeamWakeConfirmStore {
  readonly pending: PendingTeamWake | null;
}

export const useTeamWakeConfirmStore = create<TeamWakeConfirmStore>(() => ({
  pending: null,
}));

/**
 * Runs `wake` at once when it does not ask, and otherwise holds it for the
 * confirm dialog (`TeamWakeConfirmDialogHost`). A second ask while one is
 * open replaces it: the person answers the wake they asked for last.
 */
export function confirmTeamWake(asks: boolean, wake: () => void): void {
  if (!asks) {
    wake();
    return;
  }
  useTeamWakeConfirmStore.setState({
    pending: { wake, userId: signedInUserId() },
  });
}

/**
 * Answers the held wake: Resume runs it, Cancel drops it. A wake asked under
 * another account is dropped either way: its bundle is not this person's.
 */
export function settleTeamWake(confirmed: boolean): void {
  const pending = useTeamWakeConfirmStore.getState().pending;
  useTeamWakeConfirmStore.setState({ pending: null });
  if (!confirmed || pending === null) return;
  if (pending.userId !== signedInUserId()) return;
  pending.wake();
}
