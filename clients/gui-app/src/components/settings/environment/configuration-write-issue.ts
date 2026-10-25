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
 * A skill write's answer as the page's issue. A typed refusal is an answer,
 * not an error, so without this a switch or a removal that did not land would
 * say nothing: `stale` lost a compare-and-set, and `not_served` or `refused`
 * did not land, said by `failedLine`.
 */
export function skillWriteIssue(
  result: {
    readonly outcome:
      | "saved"
      | "removed"
      | "stale"
      | "not_served"
      | "forbidden"
      | "refused";
  },
  failedLine: string,
): ConfigurationWriteIssue {
  if (result.outcome === "saved" || result.outcome === "removed") return null;
  if (result.outcome === "stale") return { kind: "conflict", changedBy: null };
  if (result.outcome === "forbidden") return { kind: "forbidden" };
  return { kind: "refused", line: failedLine };
}
