import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
export type ConfigurationWriteIssue =
  | { readonly kind: "conflict"; readonly changedBy: string | null }
  | { readonly kind: "forbidden" }
  | { readonly kind: "refused"; readonly line: string }
  | null;

export function configurationWriteIssue(
  result: EnvironmentConfigurationItemWriteResponse,
): ConfigurationWriteIssue {
  if (result.outcome === "conflict")
    return { kind: "conflict", changedBy: result.current?.changedBy ?? null };
  return result.outcome === "forbidden" ? { kind: "forbidden" } : null;
}

/**
 * A typed write answer as the page's issue, for writes whose answers are
 * outcomes rather than an item write's. A refusal is an answer, not an error,
 * so without this a write that did not land would say nothing: `stale` and
 * `conflict` lost a compare-and-set, and `not_served` or `refused` did not
 * land, said by `failedLine`.
 */
export function typedWriteIssue(
  result: {
    readonly outcome:
      | "saved"
      | "removed"
      | "set"
      | "reset"
      | "stale"
      | "conflict"
      | "not_served"
      | "forbidden"
      | "refused";
  },
  failedLine: string,
): ConfigurationWriteIssue {
  switch (result.outcome) {
    case "saved":
    case "removed":
    case "set":
    case "reset":
      return null;
    case "stale":
    case "conflict":
      return { kind: "conflict", changedBy: null };
    case "forbidden":
      return { kind: "forbidden" };
    case "not_served":
    case "refused":
      return { kind: "refused", line: failedLine };
  }
}
