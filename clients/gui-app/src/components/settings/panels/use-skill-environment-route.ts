import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { ENVIRONMENT_SKILL_READ_ONLY_REASON } from "@traycer/protocol/host/environment/configuration-contracts";
import { readOnlyUploadRefusal } from "@/components/settings/environment/mcp-skills-copy";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useConfigurationSkillsUploadMutation } from "@/hooks/environment/team/use-skills-upload-mutation";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { skillArchiveBase64 } from "./provider-skill-archive";

const WRITE_FAILED = "Couldn't add this skill to the environment.";
const NOT_SERVED =
  "This host isn't running the environment yet, so it can't add the skill. Open the environment's Skills page and pick a host that runs it.";

export interface SkillEnvironmentRoute {
  /**
   * The host answers `environment.status`, which a build without environments
   * never does. Such a host only reads the shared folder; one without it still
   * writes there, and has no environment to offer.
   */
  readonly hostRunsEnvironments: boolean;
  /** The person's environment is known, so the composer can write to it. */
  readonly available: boolean;
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly writing: boolean;
  /** A written skill into the environment: the refusal to show, or `null`. */
  readonly write: (skill: {
    readonly name: string;
    readonly markdown: string;
  }) => Promise<string | null>;
}

/** How a provider's Skills tab reaches the person's environment. */
export function useSkillEnvironmentRoute(): SkillEnvironmentRoute {
  const hostClient = useHostClient();
  const status = useHostNegotiatedMethodVersion(
    hostClient,
    "environment.status",
  );
  const hostRunsEnvironments = status !== null && status !== false;
  const environments = useEnvironmentListQuery(
    hostClient,
    hostRunsEnvironments,
  );
  const environmentId =
    environments.data?.environments.find(
      (environment) => environment.ownerKind === "user",
    )?.environmentId ?? null;
  const upload = useConfigurationSkillsUploadMutation();
  return {
    hostRunsEnvironments,
    available: environmentId !== null,
    hostClient,
    writing: upload.isPending,
    write: async (skill) => {
      if (environmentId === null) return WRITE_FAILED;
      try {
        const result = await upload.mutateAsync({
          environmentId,
          name: skill.name,
          archive: await skillArchiveBase64(skill.markdown),
        });
        if (result.outcome === "saved") return null;
        if (result.outcome === "not_served") return NOT_SERVED;
        return result.reason === ENVIRONMENT_SKILL_READ_ONLY_REASON
          ? readOnlyUploadRefusal(skill.name)
          : WRITE_FAILED;
      } catch {
        return WRITE_FAILED;
      }
    },
  };
}
