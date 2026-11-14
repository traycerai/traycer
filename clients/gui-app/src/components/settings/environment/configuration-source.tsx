import { createContext, useContext } from "react";
import {
  grantedEnvironmentRole,
  type EnvironmentDescriptorV11,
  type GrantedEnvironmentRole,
} from "@traycer/protocol/host/environment/contracts";

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
      /** `null` for a role that authorizes nothing - an older inventory's
       *  unknown role, or a retired one. */
      readonly effectiveRole: GrantedEnvironmentRole | null;
      /** The serving computer can read configuration without changing it. */
      readonly transportReadOnly?: boolean;
    };

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

export function useCanEditConfiguration(): boolean {
  const source = useConfigurationSource();
  return (
    source.kind === "host" ||
    (!source.transportReadOnly && source.effectiveRole !== null)
  );
}

/** An older inventory cannot authorize edits to a team, and answers `null`. */
export function configurationRoleOf(
  descriptor: EnvironmentDescriptorV11,
): GrantedEnvironmentRole | null {
  if (descriptor.ownerKind === "user") return "owner";
  const role = grantedEnvironmentRole(descriptor.effectiveRole);
  return role === "admin" || role === "editor" ? role : null;
}
