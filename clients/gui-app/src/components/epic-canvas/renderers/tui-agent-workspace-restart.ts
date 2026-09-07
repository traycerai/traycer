import type { TuiAgentProjectionOrigin } from "@/stores/epics/open-epic/types";

/**
 * The host refuses the rebind itself with `TARGET_NOT_LOCAL`, but the kill is dispatched from the client first and lands before that refusal is seen.
 * `null` - the projection has not landed yet - permits: a tile with no agent has no binding to commit, and the toolbar a commit would come from is not mounted. ## Why its own module The tile does not render a workspace affordance for a replica at all, so no rendered gesture can drive this path - which means a test cannot reach the guard through the component, and driving it would mean re-adding the very affordance the fix removes.
 */
export function mayRestartAfterWorkspaceBindingChange(
  origin: TuiAgentProjectionOrigin | null,
): boolean {
  return origin !== "cloud";
}
