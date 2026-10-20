import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  settleTeamWake,
  useTeamWakeConfirmStore,
} from "@/stores/hosts/team-wake-confirm-store";

/**
 * The one confirm in front of a team sandbox's wake (`confirmTeamWake`).
 * Mounted once at the root, so a pick in a picker that closes on pick still
 * has its question answered. Shown only to the account that asked.
 */
export function TeamWakeConfirmDialogHost(): ReactNode {
  const pending = useTeamWakeConfirmStore((state) => state.pending);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const open = pending !== null && pending.userId === userId;
  // A wake held for another account is dropped, not kept for its return:
  // the question was that account's, asked then.
  const stale = pending !== null && pending.userId !== userId;
  useEffect(() => {
    if (stale) settleTeamWake(false);
  }, [stale]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settleTeamWake(false);
      }}
    >
      <DialogContent
        layout="banded"
        className="w-full min-w-0"
        style={{ maxWidth: "min(92vw, 28rem)" }}
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="team-wake-confirm"
      >
        <DialogHeader>
          <DialogTitle>Opening this resumes it on your bundle.</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="team-wake-confirm-cancel"
            onClick={() => settleTeamWake(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="team-wake-confirm-resume"
            onClick={() => settleTeamWake(true)}
          >
            Resume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
