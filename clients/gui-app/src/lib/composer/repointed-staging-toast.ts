import { toast } from "sonner";

/**
 * G4 narration for a FOLLOWING composer the derivation just re-pointed
 * (selection model §2): its staged worktree/branch choices named paths and
 * refs on the machine the user picked them on, so they were reset rather
 * than silently carried to the new host.
 *
 * Fired ONLY when the move actually reset staged intent. A move that reset
 * nothing stays silent here - `toastSelectionSwitched` already narrates the
 * failover/recovery itself, and re-announcing every derivation move made a
 * startup failover round trip end on a persistent banner presenting the
 * user's own host as news. A toast, not the inline notice slot: the reset
 * is informational, not a submit blocker, and the composer's workspace
 * picker plus §54 submit re-validation stand behind it either way.
 */
export function toastRepointedStagingReset(hostLabel: string): void {
  toast.info(
    `Worktree and branch choices were reset for ${hostLabel} — check the workspace before sending.`,
  );
}
