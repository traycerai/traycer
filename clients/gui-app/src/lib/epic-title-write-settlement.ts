import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { EpicSessionEndedError } from "@/stores/epics/open-epic/store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { appLogger } from "@/lib/logger";

/**
 * The tail both direct epic-title renames share: wait for the authority's answer, run the caller's own committed work, and turn anything else into the one toast.
 */
export function settleEpicTitleWrite(
  settled: Promise<CommandRecord<EpicWriteCommandIntent>>,
  options: {
    /** Ran only for a committed answer - the caller's own cache/analytics work. */
    readonly onCommitted: () => void;
    /** `source` on the failure toast, so the report names the surface. */
    readonly source: string;
  },
): void {
  void settled.then(
    (command) => {
      if (command.state === "committed") {
        options.onCommitted();
        return;
      }
      const message =
        command.resolution?.kind === "rejected"
          ? command.resolution.reason
          : "A newer authoritative title superseded this rename.";
      reportableErrorToast("Couldn't rename epic.", undefined, {
        title: "Could not rename Epic",
        message,
        code: null,
        source: options.source,
      });
    },
    (cause: unknown) => {
      // The session ending IS the answer here, and it is not a failure the person renaming can act on: the epic they were renaming is gone or is being re-established on another host, and the rename was never dispatched to an authority.
      if (cause instanceof EpicSessionEndedError) return;
      throw cause;
    },
  );
}

/** Terminal handler for the DETACHED half of a direct epic-title rename. */
export function settleDetachedEpicTitleCommit(
  commit: Promise<void>,
  source: string,
): void {
  void commit.catch((cause: unknown) => {
    // Cancellation, exactly as the tail above treats it: the session ending is
    // the answer, and not one the person renaming can act on.
    if (cause instanceof EpicSessionEndedError) return;
    appLogger.warn("epic title rename failed before dispatch", {
      source,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    reportableErrorToast("Couldn't rename epic.", undefined, {
      title: "Could not rename Epic",
      message: null,
      code: null,
      source,
    });
  });
}
