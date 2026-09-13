import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useCloudDraftsDirectory } from "@/hooks/drafts/use-cloud-drafts-directory";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import {
  cloudDraftIdentityKey,
  cloudDraftKindsSnapshot,
  subscribeCloudDraftKinds,
} from "@/lib/drafts/cloud-draft-kinds";
import { openableCloudDrafts } from "@/lib/drafts/cloud-drafts-visibility";

export function CloudDraftsSection(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
}): ReactNode {
  const directory = useCloudDraftsDirectory(props.client, props.hostId);
  const kinds = useSyncExternalStore(
    subscribeCloudDraftKinds,
    cloudDraftKindsSnapshot,
    cloudDraftKindsSnapshot,
  );
  const hosts = useHostDirectoryList();
  const hostLabels = hosts.data;
  const labelByHostId = useMemo(() => {
    const labels = new Map<string, string>();
    for (const entry of hostLabels ?? []) labels.set(entry.hostId, entry.label);
    return labels;
  }, [hostLabels]);
  const openable = useMemo(
    () =>
      openableCloudDrafts({
        chats: directory.chats,
        hostId: props.hostId,
        kinds,
      }),
    [directory.chats, kinds, props.hostId],
  );
  if (!directory.visible || openable.length === 0) return null;
  return (
    <section
      data-testid="cloud-drafts-section"
      className="mt-4 flex flex-col gap-2"
    >
      <h2 className="text-ui-sm font-medium text-muted-foreground">
        Drafts from other devices
      </h2>
      <ul className="flex flex-col gap-1">
        {openable.map((chat) => {
          // A host id is not a name. The owner can be a device this directory
          // has never listed (removed from the account, or not yet fetched),
          // and a bare UUID is worse copy than saying so.
          const ownerLabel =
            labelByHostId.get(chat.ownerHostId) ?? "another device";
          const title = chat.title ?? "Untitled draft";
          return (
            <li
              key={cloudDraftIdentityKey(chat)}
              className="rounded-md px-2 py-1.5 text-ui-sm"
            >
              <span className="text-foreground">{title}</span>
              <span className="ml-2 text-muted-foreground">{ownerLabel}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
