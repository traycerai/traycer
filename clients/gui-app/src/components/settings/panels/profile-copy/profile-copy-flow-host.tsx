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
 */
export function ProfileCopyFlowHost(): ReactNode {
  const view = useProfileCopyFlowStore((state) => state.view);
  const session = useProfileCopyFlowStore((state) => state.session);
  const close = useProfileCopyFlowStore((state) => state.close);
  return (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {view !== null ? (
        <DialogContent
          layout="banded"
          className="flex max-h-[min(85dvh,44rem)] w-[min(92vw,34rem)] flex-col overflow-hidden sm:max-w-none"
        >
          <ProfileCopyFlowBody key={session} view={view} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
