import { Check, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { cn } from "@/lib/utils";

/**
 * Compact circular update control in the header's right-side cluster. It cycles
 * through three states in the same footprint (no layout shift): download the
 * available update, show a filling progress ring, then a tick that opens the
 * restart-confirmation modal. It's a persistent fallback to the in-app update
 * toast - nothing renders until the updater reports an actionable state, so the
 * header stays clean when there is no update.
 */
export function AppUpdateHeaderButton() {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openConfirmRestartUpdate = useDesktopDialogStore(
    (state) => state.openConfirmRestartUpdate,
  );
  if (bridge === null) {
    return null;
  }

  if (snapshot.status === "available") {
    const label =
      snapshot.latestVersion === null
        ? "Download update"
        : `Download update v${snapshot.latestVersion}`;
    return (
      <TooltipWrapper label={label} side="top" sideOffset={6} align={undefined}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          data-testid="app-update-header-button"
          className="rounded-full bg-sky-500 text-white hover:bg-sky-600 hover:text-white"
          onClick={() => {
            void bridge.downloadUpdate();
          }}
        >
          <Download className="size-4" aria-hidden />
        </Button>
      </TooltipWrapper>
    );
  }

  if (snapshot.status === "downloading") {
    const progress = snapshot.downloadProgress;
    const label =
      progress === null ? "Downloading update" : `Downloading ${progress}%`;
    return (
      <TooltipWrapper label={label} side="top" sideOffset={6} align={undefined}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled
          aria-label={label}
          data-testid="app-update-header-button"
          className="rounded-full text-sky-600 opacity-100 disabled:opacity-100 dark:text-sky-300"
        >
          <DownloadProgressRing progress={progress} />
        </Button>
      </TooltipWrapper>
    );
  }

  if (snapshot.status !== "ready") {
    return null;
  }

  const label =
    snapshot.latestVersion === null
      ? "Restart to update"
      : `Restart to update to v${snapshot.latestVersion}`;
  return (
    <TooltipWrapper label={label} side="top" sideOffset={6} align={undefined}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        data-testid="app-update-header-button"
        className="rounded-full bg-emerald-500 text-white hover:bg-emerald-600 hover:text-white"
        onClick={openConfirmRestartUpdate}
      >
        <Check className="size-4" aria-hidden />
      </Button>
    </TooltipWrapper>
  );
}

// Mic-button-style determinate ring (mirrors `MicProgressRing`): the arc fills
// as the download progresses with the download icon centered inside. Falls back
// to a spinning indeterminate arc while progress is not yet known.
function DownloadProgressRing(props: { readonly progress: number | null }) {
  const radius = 8.5;
  const circumference = 2 * Math.PI * radius;
  const determinate = props.progress !== null;
  const clamped = determinate
    ? Math.min(1, Math.max(0, props.progress / 100))
    : 0;
  return (
    <span className="relative inline-flex size-5 items-center justify-center">
      <svg
        viewBox="0 0 20 20"
        className={cn(
          "absolute inset-0 size-full -rotate-90",
          !determinate && "animate-spin",
        )}
        aria-hidden
      >
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth="2"
        />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={determinate ? circumference : circumference * 0.3}
          strokeDashoffset={determinate ? circumference * (1 - clamped) : 0}
        />
      </svg>
      <Download className="size-3" aria-hidden />
    </span>
  );
}
