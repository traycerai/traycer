import { createContext, useContext } from "react";
import type {
  EnvironmentDescriptorV11,
  GrantedEnvironmentRole,
} from "@traycer/protocol/host/environment/contracts";

export type ConfigurationRole = GrantedEnvironmentRole | "viewer";

export type ConfigurationSource =
  | { readonly kind: "host" }
  | {
      /**
       * Read from the cloud, through the window's host on the viewer's
       * session: a team's configuration, or Personal's when the window's
       * host does not run it.
       */
      readonly kind: "pool";
      readonly configuration: "personal" | "team";
      readonly environmentId: string;
      readonly roomId: string;
      readonly providerHandle: string | null;
      /** Read through `mayChangeConfiguration`, never against `null`: a Viewer is not absent. */
      readonly effectiveRole: ConfigurationRole | null;
      readonly transportReadOnly?: boolean;
    };

/** Never changed while the window's host is a team's computer: Personal talks only to Personal. */
export function personalReadOnlyOnTeamComputer(
  configuration: "personal" | "team",
  windowHostIsTeamComputer: boolean,
): boolean {
  return configuration === "personal" && windowHostIsTeamComputer;
}

const HOST_SOURCE: ConfigurationSource = { kind: "host" };

/** A page's configuration; its live host facts use the viewing scope separately. */
export const ConfigurationSourceContext =
  createContext<ConfigurationSource>(HOST_SOURCE);

export function useConfigurationSource(): ConfigurationSource {
  return useContext(ConfigurationSourceContext);
}

/**
 * A team's id on its pages, else null. Only the provider link dialog's
 * team-or-Personal branch reads it; the calls themselves name their
 * environment through `useAddressedEnvironment`.
 */
export function useConfigurationEnvironmentId(): string | null {
  const source = useConfigurationSource();
  return source.kind === "pool" ? source.environmentId : null;
}

/** Whether the page reads Personal from the cloud, for its Personal wording. */
export function useConfigurationIsPersonal(): boolean {
  const source = useConfigurationSource();
  return source.kind === "pool" && source.configuration === "personal";
}

/** A role this app does not know changes nothing. */
export function mayChangeConfiguration(
  role: ConfigurationRole | null,
): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}

export function useCanEditConfiguration(): boolean {
  const source = useConfigurationSource();
  return (
    source.kind === "host" ||
    (!source.transportReadOnly && mayChangeConfiguration(source.effectiveRole))
  );
}

/** Team account edits use the person's session, independent of the serving computer. */
export function canManageTeamProviderAccounts(
  source: ConfigurationSource,
): boolean {
  return (
    source.kind === "pool" &&
    source.configuration === "team" &&
    (source.effectiveRole === "owner" ||
      source.effectiveRole === "admin" ||
      source.effectiveRole === "editor")
  );
}

export function configurationRoleOf(
  descriptor: EnvironmentDescriptorV11,
): ConfigurationRole | null {
  if (descriptor.ownerKind === "user") return "owner";
  switch (descriptor.effectiveRole) {
    case "admin":
      return "admin";
    case "editor":
      return "editor";
    case "viewer":
      return "viewer";
    default:
      return null;
  }
}
