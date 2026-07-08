import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  formatInstallDate,
  VERSION_LIST_PREVIEW,
} from "@/components/settings/panels/host-settings-panel-model";
import type {
  HostAvailableSnapshot,
  HostAvailableVersionEntry,
} from "@traycer-clients/shared/platform/runner-host";

interface AvailableVersionsListProps {
  readonly availableSnapshot: HostAvailableSnapshot | undefined;
  readonly visibleVersions: readonly HostAvailableVersionEntry[];
  readonly installedVersion: string | null;
  readonly isPending: boolean;
  readonly errorMessage: string | null;
  readonly fetching: boolean;
  readonly anyPending: boolean;
  readonly showAllVersions: boolean;
  readonly onToggleShowAll: () => void;
  readonly onInstallVersion: (version: string) => void;
  readonly onRetry: () => void;
}

export function AvailableVersionsList(props: AvailableVersionsListProps) {
  const {
    availableSnapshot,
    visibleVersions,
    installedVersion,
    isPending,
    errorMessage,
    fetching,
    anyPending,
    showAllVersions,
    onToggleShowAll,
    onInstallVersion,
    onRetry,
  } = props;

  if (isPending) {
    return (
      <div className="text-ui-sm text-muted-foreground">Loading versions…</div>
    );
  }
  if (errorMessage !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border/40 bg-muted/20 p-3 text-ui-sm">
        <div className="text-foreground">
          Couldn&apos;t load versions from the registry.
        </div>
        <div className="break-words font-mono text-code-xs text-muted-foreground">
          {errorMessage}
        </div>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={fetching}
            onClick={onRetry}
          >
            {fetching ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (availableSnapshot === undefined || visibleVersions.length === 0) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No versions available.
      </div>
    );
  }
  return (
    <>
      <ul className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-md border border-border/40">
        {visibleVersions.map((entry) =>
          renderVersionRow({
            entry,
            isInstalled: entry.version === installedVersion,
            isLatest: entry.version === availableSnapshot.latest,
            anyPending,
            onInstallVersion,
          }),
        )}
      </ul>
      {availableSnapshot.versions.length > VERSION_LIST_PREVIEW ? (
        <div>
          <Button variant="ghost" size="sm" onClick={onToggleShowAll}>
            {showAllVersions ? "Show recent" : "Show all"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function renderVersionRow(props: {
  readonly entry: HostAvailableVersionEntry;
  readonly isInstalled: boolean;
  readonly isLatest: boolean;
  readonly anyPending: boolean;
  readonly onInstallVersion: (version: string) => void;
}) {
  const { entry, isInstalled, isLatest, anyPending, onInstallVersion } = props;
  const unavailableReason = platformUnavailableReason(entry);
  return (
    <li
      key={entry.version}
      className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-ui-sm"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-code-xs">v{entry.version}</span>
        {isLatest ? (
          <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-ui-xs text-emerald-300">
            latest
          </span>
        ) : null}
        {isInstalled ? (
          <span className="rounded bg-sky-900/40 px-2 py-0.5 text-ui-xs text-sky-300">
            installed
          </span>
        ) : null}
        {entry.yanked ? (
          <span className="rounded bg-rose-900/40 px-2 py-0.5 text-ui-xs text-rose-300">
            yanked
          </span>
        ) : null}
        <span className="text-ui-xs text-muted-foreground">
          {formatInstallDate(entry.releasedAt)}
        </span>
        {unavailableReason !== null ? (
          <span className="text-ui-xs text-muted-foreground">
            {unavailableReason}
          </span>
        ) : null}
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={
          anyPending ||
          isInstalled ||
          entry.yanked ||
          unavailableReason !== null
        }
        title={unavailableReason === null ? undefined : unavailableReason}
        onClick={() => onInstallVersion(entry.version)}
      >
        Install
      </Button>
    </li>
  );
}

function platformUnavailableReason(
  entry: HostAvailableVersionEntry,
): string | null {
  if (entry.platformAsset === null) {
    return "No asset for this platform.";
  }
  if (entry.platformAsset.available) {
    return null;
  }
  const reason = entry.platformAsset.unavailableReason?.trim();
  return reason === undefined || reason.length === 0
    ? "Unavailable on this platform."
    : reason;
}
