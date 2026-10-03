import { cn } from "@/lib/utils";
import { ProfileSyncModal } from "../profile-sync/profile-sync-modal";
import type { ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  useProfileCopyFlowStore,
  type ProfileCopyFlowView,
} from "@/stores/settings/profile-copy-flow-store";
import { ProfileCopyIncomingDraftView } from "./profile-copy-incoming-draft-view";
import { ProfileCopyNewCopy } from "./profile-copy-new-copy";
import { ProfileCopyOperationView } from "./profile-copy-operation-view";
import { useProfileCopyHosts } from "./profile-copy-shared";
import { useProfileSyncPending } from "@/hooks/providers/use-profile-sync";

/**
 * The open dialog's body. It - not the always-mounted host - reads the
 * account's host list, so a closed dialog keeps no host-directory query or
 * minute tick alive at the app root.
 */
function ProfileCopyFlowBody(props: {
  readonly view: ProfileCopyFlowView;
}): ReactNode {
  const { view } = props;
  const hosts = useProfileCopyHosts();
  switch (view.kind) {
    case "sync":
      return (
        <ProfileSyncModal
          sourceHostId={view.sourceHostId}
          initialProvider={view.providerId}
          hosts={hosts}
        />
      );
    case "new":
      return (
        <ProfileCopyNewCopy
          sourceHostId={view.sourceHostId}
          provider={view.providerId}
          sourceProfileId={view.sourceProfileId}
          hosts={hosts}
        />
      );
    case "operation":
      return (
        <ProfileCopyOperationView
          operationId={view.operationId}
          hosts={hosts}
        />
      );
    case "draft":
      return (
        <ProfileCopyIncomingDraftView
          attempt={view.attempt}
          profileName={view.profileName}
          hosts={hosts}
        />
      );
  }
}

/**
 * The one profile-copy dialog, mounted at the app root.
 *
 * Deliberately outside Settings: Providers settings swaps its body for a
 * placeholder while a deep link moves its host scope, and a dialog mounted
 * there would unmount - dropping a live sign-in's slot - on exactly the
 * navigation "Open profile" performs. Every host this renders against comes
 * from the flow store's captured ids; nothing here reads a scoped, active or
 * effective host. Closing stops this window's reads and nothing on any host.
 * Sync RPCs keep their observers mounted until they settle, so leaving cannot
 * discard the submitted draft or its eventual inline answer.
 */
export function ProfileCopyFlowHost(): ReactNode {
  const view = useProfileCopyFlowStore((state) => state.view);
  const session = useProfileCopyFlowStore((state) => state.session);
  const close = useProfileCopyFlowStore((state) => state.close);
  const pending = useProfileSyncPending(
    view?.kind === "sync" ? view.sourceHostId : null,
  );
  return (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      {view !== null ? (
        <DialogContent
          layout="banded"
          showCloseButton={!pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
          }}
          className={cn(
            "flex max-h-[min(85dvh,44rem)] flex-col overflow-hidden",
            view.kind === "sync"
              ? "sm:max-w-2xl"
              : "sm:max-w-[min(34rem,var(--safe-area-width))]",
          )}
        >
          <ProfileCopyFlowBody key={session} view={view} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
