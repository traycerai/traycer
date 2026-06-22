import { RefreshCw } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { TeamsAccess, PeopleWithAccess } from "./access-lists";
import { InviteCard } from "./invite-card";
import {
  useEpicSharingPanelController,
  type SharingPanelController,
  type SharingRefreshProps,
} from "./use-controller";
import { cn } from "@/lib/utils";

const SHARING_REFRESH_TIMEOUT_MS = 10_000;

export function SharingPanel(props: { readonly epicId: string }) {
  const controller = useEpicSharingPanelController(props.epicId);
  return <SharingPanelContent controller={controller} />;
}

function SharingPanelContent(props: {
  readonly controller: SharingPanelController;
}) {
  const {
    canInvitePeople,
    showTeams,
    inviteCardProps,
    peopleHint,
    peopleProps,
    teamHint,
    teamsProps,
    revokeDialogProps,
    refreshProps,
  } = props.controller;

  return (
    <div className="flex flex-col">
      <SharingPanelHeader {...refreshProps} />

      {canInvitePeople ? (
        <PanelSection title={undefined} hint={undefined} className="gap-3">
          <InviteCard {...inviteCardProps} />
        </PanelSection>
      ) : null}

      <PanelSection
        title="People with access"
        hint={peopleHint}
        className={undefined}
      >
        <PeopleWithAccess {...peopleProps} />
      </PanelSection>

      {showTeams ? (
        <PanelSection title="Teams" hint={teamHint} className={undefined}>
          <TeamsAccess {...teamsProps} />
        </PanelSection>
      ) : null}

      <ConfirmDestructiveDialog
        open={revokeDialogProps.open}
        onOpenChange={revokeDialogProps.onOpenChange}
        title={revokeDialogProps.title}
        description={revokeDialogProps.description}
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={revokeDialogProps.isPending}
        onConfirm={revokeDialogProps.onConfirm}
      />
    </div>
  );
}

function SharingPanelHeader(props: SharingRefreshProps) {
  const { isRefreshing, lastFetchedAt, onRefresh } = props;
  const refreshCollaborators = useCallback(async () => {
    await onRefresh();
  }, [onRefresh]);
  const refresh = useRefreshSpinner({
    onRefresh: refreshCollaborators,
    externalRefreshing: isRefreshing,
    timeoutMs: SHARING_REFRESH_TIMEOUT_MS,
  });

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5">
      <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
        {lastFetchedAt !== null ? (
          <LastFetchedLabel timestamp={lastFetchedAt} />
        ) : (
          "Loading…"
        )}
      </span>
      <TooltipWrapper
        label="Refresh"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh.trigger}
          disabled={refresh.refreshing}
          aria-label="Refresh collaborators"
          data-testid="epic-sharing-refresh-button"
        >
          <RefreshCw
            className={cn("size-4", refresh.refreshing && "animate-spin")}
            data-testid={
              refresh.refreshing ? "epic-sharing-refresh-spinner" : undefined
            }
          />
        </Button>
      </TooltipWrapper>
    </div>
  );
}

function LastFetchedLabel(props: { readonly timestamp: number }) {
  const relative = useRelativeTimestamp(props.timestamp);
  return <>Updated {relative}</>;
}

function PanelSection(props: {
  title: string | undefined;
  hint: string | undefined;
  className: string | undefined;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2 border-b border-border/50 p-3 last:border-b-0",
        props.className,
      )}
    >
      {props.title !== undefined || props.hint ? (
        <div className="min-w-0">
          {props.title !== undefined ? (
            <h3 className="truncate text-ui-sm font-semibold tracking-wide text-foreground">
              {props.title}
            </h3>
          ) : null}
          {props.hint ? (
            <p className="mt-0.5 text-ui-xs text-muted-foreground">
              {props.hint}
            </p>
          ) : null}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}
