import { toast } from "sonner";

/**
 * G4 narration for a FOLLOWING composer the derivation just re-pointed (selection model §2): its staged worktree/branch choices named paths and refs on the machine the user picked them on, so they were reset rather than silently carried to the new host.
 */
export function toastRepointedStagingReset(hostLabel: string): void {
  toast.info(
    `Worktree and branch choices were reset for ${hostLabel} — check the workspace before sending.`,
  );
}
