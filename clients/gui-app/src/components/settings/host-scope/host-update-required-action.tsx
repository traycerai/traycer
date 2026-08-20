import type { ReactNode } from "react";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { Button } from "@/components/ui/button";
import { getClientAppVersion } from "@/lib/app-version";
import { hostUpdateActionApplies } from "@/lib/host/window-narration";

/**
 * The remedy for a host whose version this app cannot talk to: an update, not
 * a retry and not a wait.
 *
 * It sits in its own file for the reason its sibling
 * `plan-restricted-upgrade-action.tsx` states about itself — more than one
 * surface has to offer it, and a second copy of the button is how the two
 * would drift. The window modal has offered it since P3.1
 * (`window-host-modal-update-host`); Settings' hosts list is the second
 * surface, added here because a person who opens Settings to look at a host
 * the modal told them to update should not find a row that names the problem
 * and withholds the fix.
 *
 * WHEN IT IS WITHHELD, and why that is not a gap:
 *
 *   - **the app is the outdated leg.** Updating the host cannot fix a client
 *     that is itself behind, so the action would be a button that can only
 *     fail — the F8 "Retry now" class this epic deleted. `hostUpdateActionApplies`
 *     is the canonical rule and is CALLED rather than restated, so this surface
 *     and the modal cannot disagree about it.
 *   - **the app does not manage this machine.** Force-provisioning is the
 *     bundled host's lifecycle on THIS computer; there is no action this app
 *     can take against an incompatible host on someone else's desk. The row
 *     still says `update required` — naming a problem you cannot fix from here
 *     is honest, offering a control that cannot reach it is not.
 *
 * Both gates mirror the modal's own `resolveUpdateHost`. The structured skew
 * (host version, minimum supported, reason code) stays out of the row and out
 * of `health.detail`: it belongs to the report the modal pre-fills, where
 * there is room for it to be useful.
 */
export function HostUpdateRequiredAction(props: {
  /** The incompatibility, as the lease carried it. */
  readonly detail: SelectionIncompatibility;
  /**
   * Whether this app manages the machine — i.e. whether the local host
   * lifecycle can act on it at all. The caller resolves this; it is the same
   * `canManageHost` fact the readiness presentation carries.
   */
  readonly canManageHost: boolean;
  /** Runs the update. The caller supplies the lane; this owns no mutation. */
  readonly onUpdateHost: () => void;
  readonly pending: boolean;
}): ReactNode {
  if (!props.canManageHost) return null;
  if (!hostUpdateActionApplies(props.detail, getClientAppVersion()))
    return null;
  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      disabled={props.pending}
      onClick={props.onUpdateHost}
      data-testid="host-scope-update-host"
    >
      Update host
    </Button>
  );
}
