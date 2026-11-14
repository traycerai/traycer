import {
  useEnvironmentMembersList,
  type EnvironmentMembersListResult,
} from "@/hooks/environment/use-environment-members-list";
import { useHostClient } from "@/lib/host";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";

/**
 * The team's Admins and Editors by name, offered only after the complete
 * roster has answered. Roles are named, so a role added later is left out.
 */
export function canChangeNames(
  result: EnvironmentMembersListResult,
): readonly string[] {
  if (result.isPending || result.isError) return [];
  return result.members.flatMap((member) =>
    (member.effectiveRole === "admin" || member.effectiveRole === "editor") &&
    member.inviteState !== "pending" &&
    member.displayName !== null
      ? [member.displayName]
      : [],
  );
}

/** Who can change `what`, by name, or by role when no names are loaded. */
export function canChangeSentence(
  names: readonly string[],
  what: string,
): string {
  return names.length === 0
    ? `Editors and admins can change ${what}.`
    : `${names.join(", ")} can change ${what}.`;
}

/** The names that can change the configuration the settings page shows. */
export function useConfigurationCanChangeNames(): readonly string[] {
  const source = useConfigurationSource();
  return canChangeNames(
    useEnvironmentMembersList(
      useHostClient(),
      source.kind === "pool" ? source.environmentId : null,
      source.kind === "pool",
    ),
  );
}
