import { useEffect, useMemo, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  environmentPickerModel,
  isStaleLocalPick,
  type EnvironmentPickerModel,
  type LocalPickerRow,
} from "@/components/settings/environment/environment-picker-model";
import { EnvironmentPickerRow } from "@/components/settings/environment/environment-picker-row";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { TeamRows } from "@/components/settings/environment/team-rows";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRegisteredHostEnvironmentStatuses } from "@/hooks/environment/use-registered-host-environment-statuses";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import {
  environmentPickValue,
  environmentSectionShown,
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
 * The model the Environment dropdown draws, from every registered computer's
 * `environment.status`. Also keeps the window's default pick current and
 * drops a Local pick whose computer has since moved: the store is what every
 * Environment page reads (`useEnvironmentPick`), and this is the one place
 * that knows each computer's state.
 */
function useEnvironmentPickerModel(scope: HostScope): EnvironmentPickerModel {
  // Computers only: a sandbox is created on a configuration's settings and
  // never has settings of its own to move.
  const hosts = useMemo(
    () =>
      scope.hosts.filter((host) => host.registered && host.sandbox === null),
    [scope.hosts],
  );
  const hostIds = useMemo(() => hosts.map((host) => host.hostId), [hosts]);
  const statuses = useRegisteredHostEnvironmentStatuses(hosts);
  const versions = useHostNegotiatedMethodVersions(
    hostIds,
    "environment.status",
  );
  const model = useMemo(
    () =>
      environmentPickerModel({
        hosts,
        statuses,
        versions,
        windowHostId: scope.activeHostId,
      }),
    [hosts, statuses, versions, scope.activeHostId],
  );
  const pick = useSettingsEnvironmentPickStore((state) => state.pick);
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  const setDefaultPick = useSettingsEnvironmentPickStore(
    (state) => state.setDefaultPick,
  );
  const stale = isStaleLocalPick(pick, model, statuses);
  const { defaultPick } = model;
  // Syncs host-reported state into the window's pick: the store is read by
  // pages that do not mount this hook.
  useEffect(() => {
    setDefaultPick(defaultPick);
  }, [defaultPick, setDefaultPick]);
  useEffect(() => {
    if (stale) setPick(null);
  }, [stale, setPick]);
  return model;
}

/**
 * Settings ▸ Environment's dropdown, at the head of the group: Personal, a
 * Local row under it for each computer whose own settings have not moved,
 * and the team rows (P1's slot). The pick decides what every page below it
 * shows; it never changes which host this window works on.
 */
export function EnvironmentPicker(props: {
  readonly scope: HostScope;
  /** The section on screen, so a pick that hides it can leave it. */
  readonly activeSection: SettingsSectionId | null;
}): ReactNode {
  const model = useEnvironmentPickerModel(props.scope);
  const pick = useSettingsEnvironmentPickStore(
    (state) => state.pick ?? state.defaultPick,
  );
  const setPick = useSettingsEnvironmentPickStore((state) => state.setPick);
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  const setScopedHostId = useSettingsHostScopeStore(
    (state) => state.setScopedHostId,
  );
  const choose = (next: EnvironmentPick): void => {
    setPick(next);
    if (
      props.activeSection !== null &&
      !environmentSectionShown(next, props.activeSection)
    ) {
      navigateToSettingsSection("providers");
    }
  };
  const finishMoving = (hostId: string): void => {
    setScopedHostId(hostId);
    navigateToSettingsSection("host");
  };
  return (
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
            subtitle={model.personalSubtitle}
            nested={false}
            disabled={false}
            testId="environment-picker-personal"
            onSelect={() => choose(PERSONAL_PICK)}
            verb={null}
          />
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
              verb={localRowVerb(row, openMoveSheet, finishMoving)}
            />
          ))}
          <TeamRows pick={pick} onPick={choose} />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
      label: "finish moving",
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
    label = teamLabel ?? <AgentSpinningDotsLabel />;
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
            <Badge variant="secondary" size="xs">
              Local
            </Badge>
          ) : null}
        </span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
  );
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
