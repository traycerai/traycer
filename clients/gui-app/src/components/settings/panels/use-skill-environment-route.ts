import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { ENVIRONMENT_SKILL_READ_ONLY_REASON } from "@traycer/protocol/host/environment/configuration-contracts";
import { readOnlyUploadRefusal } from "@/components/settings/environment/mcp-skills-copy";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useConfigurationSkillsUploadMutation } from "@/hooks/environment/team/use-skills-upload-mutation";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { skillArchiveBase64 } from "./provider-skill-archive";
import type { ServedSkillEnvironment } from "./provider-skill-composer-model";

const WRITE_FAILED = "Couldn't add this skill to the environment.";
const NOT_SERVED =
  "This host isn't running the environment yet, so it can't add the skill. Open the environment's Skills page and pick a host that runs it.";

export interface SkillEnvironmentRoute {
  /**
   * The host answers `environment.status`, which a build without environments
   * never does. Such a host only reads the shared folder; one without it still
   * writes there, and has no environment to offer. `null` until its manifest
   * arrives, when neither is known: offer no shared-folder action and word no
   * refusal.
   */
  readonly hostRunsEnvironments: boolean | null;
  /** What this host serves, once known; the composer writes nowhere else. */
  readonly served: ServedSkillEnvironment | null;
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly writing: boolean;
  /** A written skill into the environment: the refusal to show, or `null`. */
  readonly write: (skill: {
    readonly name: string;
    readonly markdown: string;
  }) => Promise<string | null>;
}

/** How a provider's Skills tab reaches the environment this host serves. */
export function useSkillEnvironmentRoute(): SkillEnvironmentRoute {
  const hostClient = useHostClient();
  const status = useHostNegotiatedMethodVersion(
    hostClient,
    "environment.status",
  );
  const hostRunsEnvironments = status === null ? null : status !== false;
  const hostId = useRequesterHostId(hostClient);
  const bindingReadable =
    useHostMethodSupport(hostId, "environment.host.read") === true;
  const environment = useEnvironmentHostReadQuery(
    hostClient,
    hostId,
    hostRunsEnvironments === true && bindingReadable,
  ).data?.environment;
  const served: ServedSkillEnvironment | null =
    environment === undefined
      ? null
      : {
          environmentId: environment.environmentId,
          name:
            environment.ownerKind === "user" ? "Personal" : environment.label,
          team: environment.ownerKind !== "user",
        };
  const upload = useConfigurationSkillsUploadMutation();
  return {
    hostRunsEnvironments,
    served,
    hostClient,
    writing: upload.isPending,
    write: async (skill) => {
      if (served === null) return WRITE_FAILED;
      try {
        const result = await upload.mutateAsync({
          environmentId: served.environmentId,
          name: skill.name,
          archive: await skillArchiveBase64(skill.markdown),
        });
        if (result.outcome === "saved") return null;
        if (result.outcome === "not_served") return NOT_SERVED;
        if (result.outcome === "forbidden") {
          return `Only ${served.name}'s editors can add skills to it.`;
        }
        return result.reason === ENVIRONMENT_SKILL_READ_ONLY_REASON
          ? readOnlyUploadRefusal(skill.name)
          : WRITE_FAILED;
      } catch {
        return WRITE_FAILED;
      }
    },
  };
}
