import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TEAM_EPIC_PERSONAL_LINE,
  teamEpicContinueCaution,
  teamEpicContinueLabel,
  teamEpicPersonalNotice,
} from "@/components/chat/composer/team-epic-personal-line-model";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useEpicOwningTeamId } from "@/hooks/epics/use-epic-owning-team";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  teamContinueCautionSeen,
  useTeamContinueCautionSeenStore,
} from "@/stores/chats/team-continue-caution-seen-store";

/**
 * Above a chat's composer in a team's task, when the chat runs on a host no
 * team owns: "Running on your Personal settings." with "Continue on a <team>
 * host", which opens the fork dialog on that team's hosts only. The first use
 * per person per team asks first.
 */
export function TeamEpicPersonalLine(props: {
  readonly epicId: string;
  readonly tabHostId: string;
  readonly onContinue: (teamHostIds: ReadonlySet<string>) => void;
}): ReactNode {
  const epicTeamId = useEpicOwningTeamId(props.epicId);
  const tabHostTeamId = useHostOwnerTeamId(props.tabHostId);
  const teams = useAuthStore((s) => s.shareableTeams);
  const notice = teamEpicPersonalNotice({ epicTeamId, tabHostTeamId, teams });
  if (notice === null) return null;
  return (
    <TeamEpicPersonalLineBody
      teamId={notice.teamId}
      slug={notice.slug}
      onContinue={props.onContinue}
    />
  );
}

function TeamEpicPersonalLineBody(props: {
  readonly teamId: string;
  readonly slug: string;
  readonly onContinue: (teamHostIds: ReadonlySet<string>) => void;
}): ReactNode {
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? "");
  const seen = useTeamContinueCautionSeenStore((s) => s.seen);
  const markSeen = useTeamContinueCautionSeenStore((s) => s.markSeen);
  const registry = useRegisteredHosts().data ?? null;
  const [cautionOpen, setCautionOpen] = useState(false);
  const teamHostIds = useMemo(
    () =>
      new Set(
        (registry?.hosts ?? [])
          .filter(
            (host) =>
              host.owner?.kind === "team" && host.owner.id === props.teamId,
          )
          .map((host) => host.hostId),
      ),
    [props.teamId, registry],
  );
  const label = teamEpicContinueLabel(props.slug);
  return (
    <div
      className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-sm text-foreground"
      data-testid="team-epic-personal-line"
    >
      <span className="min-w-0">{TEAM_EPIC_PERSONAL_LINE}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="team-epic-continue"
        disabled={teamHostIds.size === 0}
        onClick={() => {
          if (teamContinueCautionSeen(seen, viewerUserId, props.teamId)) {
            props.onContinue(teamHostIds);
            return;
          }
          setCautionOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog open={cautionOpen} onOpenChange={setCautionOpen}>
        <DialogContent
          className="w-[min(92vw,28rem)] sm:max-w-[min(92vw,28rem)]"
          data-testid="team-epic-caution"
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {teamEpicContinueCaution(props.slug)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              data-testid="team-epic-caution-cancel"
              onClick={() => setCautionOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="team-epic-caution-confirm"
              onClick={() => {
                markSeen(viewerUserId, props.teamId);
                setCautionOpen(false);
                props.onContinue(teamHostIds);
              }}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
