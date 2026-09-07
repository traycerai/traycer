import { useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import type { SessionImportRunCounts } from "@traycer/protocol/host/session-import/run";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  progressSuccessToast,
  progressToast,
} from "@/lib/toast/progress-toast";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import {
  sessionImportDoneCount,
  sessionImportRunFor,
  useSessionImportRunStore,
} from "@/stores/session-import/session-import-run-store";

/**
 * The ambient window onto every import run: one persistent bottom-corner
 * toast PER HOST while its run goes, each resolving into its own transient
 * summary when that run completes.
 *
 * It reads the app-wide run store, never a wizard, so it behaves the same for
 * a run started from Settings, one started from the tour, and one this window
 * merely attached to. While the tour is on screen every toast HOLDS - the
 * act's copy already promises the import runs in the background, and the
 * toast greeting the user as they land in the real app is that promise kept.
 *
 * One child per host rather than one effect over the map: a host's toast has
 * its own bookkeeping - the run the user dismissed by hand, the summary
 * already shown, whether the progress toast is up - and folding two hosts'
 * bookkeeping into one set of refs is how a dismissal on one machine silenced
 * the other. A child mounts when a host's slice appears and unmounts when it
 * is retired, taking its toast down with it.
 */
export function SessionImportProgressToastBridge(): ReactNode {
  const tourOpen = useOnboardingTourOpenStore((state) => state.open);
  const hostIds = useSessionImportRunStore(
    useShallow((state) => [...state.runs.keys()]),
  );
  return hostIds.map((hostId) => (
    <HostImportToast key={hostId} hostId={hostId} tourOpen={tourOpen} />
  ));
}

function HostImportToast(props: {
  readonly hostId: string;
  readonly tourOpen: boolean;
}): null {
  const { hostId, tourOpen } = props;
  const toastId = `session-import-progress:${hostId}`;
  const run = useSessionImportRunStore(
    useShallow((state) => {
      const slice = sessionImportRunFor(state, hostId);
      return {
        status: slice.status,
        runId: slice.runId,
        done: sessionImportDoneCount(slice),
        total: slice.total,
        lastTitle: slice.lastTitle,
        finalCounts: slice.finalCounts,
      };
    }),
  );
  // Which machine this toast speaks for. With two hosts importing at once
  // the two toasts are otherwise identical lines, and even alone the name
  // says where the sessions landed.
  const hostLabel = useHostDirectoryEntry(hostId)?.label ?? null;
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
          id: toastId,
          duration: Infinity,
          // Always one line: the toast's height is then the same from the first
          // frame to the last, instead of jumping as titles wrap. Before the
          // first session lands there is no title yet, and a blank line there
          // read as a gap - so the line says what the run is doing instead.
          description: (
            <span className="block truncate">
              {withHostLabel(
                hostLabel,
                run.lastTitle ?? "Reading your sessions…",
              )}
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
      showCompletionToast(toastId, hostLabel, run.finalCounts);
      return;
    }

    // idle (the store reset) or error (the stream was lost): nothing to show,
    // and a lingering progress toast would be reporting a run this window no
    // longer watches.
    if (progressVisibleRef.current) {
      progressVisibleRef.current = false;
      toast.dismiss(toastId);
    }
    if (run.status === "idle") {
      dismissedRunRef.current = null;
    }
  }, [hostLabel, run, toastId, tourOpen]);

  // The slice was retired (the wizard's "Import more", or a reopen): the
  // progress toast, if still up, is reporting a run nothing watches any more.
  useEffect(
    () => () => {
      if (!progressVisibleRef.current) return;
      progressVisibleRef.current = false;
      toast.dismiss(toastId);
    },
    [toastId],
  );

  return null;
}

function withHostLabel(hostLabel: string | null, line: string): string {
  return hostLabel === null ? line : `${hostLabel} · ${line}`;
}

function showCompletionToast(
  toastId: string,
  hostLabel: string | null,
  counts: SessionImportRunCounts | null,
): void {
  const imported = counts?.imported ?? 0;
  const parts: string[] = [];
  if (hostLabel !== null) parts.push(hostLabel);
  if (counts !== null && counts.skippedAlreadyImported > 0) {
    parts.push(`${counts.skippedAlreadyImported} already in Traycer`);
  }
  if (counts !== null && counts.failed > 0) {
    parts.push(`${counts.failed} failed`);
  }
  const description = parts.length > 0 ? parts.join(" · ") : undefined;
  if (imported === 0) {
    toast.message("Nothing was imported", {
      id: toastId,
      duration: 4000,
      description,
      icon: undefined,
    });
    return;
  }
  progressSuccessToast(
    `Imported ${imported.toLocaleString()} ${imported === 1 ? "session" : "sessions"}`,
    {
      id: toastId,
      description,
    },
  );
}
