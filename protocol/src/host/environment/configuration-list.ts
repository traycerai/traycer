import type {
  EnvironmentDescriptor,
  EnvironmentDescriptorV11,
} from "@traycer/protocol/host/environment/contracts";

/**
 * What the environment wire says about a seat whose role authorizes nothing:
 * a membership still stored on the retired role, or a team fact the reader
 * could not get at all.
 *
 * It spells that `viewer` because the released wire has no other word for it
 * and every reader down to the support floor already treats the value as
 * "shows the row, edits nothing". It is a STATEMENT ABOUT AUTHORITY, not a
 * role anyone holds: nothing grants it, and a reader that needs the
 * distinction reads the role as `null`.
 */
export const WIRE_ROLE_NO_AUTHORITY = "viewer" as const;

/** Fresh pool facts, read under the same caller that listed the configurations. */
export interface ConfigurationListFacts {
  hosts(
    environmentId: string,
  ): Promise<readonly { readonly purgePending: boolean }[]>;
  team(environment: EnvironmentDescriptor): Promise<{
    readonly providerHandle: string;
    /** `null` where the caller's seat on this team authorizes nothing. */
    readonly effectiveRole: "admin" | "editor" | null;
  }>;
  /**
   * One row's facts could not be read; the row lists anyway, degraded. The
   * caller logs it at the row.
   */
  rowFailed(
    environmentId: string,
    facts: "hosts" | "team",
    error: unknown,
  ): void;
}

/**
 * The configuration summary the app and the server pool each derive from
 * their own reads of the same facts.
 *
 * One row's refused facts never fail the list: a row whose hosts are unread
 * counts none, and a team whose role could not be READ lists with no
 * authority (no edit control) and no provider handle, because a transient
 * failure must not look like a lost environment.
 *
 * A team whose role was read and authorizes NOTHING - a seat still stored on
 * the retired view-only role - is a different answer and is left out of the
 * list entirely. Listing it would name an environment the caller cannot read
 * or write anything in, which is the distinction the two cases turn on: one
 * is "not known yet", the other is "not theirs".
 */
export function enrichConfigurationList(
  environments: readonly EnvironmentDescriptor[],
  facts: ConfigurationListFacts,
): Promise<EnvironmentDescriptorV11[]> {
  return Promise.all(
    environments.map(async (environment) => {
      let hostCount = 0;
      try {
        const hosts = await facts.hosts(environment.environmentId);
        hostCount = hosts.filter((host) => !host.purgePending).length;
      } catch (error) {
        facts.rowFailed(environment.environmentId, "hosts", error);
      }
      if (environment.ownerKind === "user") {
        return {
          ...environment,
          kind: "personal" as const,
          effectiveRole: "owner" as const,
          hostCount,
          providerHandle: null,
        };
      }
      let team: {
        readonly providerHandle: string | null;
        readonly effectiveRole: "admin" | "editor" | null;
      };
      let roleRead = true;
      try {
        team = await facts.team(environment);
      } catch (error) {
        facts.rowFailed(environment.environmentId, "team", error);
        roleRead = false;
        team = { providerHandle: null, effectiveRole: null };
      }
      if (roleRead && team.effectiveRole === null) return null;
      return {
        ...environment,
        ...team,
        effectiveRole: team.effectiveRole ?? WIRE_ROLE_NO_AUTHORITY,
        kind: "team" as const,
        hostCount,
      };
    }),
  ).then((rows) => rows.flatMap((row) => (row === null ? [] : [row])));
}
