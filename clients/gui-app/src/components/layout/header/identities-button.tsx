import { IdCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/** The unary the whole family is gated on; a host that has one has them all. */
const IDENTITY_LIST_METHOD = "agentIdentity.list";

/**
 * Header trigger for the Identities dialog. Rendered only when the effective
 * host serves the `agentIdentity.*` family: a button that opens a dialog
 * saying "not supported" is a worse answer than no button.
 */
export function IdentitiesButton() {
  const hostId = useEffectiveHostId();
  const supported = useHostSupportsMethod(hostId, IDENTITY_LIST_METHOD);
  const activeDialog = useDesktopDialogStore((state) => state.activeDialog);
  if (!supported) return null;
  return (
    <TooltipWrapper
      label="Identities"
      side="top"
      sideOffset={6}
      align={undefined}
    >
      <Button
        type="button"
        variant="muted"
        size="icon-sm"
        aria-label="Identities"
        aria-haspopup="dialog"
        aria-expanded={activeDialog === "identities"}
        data-testid="identities-button"
        onClick={() => useDesktopDialogStore.getState().openIdentities()}
      >
        <IdCard className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}
