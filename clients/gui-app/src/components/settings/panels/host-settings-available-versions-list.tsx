import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  HostVersionRows,
  type HostVersionRow,
} from "@/components/settings/panels/host-version-rows";
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

/**
 * The recovery console's version list: the LOCAL CLI bridge's answer.
 *
 * Rows are rendered by `HostVersionRows`, shared with the Overview's
 * `host.update.check` list. This half owns what only the bridge has — a real
 * registry error string with its own Retry, independent of the update region's
 * retry above it, since the two failures are unrelated and can both be live.
 */
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
        <div className="flex flex-wrap items-center gap-2">
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
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't load host versions",
              message: "The host version registry could not be loaded.",
              code: null,
              source: "Host versions",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      </div>
    );
  }
  if (availableSnapshot === undefined) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No versions available.
      </div>
    );
  }
  return (
    <HostVersionRows
      rows={visibleVersions.map((entry) =>
        bridgeVersionRow(entry, availableSnapshot.latest, installedVersion),
      )}
      totalCount={availableSnapshot.versions.length}
      showAll={showAllVersions}
      onToggleShowAll={onToggleShowAll}
      // The bridge install is fire-and-forget from this list's vantage — the
      // update region above owns the progress and the terminal banner — so no
      // row is individually spinning; `anyPending` freezes them all.
      installingVersion={null}
      disabled={anyPending}
      onInstall={onInstallVersion}
    />
  );
}

function bridgeVersionRow(
  entry: HostAvailableVersionEntry,
  latest: string,
  installedVersion: string | null,
): HostVersionRow {
  return {
    version: entry.version,
    releasedAt: entry.releasedAt,
    yanked: entry.yanked,
    isLatest: entry.version === latest,
    isInstalled: entry.version === installedVersion,
    unavailableReason: platformUnavailableReason(entry),
  };
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
