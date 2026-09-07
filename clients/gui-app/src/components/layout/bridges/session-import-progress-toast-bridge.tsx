import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import type { SessionImportRunCounts } from "@traycer/protocol/host/session-import/run";
import {
  progressSuccessToast,
  progressToast,
} from "@/lib/toast/progress-toast";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import {
  sessionImportDoneCount,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

const SESSION_IMPORT_PROGRESS_TOAST_ID = "session-import-progress";

/**
 * The one ambient window onto an import run: a persistent bottom-corner toast
 * while it runs, resolving into a transient summary when it completes.
 *
 * It reads the app-wide run store, never a wizard, so it behaves the same for
 * a run started from Settings, one started from the tour, and one this window
 * merely attached to. While the tour is on screen the toast HOLDS - the act's
 * copy already promises the import runs in the background, and the toast
 * greeting the user as they land in the real app is that promise kept.
 *
 * A run whose stream is lost ("error") just retires the toast quietly: no
 * other feature announces a dropped stream, and the Settings row still shows
 * the run's state to anyone who looks.
 */
export function SessionImportProgressToastBridge(): null {
  const tourOpen = useOnboardingTourOpenStore((state) => state.open);
  const run = useSessionImportRunStore(
    useShallow((state) => ({
      status: state.status,
      runId: state.runId,
      done: sessionImportDoneCount(state),
      total: state.total,
      lastTitle: state.lastTitle,
      finalCounts: state.finalCounts,
    })),
  );
  // The run whose progress toast the user closed by hand: stay quiet for the
  // rest of that run, but let the next one toast again.
  const dismissedRunRef = useRef<string | null>(null);
  // The run whose completion summary has been shown, so a re-render after the
  // transient toast expired does not resurrect it.
  const completedRunRef = useRef<string | null>(null);
  const progressVisibleRef = useRef(false);

  useEffect(() => {
    if (run.status === "starting" || run.status === "running") {
      if (tourOpen) return;
      const runKey = run.runId ?? "starting";
      // A dismissal during "starting" was aimed at this same run; carry it
      // over when the host's `started` frame swaps the key to the real id.
      if (dismissedRunRef.current === "starting" && run.runId !== null) {
        dismissedRunRef.current = run.runId;
      }
      if (dismissedRunRef.current === runKey) return;
      progressVisibleRef.current = true;
      progressToast(
        // Between submit and the host's `started` there is a real run with
        // nothing to count yet; say so instead of "0 of 0".
        run.total === 0
          ? "Starting import…"
          : `Importing ${run.done.toLocaleString()} of ${run.total.toLocaleString()}…`,
        {
          id: SESSION_IMPORT_PROGRESS_TOAST_ID,
          duration: Infinity,
          // Always one line: the toast's height is then the same from the first
          // frame to the last, instead of jumping as titles wrap. Before the
          // first session lands there is no title yet, and a blank line there
          // read as a gap - so the line says what the run is doing instead.
          description: (
            <span className="block truncate">
              {run.lastTitle ?? "Reading your sessions…"}
            </span>
          ),
          onDismiss: () => {
            // Fires only for the user's own close: the terminal paths below
            // replace or dismiss this toast after clearing the visible flag.
            if (!progressVisibleRef.current) return;
            progressVisibleRef.current = false;
            dismissedRunRef.current = runKey;
          },
        },
      );
      return;
    }

    if (run.status === "complete") {
      if (tourOpen) return;
      if (run.runId === null || completedRunRef.current === run.runId) return;
      completedRunRef.current = run.runId;
      progressVisibleRef.current = false;
      showCompletionToast(run.finalCounts);
      return;
    }

    // idle (the store reset) or error (the stream was lost): nothing to show,
    // and a lingering progress toast would be reporting a run this window no
    // longer watches.
    if (progressVisibleRef.current) {
      progressVisibleRef.current = false;
      toast.dismiss(SESSION_IMPORT_PROGRESS_TOAST_ID);
    }
    if (run.status === "idle") {
      dismissedRunRef.current = null;
    }
  }, [run, tourOpen]);

  return null;
}

function showCompletionToast(counts: SessionImportRunCounts | null): void {
  const imported = counts?.imported ?? 0;
  const parts: string[] = [];
  if (counts !== null && counts.skippedAlreadyImported > 0) {
    parts.push(`${counts.skippedAlreadyImported} already in Traycer`);
  }
  if (counts !== null && counts.failed > 0) {
    parts.push(`${counts.failed} failed`);
  }
  const description = parts.length > 0 ? parts.join(" · ") : undefined;
  if (imported === 0) {
    toast.message("Nothing was imported", {
      id: SESSION_IMPORT_PROGRESS_TOAST_ID,
      duration: 4000,
      description,
      icon: undefined,
    });
    return;
  }
  progressSuccessToast(
    `Imported ${imported.toLocaleString()} ${imported === 1 ? "session" : "sessions"}`,
    {
      id: SESSION_IMPORT_PROGRESS_TOAST_ID,
      description,
    },
  );
}
