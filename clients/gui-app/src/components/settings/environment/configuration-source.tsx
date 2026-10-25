import { createContext, useContext } from "react";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";

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
      readonly effectiveRole: "owner" | "admin" | "editor" | "viewer";
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
  return source.kind === "host" || source.effectiveRole !== "viewer";
}

export function useCanAdministerConfiguration(): boolean {
  const source = useConfigurationSource();
  return (
    source.kind === "host" ||
    source.effectiveRole === "owner" ||
    source.effectiveRole === "admin"
  );
}

/** An older inventory cannot authorize edits to a team. */
export function configurationRoleOf(
  descriptor: EnvironmentDescriptorV11,
): "owner" | "admin" | "editor" | "viewer" {
  if (descriptor.ownerKind === "user") return "owner";
  const role = descriptor.effectiveRole;
  return role === "admin" || role === "editor" ? role : "viewer";
}
