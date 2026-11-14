/**
 * The environment list as the app reads it itself: traycer-server's directory
 * (the rows the shell's `listEnvironments` answers) joined with authn's reads
 * on the person's sign-in, by the protocol's one combining function
 * (`enrichConfigurationList`), as the host's `environment.list` joined them.
 *
 * Each authn read is parsed for the one field the join reads, and nothing
 * else: a host's `purgePending`, and the viewer's effective role.
 */
import { z } from "zod";
import {
  enrichConfigurationList,
  type ConfigurationListFacts,
} from "@traycer/protocol/host/environment/configuration-list";
import type {
  EnvironmentDescriptor,
  EnvironmentDescriptorV11,
} from "@traycer/protocol/host/environment/contracts";
import {
  EnvironmentCloudError,
  environmentPath,
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

const hostReportsSchema = z.object({
  hosts: z.array(z.object({ purgePending: z.boolean() })),
});

const viewerRoleSchema = z.object({
  viewer: z.object({
    effectiveRole: z.enum(["admin", "editor"]).nullable(),
  }),
});

/** A team the signed-in person belongs to, as their account names it. */
export interface EnvironmentListTeam {
  readonly id: string;
  readonly slug: string;
}

export function readEnvironmentList(
  cloud: EnvironmentCloud,
  directory: readonly EnvironmentDescriptor[],
  teams: readonly EnvironmentListTeam[],
  rowFailed: ConfigurationListFacts["rowFailed"],
): Promise<EnvironmentDescriptorV11[]> {
  return enrichConfigurationList(directory, {
    hosts: async (environmentId) =>
      parseSettings(
        await sendSettings(
          cloud,
          "GET",
          `${environmentPath(environmentId)}/hosts`,
          null,
        ),
        hostReportsSchema,
      ).hosts,
    team: async (environment) => {
      // Organization routes name a team by its slug, from the person's own
      // account, never by the environment's id or its label.
      const team = teams.find((row) => row.id === environment.ownerId);
      if (team === undefined) {
        throw new EnvironmentCloudError("invalid", "This team is unavailable.");
      }
      const page = parseSettings(
        await sendSettings(
          cloud,
          "GET",
          `${environmentPath(environment.environmentId)}/members`,
          null,
        ),
        viewerRoleSchema,
      );
      return {
        providerHandle: team.slug,
        effectiveRole: page.viewer.effectiveRole,
      };
    },
    rowFailed,
  });
}
