
import type { HostServiceSubstrate } from "./host-owner";

export type DesktopUpdateExecutorCohortVerdict =
  | { readonly kind: "shadow"; readonly reason: "disabled" }
  | {
      readonly kind: "eligible";
      /** `raw-fallback` belongs to the CLI executor and `unknown` is fail-closed, so neither is representable here - the caller must have resolved a concrete owner before it can even ask. */
      readonly substrate: Extract<HostServiceSubstrate, "smappservice">;
    };

export function decideDesktopUpdateExecutorCohort(
  _substrate: HostServiceSubstrate,
): DesktopUpdateExecutorCohortVerdict {
  return { kind: "shadow", reason: "disabled" };
}
