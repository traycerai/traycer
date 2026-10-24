import { createContext, useContext } from "react";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";

export type ConfigurationSource =
  | { readonly kind: "host" }
  | {
      readonly kind: "pool";
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

/** Null retains the existing host-bound secret RPC contract. */
export function useConfigurationEnvironmentId(): string | null {
  const source = useConfigurationSource();
  return source.kind === "pool" ? source.environmentId : null;
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
