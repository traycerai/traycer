/**
 * The Identities dialog: the list panel over the app-wide effective host.
 *
 * Mounted only while open (like `DraftsDialog`), so the list query runs only
 * when someone is looking. Opening a row binds a tab to THIS host - the one
 * the list was read from - and navigates to it; the tab keeps that host for
 * life, as every tab does.
 */
import { useRef, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { AgentIdentitySummary } from "@traycer/protocol/host/agent-identity/schemas";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { identityTabIntent, navigateToTabIntent } from "@/lib/tab-navigation";
import type { IdentitiesDialogMode } from "@/stores/dialogs/desktop-dialog-store";
import { useIdentityTabsStore } from "@/stores/identities/identity-tabs-store";
import { IdentitiesListPanel } from "./identities-list-panel";

/** The unary the whole family is gated on; a host that has one has them all. */
export const IDENTITY_LIST_METHOD = "agentIdentity.list";

export function IdentitiesDialog(props: {
  readonly hostId: string | null;
  readonly mode: IdentitiesDialogMode;
  readonly onClose: () => void;
}): ReactNode {
  const { hostId, mode, onClose } = props;
  const client = useHostClientForHostId(hostId);
  const supported = useHostSupportsMethod(hostId, IDENTITY_LIST_METHOD);
  const navigate = useNavigate();
  const openingRow = useRef(false);
  const createInputRef = useRef<HTMLInputElement>(null);

  const onOpen = (identity: AgentIdentitySummary) => {
    if (hostId === null) return;
    openingRow.current = true;
    onClose();
    useIdentityTabsStore.getState().openTab({
      identityId: identity.identityId,
      hostId,
      title: identity.title,
    });
    navigateToTabIntent(
      navigate,
      identityTabIntent(identity.identityId),
      undefined,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[80dvh] flex-col overflow-hidden sm:max-w-xl"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          // "New identity" opens straight into naming one; the plain list
          // keeps Radix's own first-focusable choice.
          if (mode !== "create" || createInputRef.current === null) return;
          event.preventDefault();
          createInputRef.current.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (openingRow.current) event.preventDefault();
        }}
        data-testid="identities-dialog"
      >
        <DialogHeader>
          <DialogTitle>Identities</DialogTitle>
        </DialogHeader>
        <IdentitiesListPanel
          hostId={hostId}
          client={client}
          supported={supported}
          createInputRef={createInputRef}
          onOpen={onOpen}
        />
      </DialogContent>
    </Dialog>
  );
}
