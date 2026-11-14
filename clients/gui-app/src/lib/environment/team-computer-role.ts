import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";

/**
 * Whether the person's role on `team` lets them change a team computer:
 * give one to the team, or turn its Remote access on or off. A team role is
 * Admin, Editor, Viewer or not known, and each is named here: Admin and
 * Editor may, a Viewer may not, and a role this app does not know may not.
 */
export function mayChangeTeamComputer(team: EnvironmentDescriptorV11): boolean {
  switch (team.effectiveRole) {
    case "admin":
    case "editor":
      return true;
    case "viewer":
      return false;
    default:
      return false;
  }
}
