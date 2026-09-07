import type { ReactNode } from "react";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { Button } from "@/components/ui/button";
import { getClientAppVersion } from "@/lib/app-version";
import { hostUpdateActionApplies } from "@/lib/host/window-narration";

/** When IT IS withheld, and why that is not a gap: - the app is the outdated leg. Updating the host cannot fix
 * a client that is itself behind, so the action would be a button that can only fail. */
export function HostUpdateRequiredAction(props: {
  readonly detail: SelectionIncompatibility;
  /** Whether this app manages the machine - i.e. whether the local host lifecycle can act on it at all. */
  readonly canManageHost: boolean;
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
