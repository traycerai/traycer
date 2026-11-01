import { useEffect, useState, type ReactNode } from "react";
import type { EnvironmentInvitation } from "@traycer/protocol/host/environment/contracts";
import { ChevronDown } from "lucide-react";
import {
  isStaleLocalPick,
  LOCAL_BADGE_TOOLTIP,
  personalSubtitle,
  type EnvironmentPickerModel,
  type LocalPickerRow,
} from "@/components/settings/environment/environment-picker-model";
import {
  collisionLine,
  type HostNameCollision,
  type HostsRunningConfiguration,
} from "@/components/settings/environment/hosts-running-configuration-model";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { EnvironmentPickerRow } from "@/components/settings/environment/environment-picker-row";
import {
  useInvitedTeamName,
  usePickedTeamLabel,
} from "@/components/settings/environment/team-pick-label";
import { TeamRows } from "@/components/settings/environment/team-rows";
import { useEnvironmentStatusModel } from "@/components/settings/environment/use-environment-status-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { InviteAcceptDialog } from "@/components/settings/members/invite-accept-dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  environmentPickValue,
  moveEnvironmentPick,
  moveEnvironmentSurface,
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  useMoveSheetStore,
  type MoveSheetTarget,
} from "@/stores/settings/move-sheet-store";

/**
 * The model the Environment dropdown draws, from each computer's
 * `environment.status` (`isEnvironmentComputer`). Also keeps the window's
 * default pick current and drops a Local pick whose computer has since moved:
 * the store is what every Environment page reads (`useEnvironmentPick`), and
 * this is the one place that knows each computer's state.
 */
function useEnvironmentPickerModel(scope: HostScope): EnvironmentPickerModel {
  const model = useEnvironmentStatusModel(scope);
  const pick = useSettingsEnvironmentPickStore((state) => state.pick);
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  const setDefaultPick = useSettingsEnvironmentPickStore(
    (state) => state.setDefaultPick,
  );
  const statuses = model.statuses;
  const stale = isStaleLocalPick(pick, model.picker, statuses);
  const { defaultPick } = model.picker;
  // Syncs host-reported state into the window's pick: the store is read by
  // pages that do not mount this hook.
  useEffect(() => {
    setDefaultPick(defaultPick);
  }, [defaultPick, setDefaultPick]);
  useEffect(() => {
    if (stale) setPick(null);
  }, [stale, setPick]);
  return model.picker;
}

/**
 * Settings ▸ Environment's dropdown, at the head of the group: Personal, a
 * Local row under it for each computer whose own settings have not moved,
 * and the team rows. The pick decides what every page below it
 * shows; it never changes which host this window works on.
 */
export function EnvironmentPicker(props: {
  readonly scope: HostScope;
  /** The section on screen, so a pick that hides it can leave it. */
  readonly activeSection: SettingsSectionId | null;
}): ReactNode {
  const model = useEnvironmentPickerModel(props.scope);
  const running = useHostsRunningPersonal(true);
  const pick = useSettingsEnvironmentPickStore(
    (state) => state.pick ?? state.defaultPick,
  );
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const setScopedHostId = useSettingsHostScopeStore(
    (state) => state.setScopedHostId,
  );
  const choose = (next: EnvironmentPick): void => {
    moveEnvironmentPick({
      next,
      activeSection: props.activeSection,
      setPick,
      // A person just pressed this row, so the surface follows the press.
      moveSurface: moveEnvironmentSurface.onGesture,
    });
  };
  // Finish moving and Rename both continue on that host's Overview.
  const openHostOverview = (hostId: string): void => {
    setScopedHostId(hostId);
    navigateToSettingsSection("host");
  };
  // Outside the menu, which unmounts its content as it closes on `Review`.
  const [reviewing, setReviewing] = useState<EnvironmentInvitation | null>(
    null,
  );
  return (
    <>
      <DropdownMenu>
        <EnvironmentPickerTrigger pick={pick} />
        <DropdownMenuContent
          align="start"
          className="w-[min(28rem,calc(100vw-2rem))]"
          data-testid="environment-picker-menu"
        >
          <DropdownMenuRadioGroup value={environmentPickValue(pick)}>
            <EnvironmentPickerRow
              value={environmentPickValue(PERSONAL_PICK)}
              label="Personal"
              badge={null}
              badgeTooltip={null}
              subtitle={personalRowSubtitle(running)}
              nested={false}
              disabled={false}
              testId="environment-picker-personal"
              onSelect={() => choose(PERSONAL_PICK)}
              verb={null}
            />
            {running.collisions.map((collision) => (
              <NameCollisionLine
                key={collision.hostName}
                collision={collision}
                thisComputerId={
                  running.hosts.find((host) => host.isThisComputer)?.hostId ??
                  null
                }
                onRename={openHostOverview}
              />
            ))}
            {model.localRows.map((row) => (
              <EnvironmentPickerRow
                key={row.hostId}
                value={environmentPickValue({
                  kind: "local",
                  hostId: row.hostId,
                  hostName: row.name,
                })}
                label={row.name}
                badge="Local"
                badgeTooltip={LOCAL_BADGE_TOOLTIP}
                subtitle={row.subtitle}
                nested
                disabled={row.needsUpdate}
                testId={`environment-picker-local-${row.hostId}`}
                onSelect={() =>
                  choose({
                    kind: "local",
                    hostId: row.hostId,
                    hostName: row.name,
                  })
                }
                verb={localRowVerb(row, openMoveSheet, openHostOverview)}
              />
            ))}
            <TeamRows pick={pick} onPick={choose} onReview={setReviewing} />
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <InviteAcceptDialog
        invitation={reviewing}
        onClose={() => setReviewing(null)}
        onAccepted={(environmentId) => {
          setReviewing(null);
          choose({ kind: "team", environmentId });
        }}
      />
    </>
  );
}

