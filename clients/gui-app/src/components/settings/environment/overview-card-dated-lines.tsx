import { useState, type ReactNode } from "react";
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
 * Overview settings-card dated lines P5 owns (shared by an earlier version,
 * stopped using Personal with the cleanup it still owes, returned from a
 * team) and `Stop using Personal on this computer` with its help line.
 * `Moved to Personal on …` is E4's; P3's
 * `Details` line is a separate stub. The `Details` verb on the
 * earlier-version line opens the retrospective sheet, mounted app-wide
 * (`EnvironmentSheetsHost`), which also shows it once by itself.
 */
export function OverviewCardDatedLines(
  props: OverviewCardLineProps,
): ReactNode {
  const version = useHostNegotiatedMethodVersion(
    props.client,
    "environment.status",
  );
  const [stopOpen, setStopOpen] = useState(false);
  const openRetrospective = useRetrospectiveSheetStore(
    (state) => state.openSheet,
  );
  if (!statusPlanesSupported(version)) return null;
  const planes = planesFromStatus(props.status);
  const sharedUnrecorded =
    planes !== null && planesHaveSharedUnrecorded(planes);
  const lines = overviewDatedCopy({
    returnedFromTeamAt: returnedFromTeamAt(props.status),
    sharedUnrecorded,
    stoppedAt: stoppedSharingAt(props.status),
  });
  const cleanup = stopCleanup(props.status);
  const offerStop = planes !== null && planesOfferStopSharing(planes);
  if (lines.length === 0 && !offerStop) return null;
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="overview-card-dated-lines"
    >
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
        open={stopOpen}
        onOpenChange={setStopOpen}
      />
    </div>
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
