import { useState, type ReactNode } from "react";
import { onSettingsDate } from "@/lib/settings/settings-date";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import {
  overviewDatedCopy,
  SHARED_BY_EARLIER_VERSION_DETAILS_LABEL,
  SHARED_BY_EARLIER_VERSION_LINE,
} from "@/components/settings/move/overview-dated-lines";
import { statusPlanesSupported } from "@/components/settings/move/status-planes-supported";
import {
  planesFromStatus,
  planesHaveSharedUnrecorded,
  planesOfferStopSharing,
  returnedFromTeamAt,
  stoppedSharingAt,
} from "@/components/settings/move/status-planes";
import {
  stopCleanup,
  type StopCleanup,
} from "@/components/settings/move/stop-cleanup";
import {
  STOP_SHARING_TITLE,
  stopSharingDescription,
} from "@/components/settings/move/stop-sharing-copy";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import { Button } from "@/components/ui/button";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";

/**
 * Settings Details' dated lines (shared by an earlier version,
 * stopped using Personal with the cleanup it still owes, returned from a
 * team) and `Stop using Personal on this computer` with its help line.
 * The accepted move date is history, shown here rather than on Overview.
 * The `Details` verb on the
 * earlier-version line opens the retrospective sheet, mounted app-wide
 * (`EnvironmentSheetsHost`), which also shows it once by itself.
 */
export function OverviewCardDatedLines(
  props: OverviewCardLineProps & { readonly confirmBlocked?: boolean },
): ReactNode {
  const version = useHostNegotiatedMethodVersion(
    props.client,
    "environment.status",
  );
  const [stopOpen, setStopOpen] = useState(false);
  const unsupported = version !== null && !statusPlanesSupported(version);
  if (unsupported || (version === null && !stopOpen)) {
    if (stopOpen) setStopOpen(false);
    return null;
  }
  const { sharedUnrecorded, offerStop } = overviewStopFacts(props.status);
  const lines = overviewDatedCopy({
    returnedFromTeamAt: returnedFromTeamAt(props.status),
    sharedUnrecorded,
    stoppedAt: stoppedSharingAt(props.status),
  });
  if (stopOpen && !offerStop) setStopOpen(false);
  const showStopSheet = stopOpen && offerStop;
  const acceptedAt = props.status.consent?.acceptedAt ?? null;
  if (acceptedAt === null && lines.length === 0 && !offerStop) return null;
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="overview-card-dated-lines"
    >
      <OverviewDatedHistory {...props} acceptedAt={acceptedAt} lines={lines} />
      {offerStop ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="overview-stop-sharing"
            onClick={() => setStopOpen(true)}
          >
            {STOP_SHARING_TITLE}
          </Button>
          <p
            className="max-w-[72ch] text-ui-xs text-muted-foreground"
            data-testid="overview-stop-sharing-help"
          >
            {stopSharingDescription(props.hostName)}
          </p>
        </>
      ) : null}
      <StopSharingSession
        client={props.client}
        hostId={props.hostId}
        hostName={props.hostName}
        open={showStopSheet}
        confirmBlocked={props.confirmBlocked}
        onOpenChange={setStopOpen}
      />
    </div>
  );
}

function overviewStopFacts(status: OverviewCardLineProps["status"]): {
  readonly sharedUnrecorded: boolean;
  readonly offerStop: boolean;
} {
  const planes = planesFromStatus(status);
  return {
    sharedUnrecorded: planes !== null && planesHaveSharedUnrecorded(planes),
    offerStop: planes !== null && planesOfferStopSharing(planes),
  };
}

function OverviewDatedHistory(
  props: OverviewCardLineProps & {
    readonly acceptedAt: number | null;
    readonly lines: readonly string[];
  },
): ReactNode {
  const openRetrospective = useRetrospectiveSheetStore(
    (state) => state.openSheet,
  );
  const { acceptedAt, lines } = props;
  const cleanup = stopCleanup(props.status);
  return (
    <>
      {acceptedAt === null ? null : (
        <p className="text-ui-sm text-foreground">
          Moved to Personal {onSettingsDate(acceptedAt)}
        </p>
      )}
      {lines.map((line) =>
        line === SHARED_BY_EARLIER_VERSION_LINE ? (
          <p
            key={line}
            className="text-ui-sm text-foreground"
            data-testid="overview-shared-by-earlier-version"
          >
            {line}
            {" · "}
            <Button
              type="button"
              variant="link"
              size="inline-xs"
              data-testid="overview-shared-by-earlier-version-details"
              onClick={() =>
                openRetrospective({
                  hostId: props.hostId,
                  hostName: props.hostName,
                })
              }
            >
              {SHARED_BY_EARLIER_VERSION_DETAILS_LABEL}
            </Button>
          </p>
        ) : (
          <p key={line} className="text-ui-sm text-foreground">
            {line}
          </p>
        ),
      )}
      {cleanup === null ? null : <StopCleanupLines cleanup={cleanup} />}
    </>
  );
}

function StopCleanupLines(props: { readonly cleanup: StopCleanup }): ReactNode {
  return (
    <>
      {props.cleanup.pendingLine === null ? null : (
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="overview-stop-cleanup-pending"
        >
          {props.cleanup.pendingLine}
        </p>
      )}
      {props.cleanup.failedLines.map((line) => (
        <p
          key={line.id}
          className="text-ui-sm text-destructive"
          data-testid="overview-stop-cleanup-failed"
        >
          {line.text}
        </p>
      ))}
    </>
  );
}
