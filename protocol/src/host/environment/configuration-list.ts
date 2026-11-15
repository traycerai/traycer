import type {
  EnvironmentDescriptor,
  EnvironmentDescriptorV11,
} from "@traycer/protocol/host/environment/contracts";

/** Fresh pool facts, read under the same caller that listed the configurations. */
export interface ConfigurationListFacts {
  hosts(
    environmentId: string,
  ): Promise<readonly { readonly purgePending: boolean }[]>;
  team(environment: EnvironmentDescriptor): Promise<{
    readonly providerHandle: string;
    readonly effectiveRole: "admin" | "editor" | "viewer";
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
 * their own reads of the same facts. One row's refused facts never fail the
 * list: a row whose hosts are unread counts none, and a team whose role is
 * unread lists as a viewer (no edit control) with no provider handle.
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
        readonly effectiveRole: "admin" | "editor" | "viewer";
      };
      try {
        team = await facts.team(environment);
      } catch (error) {
        facts.rowFailed(environment.environmentId, "team", error);
        team = { providerHandle: null, effectiveRole: "viewer" };
      }
      return { ...environment, ...team, kind: "team" as const, hostCount };
    }),
  );
}
