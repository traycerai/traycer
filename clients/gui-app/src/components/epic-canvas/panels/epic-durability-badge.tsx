import { Button } from "@/components/ui/button";
import { useEpicExportArtifacts } from "@/hooks/epic/use-epic-export-artifacts-mutation";
import {
  useEpicArtifactRecords,
  useEpicDurabilityPauseReason,
  useEpicDurabilityPromotionState,
  useEpicDurabilityStatus,
  useEpicSnapshotMeta,
} from "@/lib/epic-selectors";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import type {
  EpicDurabilityPauseReason,
  EpicDurabilityStatus,
  EpicPromotionState,
} from "@traycer/protocol/host/epic/subscribe";

/**
 * Host routing truth, kept separate from the cloud-sync pill: cloud transport
 * is not enough to tell a person whether their epic is local, promoting, or a
 * locally served cloud mirror.
 */
export function EpicDurabilityBadge() {
  const status = useEpicDurabilityStatus();
  const pauseReason = useEpicDurabilityPauseReason();
  const promotionState = useEpicDurabilityPromotionState();
  if (status === null) return null;
  return (
    <EpicDurabilityBadgeContent
      status={status}
      pauseReason={pauseReason}
      promotionState={promotionState}
    />
  );
}

function EpicDurabilityBadgeContent(props: {
  readonly status: EpicDurabilityStatus;
  readonly pauseReason: EpicDurabilityPauseReason | null;
  readonly promotionState: EpicPromotionState | null;
}) {
  const runnerHost = useRunnerHost();
  const exportArtifacts = useEpicExportArtifacts();
  const records = useEpicArtifactRecords();
  const meta = useEpicSnapshotMeta();

  const artifacts = records.flatMap((record) =>
    isEpicArtifactKind(record.type)
      ? [{ id: record.id, title: record.name }]
      : [],
  );
  const exportLocalArtifacts = (): void => {
    exportArtifacts.mutate({
      artifacts,
      format: "markdown",
      archive: true,
      archiveTitle: meta?.epicLight?.title ?? "Traycer",
    });
  };
  const badge = badgeCopy(
    props.status,
    props.pauseReason,
    props.promotionState,
  );
  return (
    <span
      data-testid="epic-durability-badge"
      data-durability-status={props.status}
      data-pause-reason={props.pauseReason ?? undefined}
      data-promotion-state={props.promotionState ?? undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-ui-xs font-medium",
        badge.className,
      )}
    >
      <span>{badge.label}</span>
      {props.status === "paused" &&
      props.pauseReason === "entitlement-lapsed" ? (
        <button
          type="button"
          className="underline underline-offset-2"
          data-testid="epic-durability-upgrade"
          onClick={() => {
            void runnerHost.openExternalLink(
              resolveManageSubscriptionUrl(runnerHost.authnBaseUrl),
            );
          }}
        >
          Upgrade
        </button>
      ) : null}
      {props.status === "paused" && props.pauseReason === "access-revoked" ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-auto px-0 text-current underline underline-offset-2"
          data-testid="epic-durability-export"
          disabled={artifacts.length === 0 || exportArtifacts.isPending}
          onClick={exportLocalArtifacts}
        >
          Export artifacts
        </Button>
      ) : null}
    </span>
  );
}

function badgeCopy(
  status: EpicDurabilityStatus,
  pauseReason: EpicDurabilityPauseReason | null,
  promotionState: EpicPromotionState | null,
): { readonly label: string; readonly className: string } {
  if (status === "promoting" && promotionState === "pending") {
    return {
      label: "Promotion pending",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  switch (status) {
    case "local":
      return {
        label: "Stored locally",
        className: "bg-muted text-muted-foreground",
      };
    case "promoting":
      return {
        label: "Promoting to cloud",
        className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
      };
    case "offline":
      return {
        label: "Cloud mirror — offline",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "paused":
      return pauseReason === "access-revoked"
        ? {
            label: "Sync blocked — access revoked",
            className: "bg-destructive/10 text-destructive",
          }
        : {
            label: "Sync paused",
            className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
          };
  }
}
