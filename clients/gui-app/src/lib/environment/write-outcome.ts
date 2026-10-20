import type { EnvironmentStaleWrite } from "@traycer/protocol/framework/environment-stale-write";
import type { EnvironmentWriteOutcome } from "@traycer/protocol/host/environment-schemas";
import { toast } from "sonner";
import { staleWriteMessage } from "@/lib/environment/stale-write";

/**
 * A save that lost to a newer change is not a failure to report: the page has
 * re-read, and the person only needs to know where the change came from.
 */
export function showStaleWriteNotice(staleWrite: EnvironmentStaleWrite): void {
  toast.info(staleWriteMessage(staleWrite), { id: "environment-write-stale" });
}

/**
 * A page edit's outcome arrives as a result, not an error, so the error path's
 * notice never sees it. `stale` gets the same notice; `pending` shows in the
 * frame's status line and `needs_grant` in the "needs you" row, both read by
 * the caller's invalidations.
 */
export function noticeWriteOutcome(outcome: EnvironmentWriteOutcome): void {
  if (outcome.outcome === "stale") {
    showStaleWriteNotice({
      changedBy: outcome.changedBy,
      currentRevision: outcome.currentRevision,
    });
  }
}
