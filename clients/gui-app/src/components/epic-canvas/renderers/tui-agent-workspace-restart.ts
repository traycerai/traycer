import type { TuiAgentProjectionOrigin } from "@/stores/epics/open-epic/types";

/**
 * Whether a committed workspace-binding change may restart a terminal agent's
 * PTY.
 *
 * `false` for a CLOUD REPLICA, and that is the whole rule. The restart is a
 * kill-and-recreate addressed by session id, but a replica's PTY is running on
 * its OWNER's machine - so committing a rebind from this client would kill
 * somebody else's terminal and then recreate it locally under the same id. The
 * host refuses the rebind itself with `TARGET_NOT_LOCAL`, but the kill is
 * dispatched from the client first and lands before that refusal is seen.
 *
 * `null` - the projection has not landed yet - permits: a tile with no agent
 * has no binding to commit, and the toolbar a commit would come from is not
 * mounted.
 *
 * ## Why its own module
 *
 * The tile does not render a workspace affordance for a replica at all, so no
 * rendered gesture can drive this path - which means a test cannot reach the
 * guard through the component, and driving it would mean re-adding the very
 * affordance the fix removes. Exporting the rule from the tile instead trips
 * `react(only-export-components)`: a non-component export there costs the file
 * its fast refresh. So the rule lives here, where a test reaches the real one
 * and the tile keeps a single component export.
 */
export function mayRestartAfterWorkspaceBindingChange(
  origin: TuiAgentProjectionOrigin | null,
): boolean {
  return origin !== "cloud";
}
