import type { ReactNode } from "react";
import { useColumnOverlayPlacement } from "@/components/layout/column-edge-context";
import { Check, Download, Terminal } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { cn } from "@/lib/utils";
import type {
  DesktopAppUpdateGuidance,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { requestAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
import {
  trackUpdateDownloadStarted,
  trackUpdateRestartRequested,
} from "@/lib/app-update-analytics";

/** How the update control is drawn: the header's round icon button, or the
 * strip foot's row with the state written out beside the icon. */
export type AppUpdateControlLayout = "icon" | "row";

/** One actionable updater state, drawn by either layout. */
interface AppUpdateControlView {
  /** The state in words: the icon's tooltip and name, the row's text. */
  readonly label: string;
  readonly disabled: boolean;
  /** Blocked with no way forward: the icon dims, the reason stays legible. */
  readonly dimmed: boolean;
  /** The icon button's own look for this state. */
  readonly buttonVariant: "ghost" | "info-ghost";
  readonly buttonClassName: string;
  readonly icon: ReactNode;
  readonly onClick: (() => void) | undefined;
}

/**
 * The update control. It cycles through three states in the same footprint
 * (no layout shift): download the available update, show a filling progress
 * ring, then a tick that restarts to install. It's a persistent fallback to
 * the in-app update toast - nothing renders until the updater reports an
 * actionable state, so the header and the strip foot stay clean when there is
 * no update.
 */
export function AppUpdateHeaderButton(props: {
  readonly layout: AppUpdateControlLayout;
}) {
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
    return (
      <AppUpdateControl
        layout={props.layout}
        view={{
          label: blockedReason === null ? versionLabel : blockedReason,
          disabled: blockedReason !== null,
          dimmed: blockedReason !== null,
          buttonVariant: "ghost",
          buttonClassName: "rounded-full bg-info text-white",
          icon: <Download className="size-4" aria-hidden />,
          onClick: () => {
            trackUpdateDownloadStarted("direct_ui");
            void bridge.downloadUpdate();
          },
        }}
      />
    );
  }

  if (snapshot.status === "downloading") {
    const progress = snapshot.downloadProgress;
    return (
      <AppUpdateControl
        layout={props.layout}
        view={{
          label:
            progress === null
              ? "Downloading update"
              : `Downloading ${progress}%`,
          disabled: true,
          dimmed: false,
          buttonVariant: "info-ghost",
          buttonClassName: "rounded-full opacity-100 disabled:opacity-100",
          icon: <DownloadProgressRing progress={progress} />,
          onClick: undefined,
        }}
      />
    );
  }

  if (snapshot.status !== "ready") {
    return null;
  }

  return (
    <AppUpdateReadyButton
      layout={props.layout}
      bridge={bridge}
      latestVersion={snapshot.latestVersion}
      installBlockedReason={snapshot.installBlockedReason}
      installGuidance={snapshot.installGuidance}
      installInFlight={snapshot.installInFlight}
    />
  );
}

/** Draws one updater state in the requested layout. */
function AppUpdateControl(props: {
  readonly layout: AppUpdateControlLayout;
  readonly view: AppUpdateControlView;
}) {
  const placement = useColumnOverlayPlacement("foot");
  const { view } = props;
  if (props.layout === "row") {
    // The whole row is the control, its name the label alone, so the icon's
    // live status (the restart) is announced without renaming it. A blocked
    // row's reason is its only explanation, so it wraps in full; every other
    // state is one line, cut short, with the label in full in a tooltip.
    const blocked = view.dimmed;
    const row = (
      <button
        type="button"
        disabled={view.disabled}
        aria-label={view.label}
        data-layout-passive
        data-testid="app-update-row"
        onClick={view.onClick}
        className={cn(
          "flex w-full min-w-0 shrink-0 items-center gap-2 rounded-lg px-2 text-left text-ui-sm text-foreground outline-none hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:hover:bg-transparent [-webkit-app-region:no-drag]",
          blocked ? "min-h-8 py-1.5" : "h-8",
        )}
      >
        {/* Not `aria-hidden`: its glyphs hide themselves, and the restart's
            status region must stay exposed. The 20px disc is centred on the
            strip rows' 16px leading box and ends where their reserved space
            does, so the label starts in line with every row title. */}
        <span
          className={cn(
            "-ms-0.5 me-1.5 flex size-5 shrink-0 items-center justify-center [&>svg]:size-3",
            view.buttonVariant === "info-ghost"
              ? "text-info-foreground"
              : view.buttonClassName,
            // The row's own `disabled` never reaches this span, so a blocked
            // state dims its disc here, as the icon button dims.
            view.dimmed && "opacity-60",
          )}
        >
          {view.icon}
        </span>
        <span
          className={cn("min-w-0 flex-1", blocked ? "text-pretty" : "truncate")}
        >
          {view.label}
        </span>
      </button>
    );
    if (blocked) return row;
    return (
      <TooltipWrapper
        label={view.label}
        side={placement?.side ?? "top"}
        sideOffset={6}
        align={placement?.align}
      >
        {/* Off a wrapper, as below: a disabled row (downloading, restarting)
            never fires the hover that opens the tooltip. */}
        <span className="flex w-full min-w-0">{row}</span>
      </TooltipWrapper>
    );
  }
  return (
    <TooltipWrapper
      label={view.label}
      side={placement?.side ?? "top"}
      sideOffset={6}
      align={placement?.align}
    >
      {/* Trigger off the span, not the Button: a disabled Button has
          `pointer-events-none`, so it would never fire the hover that opens
          the (block-reason / progress) tooltip. */}
      {/* Non-editable chrome, dimmed while a layout session is live (4.2). */}
      <span data-layout-passive className="inline-flex">
        <Button
          type="button"
          variant={view.buttonVariant}
          size="icon-sm"
          disabled={view.disabled}
          aria-label={view.label}
          data-testid="app-update-header-button"
          className={cn(
            view.buttonClassName,
            view.dimmed && "disabled:opacity-60",
          )}
          onClick={view.onClick}
        >
          {view.icon}
        </Button>
      </span>
    </TooltipWrapper>
  );
}

/**
 * The "ready" state splits into three cases sharing one round tick:
 * automated restart (emerald, restarts to install straight away - the click
 * IS the confirmation, and the host keeps running agents across the app
 * restart), a manual step still needed (sky, opens the guidance dialog - Linux
 * deb/rpm where silent install can't/didn't work), or blocked with no path
 * forward (disabled + tooltip - macOS outside /Applications).
 * `installBlockedReason` and `installGuidance` shouldn't co-occur in practice
 * (the download is gated before a blocked location ever reaches "ready"), but
 * the blocked reason wins defensively if they ever do.
 */
function AppUpdateReadyButton(props: {
  readonly layout: AppUpdateControlLayout;
  readonly bridge: DesktopAppUpdatesBridge;
  readonly latestVersion: string | null;
  readonly installBlockedReason: string | null;
  readonly installGuidance: DesktopAppUpdateGuidance | null;
  readonly installInFlight: boolean;
}) {
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  // Pending state is read from the snapshot, not latched locally: the quit that
  // installs drains in-flight work first, so this button (and the ready toast,
  // and both of them in every other window) stays on screen through it. Main
  // owns the fact, so all of them disarm together and a remount can't re-arm
  // this one.
  const { installBlockedReason, installInFlight } = props;
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
    <AppUpdateControl
      layout={props.layout}
      view={{
        label,
        disabled: installBlockedReason !== null || installInFlight,
        dimmed: installBlockedReason !== null,
        buttonVariant: "ghost",
        buttonClassName: cn(
          "rounded-full text-white",
          needsManualInstall
            ? "bg-info hover:text-white"
            : "bg-success hover:text-white",
          installInFlight && "disabled:opacity-100",
        ),
        icon: (
          <AppUpdateReadyIcon
            installInFlight={installInFlight}
            needsManualInstall={needsManualInstall}
          />
        ),
        onClick: () => {
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
          trackUpdateRestartRequested("direct_ui");
          void requestAppUpdateInstall(props.bridge);
        },
      }}
    />
  );
}

function AppUpdateReadyIcon(props: {
  readonly installInFlight: boolean;
  readonly needsManualInstall: boolean;
}) {
  if (props.installInFlight) {
    // The button only goes `disabled` here - nothing announces the state
    // change on its own, so the spinner carries a live region (the icons it
    // replaces are decorative and the accessible name stays the same).
    return (
      <span role="status" aria-label="Restarting to install the update">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </span>
    );
  }
  if (props.needsManualInstall) {
    return <Terminal className="size-4" aria-hidden />;
  }
  return <Check className="size-4" aria-hidden />;
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
