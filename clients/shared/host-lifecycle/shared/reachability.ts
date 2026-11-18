// Endpoint reachability evidence (annex §1.6 / plan F10). Shared across
// platforms; never collapses probe failure into unreachable.

export type Reachability =
  | { readonly kind: "reachable" }
  | {
      readonly kind: "unreachable";
      readonly reason: "refused" | "timeout" | "handshake-failed";
    }
  | { readonly kind: "indeterminate"; readonly cause: "probe-error" };

export type ReachabilityProbeOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused" }
  | { readonly kind: "timeout" }
  | { readonly kind: "handshake-failed" }
  | { readonly kind: "probe-error" };

export function classifyReachability(
  outcome: ReachabilityProbeOutcome,
): Reachability {
  switch (outcome.kind) {
    case "ok":
      return { kind: "reachable" };
    case "refused":
      return { kind: "unreachable", reason: "refused" };
    case "timeout":
      return { kind: "unreachable", reason: "timeout" };
    case "handshake-failed":
      return { kind: "unreachable", reason: "handshake-failed" };
    case "probe-error":
      return { kind: "indeterminate", cause: "probe-error" };
  }
}
