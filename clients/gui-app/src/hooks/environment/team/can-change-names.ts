import {
  useEnvironmentMembersList,
  type EnvironmentMembersListResult,
} from "@/hooks/environment/use-environment-members-list";
import {
  mayChangeConfiguration,
  useConfigurationSource,
} from "@/components/settings/environment/configuration-source";

/** Offered only after the complete roster has answered. */
export function canChangeNames(
  result: EnvironmentMembersListResult,
): readonly string[] {
  if (result.isPending || result.isError) return [];
  return result.members.flatMap((member) =>
    mayChangeConfiguration(member.effectiveRole) &&
    member.inviteState !== "pending" &&
    member.displayName !== null
      ? [member.displayName]
      : [],
  );
}

export function canChangeSentence(
  names: readonly string[],
  what: string,
): string {
  return names.length === 0
    ? `Editors and admins can change ${what}.`
    : `${names.join(", ")} can change ${what}.`;
}

export function useConfigurationCanChangeNames(): readonly string[] {
  const source = useConfigurationSource();
  return canChangeNames(
    useEnvironmentMembersList(
      source.kind === "pool" ? source.environmentId : null,
      source.kind === "pool",
    ),
  );
}
