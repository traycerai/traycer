import { useEnvironmentMembersList } from "@/hooks/environment/use-environment-members-list";
import { useHostClient } from "@/lib/host";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";

/** Names are offered only after the complete roster has answered. */
export function useConfigurationAdminNames() {
  const source = useConfigurationSource();
  const result = useEnvironmentMembersList(
    useHostClient(),
    source.kind === "pool" ? source.environmentId : null,
    source.kind === "pool",
  );
  return {
    ...result,
    adminNames:
      result.isPending || result.isError
        ? []
        : result.members.flatMap((member) =>
            member.effectiveRole === "admin" &&
            member.inviteState !== "pending" &&
            member.displayName !== null
              ? [member.displayName]
              : [],
          ),
  };
}
