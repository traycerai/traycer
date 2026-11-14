import { createContext, useContext } from "react";
import {
  grantedEnvironmentRole,
  type EnvironmentDescriptorV11,
  type GrantedEnvironmentRole,
} from "@traycer/protocol/host/environment/contracts";

/** A role a configuration answers: one that may change it, or a Viewer's. */
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
      /** Read through `mayChangeConfiguration`, never by comparing with
       *  `null`: a role that changes nothing is not always absent. */
      readonly effectiveRole: ConfigurationRole | null;
      /** `personalReadOnlyOnTeamComputer`'s answer for this page. */
      readonly transportReadOnly?: boolean;
    };

/**
 * Personal is shown but never changed while the window's host is a team's
 * computer: Personal talks only to Personal. A team's own settings follow the
 * role authn answers, whichever computer the window is on.
 */
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

/**
 * Whether a role may change a configuration: Personal's owner, or a team's
 * Admin or Editor. A Viewer, and a role this app does not know, change
 * nothing.
 */
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

export function useCanAdministerConfiguration(): boolean {
  const source = useConfigurationSource();
  return (
    source.kind === "host" ||
    (!source.transportReadOnly &&
      (source.effectiveRole === "owner" || source.effectiveRole === "admin"))
  );
}

/**
 * A Viewer answers `viewer`; a role this app does not know, and an older
 * inventory's, answer `null`. Read it through `mayChangeConfiguration`.
 */
export function configurationRoleOf(
  descriptor: EnvironmentDescriptorV11,
): ConfigurationRole | null {
  if (descriptor.ownerKind === "user") return "owner";
  if (descriptor.effectiveRole === "viewer") return "viewer";
  const role = grantedEnvironmentRole(descriptor.effectiveRole);
  return role === "admin" || role === "editor" ? role : null;
}
