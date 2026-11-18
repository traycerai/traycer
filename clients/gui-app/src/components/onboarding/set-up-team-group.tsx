import { useMemo, type ReactNode } from "react";
import { Users } from "lucide-react";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { cn } from "@/lib/utils";
import { useAuthStore, type EpicShareableTeam } from "@/stores/auth/auth-store";
import { useTeamHostDisclosureSeenStore } from "@/stores/hosts/team-host-disclosure-seen-store";
import { newcomerTeams, teamNewcomerLine } from "./set-up-team-model";

/**
 * The newcomer's line per team, beside the checklist on Home and Settings: for
 * each team the person has never opened a tab in, where to go to start working
 * there. Outside the checklist's fold on Home, so a finished checklist does
 * not hide it.
 */
export function SetUpTeamGroup(props: {
  readonly surface: "settings" | "home";
}): ReactNode {
  const teams = useAuthStore((s) => s.shareableTeams);
  // No team, no line: the host registry is read only for someone in one.
  if (teams.length === 0) return null;
  return <SetUpTeamLines surface={props.surface} teams={teams} />;
}

function SetUpTeamLines(props: {
  readonly surface: "settings" | "home";
  readonly teams: ReadonlyArray<EpicShareableTeam>;
}): ReactNode {
  const { teams } = props;
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? "");
  const registry = useRegisteredHosts().data ?? null;
  const seen = useTeamHostDisclosureSeenStore((s) => s.seen);
  const newcomers = useMemo(() => {
    const hostIdsByTeam = new Map<string, string[]>();
    const names = new Map<string, string>();
    for (const host of registry?.hosts ?? []) {
      if (host.owner?.kind !== "team") continue;
      const ids = hostIdsByTeam.get(host.owner.id) ?? [];
      ids.push(host.hostId);
      hostIdsByTeam.set(host.owner.id, ids);
      names.set(host.owner.id, host.owner.name);
    }
    return newcomerTeams({
      teams: teams.map((team) => ({
        teamId: team.teamId,
        name: names.get(team.teamId) ?? team.slug,
      })),
      hostIdsByTeam,
      seen,
      viewerUserId,
    });
  }, [registry, seen, teams, viewerUserId]);
  if (newcomers.length === 0) return null;
  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border/60",
        props.surface === "settings" ? "mt-4 p-5" : "mt-3 p-4",
      )}
      data-testid="set-up-team-group"
    >
      <ul className="flex flex-col gap-1.5">
        {newcomers.map((team) => (
          <li
            key={team.teamId}
            className="flex min-w-0 items-start gap-2 text-ui-sm text-foreground"
          >
            <Users
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0">{teamNewcomerLine(team.name)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
