import { useMemo, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useCloudDraftsDirectory } from "@/hooks/drafts/use-cloud-drafts-directory";

export function CloudDraftsSection(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
}): ReactNode {
  const directory = useCloudDraftsDirectory(props.client, props.hostId);
  const foreign = useMemo(() => {
    if (props.hostId === null) return [];
    return directory.chats.filter((chat) => chat.ownerHostId !== props.hostId);
  }, [directory.chats, props.hostId]);
  if (!directory.visible || foreign.length === 0) return null;
  return (
    <section
      data-testid="cloud-drafts-section"
      className="mt-4 flex flex-col gap-2"
    >
      <h2 className="text-ui-sm font-medium text-muted-foreground">
        Drafts from other devices
      </h2>
      <ul className="flex flex-col gap-1">
        {foreign.map((chat) => {
          const ownerLabel = chat.ownerHostId;
          const title = chat.title ?? "Untitled draft";
          return (
            <li
              key={`${chat.identity.taskId}:${chat.identity.chatId}`}
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
