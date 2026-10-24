import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
export type ConfigurationWriteIssue =
  | { readonly kind: "conflict"; readonly changedBy: string | null }
  | { readonly kind: "forbidden" }
  | null;

export function configurationWriteIssue(
  result: EnvironmentConfigurationItemWriteResponse,
): ConfigurationWriteIssue {
  if (result.outcome === "conflict")
    return { kind: "conflict", changedBy: result.current?.changedBy ?? null };
  return result.outcome === "forbidden" ? { kind: "forbidden" } : null;
}