/**
 * Personal's line: the hosts running it, once their list has answered.
 * Before that, and when it cannot be read, it names no host and claims none.
 */
function personalRowSubtitle(running: HostsRunningConfiguration): string {
  if (running.state !== "ready") return "your settings";
  return personalSubtitle(running.hosts.map((host) => host.name));
}

/**
 * `Two computers are named <host> · Rename`, under Personal's row while two
 * running hosts share a name. Rename opens the Overview of this computer when
 * it is one of them, where its name is edited, else of the first.
 */
function NameCollisionLine(props: {
  readonly collision: HostNameCollision;
  readonly thisComputerId: string | null;
  readonly onRename: (hostId: string) => void;
}): ReactNode {
  const { collision } = props;
  const target =
    collision.hostIds.find((hostId) => hostId === props.thisComputerId) ??
    collision.hostIds.at(0);
  return (
    <DropdownMenuItem
      inset
      data-testid="environment-picker-name-collision"
      onSelect={() => {
        if (target !== undefined) props.onRename(target);
      }}
    >
      <span className="text-ui-xs text-muted-foreground">
        {collisionLine(collision)}
        <span aria-hidden> · </span>
        <span className="text-primary underline-offset-2 hover:underline">
          Rename
        </span>
      </span>
    </DropdownMenuItem>
  );
}

function localRowVerb(
  row: LocalPickerRow,
  openMoveSheet: (target: MoveSheetTarget) => void,
  finishMoving: (hostId: string) => void,
): { label: string; testId: string; onSelect: () => void } | null {
  if (row.verb === "move_to_personal") {
    return {
      label: "Move to Personal",
      testId: `environment-picker-move-${row.hostId}`,
      onSelect: () => openMoveSheet({ hostId: row.hostId, hostName: row.name }),
    };
  }
  if (row.verb === "finish_moving") {
    return {
      label: "Finish moving",
      testId: `environment-picker-finish-${row.hostId}`,
      onSelect: () => finishMoving(row.hostId),
    };
  }
  return null;
}

function EnvironmentPickerTrigger(props: {
  readonly pick: EnvironmentPick;
}): ReactNode {
  const { pick } = props;
  const teamLabel = usePickedTeamLabel(
    pick.kind === "team" ? pick.environmentId : "",
  );
  let label: ReactNode = "Personal";
  let local = false;
  if (pick.kind === "local") {
    label = pick.hostName;
    local = true;
  } else if (pick.kind === "team") {
    // A pick the membership list cannot name is either an invitation the
    // person has not accepted, or a read that has not landed. Only then is
    // the account-wide invitations read mounted, by the component below.
    label = teamLabel ?? (
      <InvitedTeamNameLabel environmentId={pick.environmentId} />
    );
  }
  return (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-between"
        data-testid="environment-picker-trigger"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{label}</span>
          {local ? (
            <TooltipWrapper
              label={LOCAL_BADGE_TOOLTIP}
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Badge variant="secondary" size="xs">
                Local
              </Badge>
            </TooltipWrapper>
          ) : null}
        </span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
  );
}

/**
 * The name of a team that has only invited the person, and the spinner until
 * that read lands. Its own component so the read it mounts belongs to the one
 * render that needs it.
 */
function InvitedTeamNameLabel(props: {
  readonly environmentId: string;
}): ReactNode {
  const invited = useInvitedTeamName(props.environmentId);
  return invited ?? <AgentSpinningDotsLabel />;
}

function AgentSpinningDotsLabel(): ReactNode {
  return (
    <AgentSpinningDots
      className={undefined}
      testId={undefined}
      variant={undefined}
      tone="muted"
    />
  );
}
