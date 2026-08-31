import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { EpicSessionEndedError } from "@/stores/epics/open-epic/store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { appLogger } from "@/lib/logger";

/**
 * The tail both direct epic-title renames share: wait for the authority's
 * answer, run the caller's own committed work, and turn anything else into the
 * one toast.
 *
 * Extracted because the two call sites (the header tab strip and the mobile
 * epic header) held BYTE-IDENTICAL copies of this tail, and a copy is what let
 * the same defect be missed at both: when `waitForWriteCommand` became total
 * and started REJECTING on teardown, each site's fulfillment-only `.then` was
 * left turning that into an unhandled rejection. One tail means the next change
 * to the contract is answered once.
 *
 * The two sites are NOT collapsed further: their committed arms genuinely
 * differ (the mobile one owns analytics and a success toast that the strip
 * deliberately does not raise), which is exactly what `onCommitted` carries.
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
      // The session ending IS the answer here, and it is not a failure the
      // person renaming can act on: the epic they were renaming is gone or is
      // being re-established on another host, and the rename was never
      // dispatched to an authority. Cancellation, so no toast - and consumed,
      // because a fulfillment-only handler would make every host replacement
      // with a rename in flight an unhandled rejection.
      if (cause instanceof EpicSessionEndedError) return;
      throw cause;
    },
  );
}

/**
 * Terminal handler for the DETACHED half of a direct epic-title rename.
 *
 * `onCommit` is declared void-returning, so both surfaces hand their async
 * commit straight to `void` - and everything that commit awaits BEFORE it
 * reaches `settleEpicTitleWrite` is outside that tail's reach. One awaited call
 * matters: `enqueueWriteCommand` runs through `callOrNullOnTeardown`, which
 * answers `null` for a disposed bridge and RETHROWS every real fault, exactly
 * so a decode failure or a worker that threw is not mistaken for a closed
 * session. Detached, that fault was an unhandled rejection and - the half the
 * person renaming actually experiences - a rename that silently did nothing,
 * on the one path here that raises no toast when every sibling arm does.
 *
 * Deliberately NOT modelled on this module's other export. `settleEpicTitleWrite`
 * rethrows a genuine settlement failure on purpose, and a test pins that: by
 * then the command is with an authority and the surface has already been told,
 * so swallowing it would hide a real fault. Here the write never got that far
 * and nothing has been reported, so the honest answer is the same failure toast
 * the sibling arms raise - a report, not a blanket catch.
 */
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
