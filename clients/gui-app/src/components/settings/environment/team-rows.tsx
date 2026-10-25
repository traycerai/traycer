import type { ReactNode } from "react";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { environmentPickValue } from "@/lib/settings-environment-pages";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EnvironmentPickerRow } from "./environment-picker-row";
import { configurationRoleOf } from "./configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient } from "@/lib/host";

/** Team rows share the picker's configuration radio group. */
export interface TeamRowsProps {
  readonly pick: EnvironmentPick;
  readonly onPick: (pick: EnvironmentPick) => void;
}

export function TeamRows(props: TeamRowsProps): ReactNode {
  const query = useEnvironmentListQuery(useHostClient(), true);
  const teams =
    query.data?.environments.filter(
      (entry) => entry.ownerKind === "organization",
    ) ?? [];
  if (teams.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {teams.map((team) => {
        const pick: EnvironmentPick = {
          kind: "team",
          environmentId: team.environmentId,
        };
        return (
          <EnvironmentPickerRow
            key={team.environmentId}
            value={environmentPickValue(pick)}
            label={team.label}
            badge={null}
            badgeTooltip={null}
            subtitle={
              configurationRoleOf(team) === "viewer"
                ? "team · read-only"
                : "team · you edit"
            }
            nested={false}
            disabled={false}
            testId={`environment-team-${team.environmentId}`}
            onSelect={() => props.onPick(pick)}
            verb={null}
          />
        );
      })}
    </>
  );
}
