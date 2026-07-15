import { Check, Download, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { cn } from "@/lib/utils";
import type { DesktopAppUpdateGuidance } from "@/lib/windows/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { trackUpdateDownloadStarted } from "@/lib/app-update-analytics";

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
  if (bridge === null) {
    return null;
  }

  if (snapshot.status === "available") {
    // Updates can't be installed from a read-only location (macOS app outside
    // /Applications): keep the affordance visible but disabled, with the reason
    // as the tooltip, instead of letting a click fail at install time.
    const blockedReason = snapshot.installBlockedReason;
    const versionLabel =
      snapshot.latestVersion === null
        ? "Download update"
        : `Download update v${snapshot.latestVersion}`;
    const label = blockedReason === null ? versionLabel : blockedReason;
    return (
      <TooltipWrapper label={label} side="top" sideOffset={6} align={undefined}>
        {/* Trigger off the span, not the Button: a disabled Button has
            `pointer-events-none`, so it would never fire the hover that opens
            the (block-reason) tooltip. */}
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={blockedReason !== null}
            aria-label={label}
            data-testid="app-update-header-button"
            className={cn(
              "rounded-full bg-sky-500 text-white hover:bg-sky-600 hover:text-white",
              blockedReason !== null && "disabled:opacity-60",
            )}
            onClick={() => {
              trackUpdateDownloadStarted("direct_ui");
              void bridge.downloadUpdate();
            }}
          >
            <Download className="size-4" aria-hidden />
          </Button>
        </span>
      </TooltipWrapper>
    );
  }

  if (snapshot.status === "downloading") {
    const progress = snapshot.downloadProgress;
    const label =
      progress === null ? "Downloading update" : `Downloading ${progress}%`;
    return (
      <TooltipWrapper label={label} side="top" sideOffset={6} align={undefined}>
        {/* Span trigger: the Button is always disabled here, so the tooltip
            (download %) must hang off an element that still receives hover. */}
        <span className="inline-flex">
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
        </span>
      </TooltipWrapper>
    );
  }

  if (snapshot.status !== "ready") {
    return null;
  }

  return (
    <AppUpdateReadyButton
      latestVersion={snapshot.latestVersion}
      installBlockedReason={snapshot.installBlockedReason}
      installGuidance={snapshot.installGuidance}
    />
  );
}

/**
 * The "ready" state splits into three cases sharing one round tick:
 * automated restart (emerald, opens the restart-confirm modal), a manual step
 * still needed (sky, opens the guidance dialog - Linux deb/rpm where silent
 * install can't/didn't work), or blocked with no path forward (disabled +
 * tooltip - macOS outside /Applications). `installBlockedReason` and
 * `installGuidance` shouldn't co-occur in practice (the download is gated
 * before a blocked location ever reaches "ready"), but the blocked reason
 * wins defensively if they ever do.
 */
function AppUpdateReadyButton(props: {
  readonly latestVersion: string | null;
  readonly installBlockedReason: string | null;
  readonly installGuidance: DesktopAppUpdateGuidance | null;
}) {
  const openConfirmRestartUpdate = useDesktopDialogStore(
    (state) => state.openConfirmRestartUpdate,
  );
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  const { installBlockedReason } = props;
  const needsManualInstall =
    installBlockedReason === null && props.installGuidance !== null;
  const restartLabel =
    props.latestVersion === null
      ? "Restart to update"
      : `Restart to update to v${props.latestVersion}`;
  const label =
    installBlockedReason ??
    (needsManualInstall ? "Finish update" : restartLabel);

  return (
    <TooltipWrapper label={label} side="top" sideOffset={6} align={undefined}>
      {/* Span trigger so the block-reason tooltip still opens when the Button
          is disabled (disabled Buttons have `pointer-events-none`). */}
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={installBlockedReason !== null}
          aria-label={label}
          data-testid="app-update-header-button"
          className={cn(
            "rounded-full text-white",
            needsManualInstall
              ? "bg-sky-500 hover:bg-sky-600 hover:text-white"
              : "bg-emerald-500 hover:bg-emerald-600 hover:text-white",
            installBlockedReason !== null && "disabled:opacity-60",
          )}
          onClick={() => {
            if (needsManualInstall) {
              // Same gesture as the toast's "View instructions" - both
              // guidance affordances report through the one event.
              Analytics.getInstance().track(
                AnalyticsEvent.UpdateInstallGuidanceOpened,
                { source: "direct_ui" },
              );
              openInstallGuidance();
              return;
            }
            openConfirmRestartUpdate();
          }}
        >
          {needsManualInstall ? (
            <Terminal className="size-4" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
        </Button>
      </span>
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
