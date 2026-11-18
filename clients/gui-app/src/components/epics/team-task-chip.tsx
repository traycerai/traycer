import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { teamTaskLabel } from "@/lib/epics/team-task-owner";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The chip naming the team that owns a task, on History rows and the
 * panel's task header. Named by the team's slug, or "A team".
 */
export function TeamTaskChip(props: { readonly teamId: string }): ReactNode {
  const teams = useAuthStore((s) => s.shareableTeams);
  return (
    <Badge
      variant="secondary"
      size="sm"
      className="h-4"
      data-testid="team-task-chip"
    >
      {teamTaskLabel(props.teamId, teams)}
    </Badge>
  );
}
