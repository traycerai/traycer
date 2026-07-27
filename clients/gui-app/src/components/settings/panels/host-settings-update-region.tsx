import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  formatCheckedAtTooltip,
  updatesDescription,
} from "@/components/settings/panels/host-settings-panel-model";
import type {
  DownloadProgress,
  HostRegistryUpdateState,
} from "@traycer-clients/shared/platform/runner-host";

interface HostUpdateRegionProps {
  readonly registryState: HostRegistryUpdateState | undefined;
  readonly registryFetching: boolean;
  readonly anyPending: boolean;
  readonly updatePending: boolean;
  readonly latestReleasedAt: string | null;
  readonly nowMs: number;
  // Canonical two-lane status (Host Update Layer Redesign Tech Plan) - the
  // action button gates on `updateReady`/`stagedVersion`, never the raw
  // `registryState.updateAvailable` detection, so this row never offers an
  // action for a merely-detected update. `downloadProgress` is purely
  // informational (the download lane never disables this region's actions).
  readonly updateReady: boolean;
  readonly stagedVersion: string | null;
  readonly downloadProgress: DownloadProgress | null;
  readonly onUpdate: () => void;
  readonly onRefresh: () => void;
}

/**
 * Compact bottom region of the Host summary card (Flow 5): "Up to date /
 * Check now", Retry, download progress, or a staged version label next to
 * an "Update" button - same states as the prior `SettingsRow`-based Updates
 * row, just no longer its own labelled row (the description text already
 * carries the state).
 */
export function HostUpdateRegion(props: HostUpdateRegionProps) {
  const {
    registryState,
    registryFetching,
    anyPending,
    updatePending,
    latestReleasedAt,
    nowMs,
    updateReady,
    stagedVersion,
    downloadProgress,
    onUpdate,
    onRefresh,
  } = props;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 bg-muted/10 px-5 py-2.5 text-ui-sm">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {updatesDescription({
          registryState,
          registryFetching,
          latestReleasedAt,
          nowMs,
        })}
      </span>
      <UpdatesControl
        registryState={registryState}
        registryFetching={registryFetching}
        anyPending={anyPending}
        updatePending={updatePending}
        updateReady={updateReady}
        stagedVersion={stagedVersion}
        downloadProgress={downloadProgress}
        onUpdate={onUpdate}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function UpdatesControl(props: {
  readonly registryState: HostRegistryUpdateState | undefined;
  readonly registryFetching: boolean;
  readonly anyPending: boolean;
  readonly updatePending: boolean;
  readonly updateReady: boolean;
  readonly stagedVersion: string | null;
  readonly downloadProgress: DownloadProgress | null;
  readonly onUpdate: () => void;
  readonly onRefresh: () => void;
}) {
  const {
    registryState,
    registryFetching,
    anyPending,
    updatePending,
    updateReady,
    stagedVersion,
    downloadProgress,
    onUpdate,
    onRefresh,
  } = props;

  if (updateReady) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span
          className="font-mono text-code-xs text-muted-foreground"
          data-testid="settings-host-staged-version"
        >
          {stagedVersion === null ? "latest" : `v${stagedVersion}`}
        </span>
        <Button
          variant="default"
          size="sm"
          disabled={anyPending}
          onClick={onUpdate}
          data-testid="settings-host-update-action"
        >
          {updatePending ? (
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Update
        </Button>
      </div>
    );
  }

  if (downloadProgress !== null) {
    const percent =
      downloadProgress.percent !== null
        ? Math.max(0, Math.min(100, Math.round(downloadProgress.percent)))
        : null;
    return (
      <div
        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
        data-testid="settings-host-download-progress"
      >
        <AgentSpinningDots
          className="size-3"
          testId={undefined}
          variant={undefined}
        />
        <span>
          Downloading update{percent !== null ? `… ${percent}%` : "…"}
        </span>
      </div>
    );
  }

  if (registryState !== undefined && !registryState.reachable) {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled={registryFetching}
        onClick={onRefresh}
      >
        {registryFetching ? (
          <AgentSpinningDots
            className="mr-2 size-3"
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Retry
      </Button>
    );
  }

  const tooltipLabel = formatCheckedAtTooltip(registryState?.checkedAt ?? null);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-ui-sm text-emerald-500">Up to date</span>
      <TooltipWrapper
        label={tooltipLabel}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="sm"
            disabled={registryFetching}
            onClick={onRefresh}
          >
            {registryFetching ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Check now
          </Button>
        </span>
      </TooltipWrapper>
    </div>
  );
}
