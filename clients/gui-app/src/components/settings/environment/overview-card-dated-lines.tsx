import { useState, type ReactNode } from "react";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import {
  overviewDatedCopy,
  SHARED_BY_EARLIER_VERSION_DETAILS_LABEL,
  SHARED_BY_EARLIER_VERSION_LINE,
} from "@/components/settings/move/overview-dated-lines";
import { RetrospectiveSession } from "@/components/settings/move/retrospective-session";
import { reviewShownAt } from "@/components/settings/move/review-v11";
import { statusPlanesSupported } from "@/components/settings/move/status-planes-supported";
import {
  planesFromStatus,
  planesHaveSharedUnrecorded,
  planesOfferStopSharing,
  returnedFromTeamAt,
  stoppedSharingAt,
} from "@/components/settings/move/status-planes";
import { STOP_SHARING_TITLE } from "@/components/settings/move/stop-sharing-copy";
import { StopSharingSession } from "@/components/settings/move/stop-sharing-session";
import { Button } from "@/components/ui/button";
import { useEnvironmentReviewRead } from "@/hooks/environment/use-environment-reads";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";

/**
 * Overview settings-card dated lines P5 owns (shared by an earlier version,
 * stopped sharing, returned from a team) and `Stop sharing from this
 * computer`. `Moved to Personal on …` is E4's; P3's `Details` line is a
 * separate stub. The `Details` verb on the earlier-version line opens the
 * retrospective sheet.
 */
export function OverviewCardDatedLines(
  props: OverviewCardLineProps,
): ReactNode {
  const version = useHostNegotiatedMethodVersion(
    props.client,
    "environment.status",
  );
  const review = useEnvironmentReviewRead(props.client, props.hostId, true);
  const [stopOpen, setStopOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [autoConsumed, setAutoConsumed] = useState(false);
  if (!statusPlanesSupported(version)) return null;
  const planes = planesFromStatus(props.status);
  const sharedUnrecorded =
    planes !== null && planesHaveSharedUnrecorded(planes);
  const shownAt = review.data === null ? null : reviewShownAt(review.data);
  const shouldAutoOpen = sharedUnrecorded && shownAt === null && !autoConsumed;
  if (shouldAutoOpen && !sheetOpen) {
    setSheetOpen(true);
    setAutoConsumed(true);
  }
  const lines = overviewDatedCopy({
    returnedFromTeamAt: returnedFromTeamAt(props.status),
    sharedUnrecorded,
    stoppedAt: stoppedSharingAt(props.status),
  });
  const offerStop = planes !== null && planesOfferStopSharing(planes);
  if (lines.length === 0 && !offerStop && !sheetOpen) return null;
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
              onClick={() => setSheetOpen(true)}
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
      {offerStop ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="overview-stop-sharing"
          onClick={() => setStopOpen(true)}
        >
          {STOP_SHARING_TITLE}
        </Button>
      ) : null}
      <StopSharingSession
        client={props.client}
        hostId={props.hostId}
        hostName={props.hostName}
        open={stopOpen}
        onOpenChange={setStopOpen}
      />
      <RetrospectiveSession
        client={props.client}
        reviewHostId={props.hostId}
        stopClient={props.client}
        stopHostId={props.hostId}
        hostName={props.hostName}
        open={sheetOpen}
        held={null}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
