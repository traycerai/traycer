import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Which host the workspace controls resolve against, and what a click on a
 * host row MEANS.
 *
 * - `active`: the app-wide active host, and picking a row rebinds it for the
 *   whole window (`directory.selectById`). The landing composer and the
 *   worktree pickers, where that global rebind IS the intent.
 * - `fixed`: pinned to one host, rows inert. The terminal-agent fork dialog and
 *   the pinned new-conversation modal, neither of which can move.
 * - `selected`: the caller owns the choice in its OWN state — picking a row
 *   calls `onSelect` and nothing else. The chat fork dialog, where the picked
 *   host is where the fork lands and rebinding the window to it was the whole
 *   reported bug: the fork went to the tab's host while the app-wide switch
 *   re-keyed the record stream to the picked one, so the create's invalidation
 *   had no observer and the new chat took 30-60s to appear.
 */
export type HostWorkspaceControlsHostScope =
  | { readonly kind: "active" }
  | {
      readonly kind: "fixed";
      readonly hostId: string;
      readonly hostClient: HostClient<HostRpcRegistry> | null;
    }
  | {
      readonly kind: "selected";
      readonly hostId: string;
      readonly hostClient: HostClient<HostRpcRegistry> | null;
      /**
       * Records the pick in the CALLER's state. It must never reach the host
       * directory: a dialog-local target is not an app-wide binding.
       */
      readonly onSelect: (hostId: string) => void;
      /**
       * Per-host reasons this surface cannot use a host (`hostId` -> the one
       * word the row shows). `NO_HOST_OPTION_REFUSALS` when it has none.
       */
      readonly refusalByHostId: ReadonlyMap<string, string>;
      /**
       * Marks every row EXCEPT this one unselectable, with no word on any of
       * them — for a blocker that belongs to the surface rather than to any
       * host, and that the surface explains once in its own copy.
       *
       * Distinct from `refusalByHostId` on purpose. That map answers "what is
       * wrong with THIS host"; this answers "the thing you are trying to do
       * cannot go anywhere but here", which is not a property of the rows and
       * must not be written onto them — a per-row word would invite the user to
       * try a different machine when no machine can help. `null` imposes
       * nothing.
       */
      readonly unselectableExceptHostId: string | null;
    };

export const ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE: HostWorkspaceControlsHostScope =
  {
    kind: "active",
  };

export function buildFixedHostWorkspaceControlsScope(input: {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}): HostWorkspaceControlsHostScope {
  if (input.hostId === null) return ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE;
  return {
    kind: "fixed",
    hostId: input.hostId,
    hostClient: input.hostClient,
  };
}

/**
 * The host a scope resolves to, or `null` for `active` (which follows whatever
 * the directory currently says). Both non-`active` scopes name their host
 * outright, so a caller that only needs the id does not have to re-discriminate.
 */
export function hostWorkspaceControlsScopeHostId(
  scope: HostWorkspaceControlsHostScope,
): string | null {
  return scope.kind === "active" ? null : scope.hostId;
}

/**
 * The refusals a scope carries. Only `selected` can hold any — `active` and
 * `fixed` have no per-row question of their own to ask.
 */
export function hostWorkspaceControlsScopeRefusals(
  scope: HostWorkspaceControlsHostScope,
): ReadonlyMap<string, string> {
  return scope.kind === "selected"
    ? scope.refusalByHostId
    : NO_HOST_OPTION_REFUSALS;
}
