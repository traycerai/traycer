import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { ENVIRONMENT_SKILL_READ_ONLY_REASON } from "@traycer/protocol/host/environment/configuration-contracts";
import { readOnlyUploadRefusal } from "@/components/settings/environment/mcp-skills-copy";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useConfigurationReadClient } from "@/hooks/environment/team/use-configuration-read-client";
import { useConfigurationSkillsUploadMutation } from "@/hooks/environment/team/use-skills-upload-mutation";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { skillArchiveBase64 } from "./provider-skill-archive";
import type { ServedSkillEnvironment } from "./provider-skill-composer-model";

const WRITE_FAILED = "Couldn't add this skill.";

interface SkillEnvironmentRoute {
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
  const bindingUsable = hostRunsEnvironments === true && bindingReadable;
  const binding = useEnvironmentHostReadQuery(
    hostClient,
    hostId,
    bindingUsable,
  );
  // A disabled read still answers from the cache, which the host picker primes
  // for a host this client has not negotiated with.
  const environment = bindingUsable ? binding.data?.environment : undefined;
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
  // Read once per write, fresh: an upload over a name replaces that skill for
  // everyone the environment reaches, and a create must not.
  const listed = useHostQuery<
    HostRpcRegistry,
    "environment.configuration.skills.list"
  >({
    cacheKeyIdentity: [useCloudChatViewerId()],
    client: useConfigurationReadClient(),
    method: "environment.configuration.skills.list",
    params: { environmentId: served?.environmentId ?? "" },
    preflight: cloudVerdictPreflight("environment.configuration.skills.list"),
    options: { enabled: false },
  });
  return {
    hostRunsEnvironments,
    served,
    hostClient,
    writing: upload.isPending,
    write: async (skill) => {
      if (served === null) return WRITE_FAILED;
      const notServed = `This host isn't running ${served.name} yet, so it can't add the skill. Open ${served.name}'s Skills page and pick a host that runs it.`;
      try {
        const current = await listed.refetch({ throwOnError: true });
        if (current.data?.outcome !== "listed") return notServed;
        if (current.data.skills.some((row) => row.name === skill.name)) {
          return `A skill named "${skill.name}" already exists in ${served.name}.`;
        }
        const result = await upload.mutateAsync({
          environmentId: served.environmentId,
          name: skill.name,
          archive: await skillArchiveBase64(skill.markdown),
        });
        if (result.outcome === "saved") return null;
        if (result.outcome === "not_served") return notServed;
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
