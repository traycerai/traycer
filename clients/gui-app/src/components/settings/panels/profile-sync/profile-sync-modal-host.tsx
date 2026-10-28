import type { ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useProfileSyncModalStore } from "@/stores/settings/profile-sync-modal-store";
import { ProfileSyncModal } from "./profile-sync-modal";

/**
 * The Sync profiles dialog, mounted at the app root.
 *
 * Deliberately outside Settings: Providers settings swaps its body for a
 * placeholder while a deep link moves its host scope, and "Sign in on
 * <source>" is exactly such a link. The source host comes from the store's
 * captured id; nothing here reads a scoped, active or effective host.
 *
 * Always closable - the close button, Escape, a click outside and Done all
 * close it whatever is in flight. Closing stops this window's reads and
 * nothing on any host. A closed dialog mounts no body, so it keeps no
 * host-directory query or overview poll alive at the app root.
 */
export function ProfileSyncModalHost(): ReactNode {
  const sourceHostId = useProfileSyncModalStore((state) => state.sourceHostId);
  const close = useProfileSyncModalStore((state) => state.close);
  if (sourceHostId === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,44rem)] flex-col overflow-hidden sm:max-w-xl"
      >
        <ProfileSyncModal key={sourceHostId} sourceHostId={sourceHostId} />
      </DialogContent>
    </Dialog>
  );
}
