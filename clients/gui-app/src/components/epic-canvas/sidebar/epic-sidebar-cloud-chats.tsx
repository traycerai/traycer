import { useState } from "react";
import { Globe, Lock } from "lucide-react";
import type {
  CloudChatIdentity,
  CloudChatSummary,
} from "@traycer/protocol/host/epic/cloud-chat";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostClient } from "@/lib/host/runtime";
import { cn } from "@/lib/utils";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import { CloudChatDialog } from "@/components/epic-canvas/sidebar/cloud-chat-dialog";

/**
 * Chats in this task that live in the cloud rather than on a host this device
 * can reach - the list half of the owner-offline story.
 *
 * ## It HIDES rather than fails
 *
 * Three states collapse to rendering nothing: a host that predates the
 * cloud-chat methods, an unauthenticated viewer, and a task with no published
 * chats. None of them is an error a user can act on from here, and a section
 * announcing "cloud chats unavailable" would be a permanent notice on every
 * older host. The distinction that matters - "your other devices' chats are
 * here" versus "there is nothing to show" - is carried by the section's
 * presence, not by a message inside it.
 *
 * ## What a row can and cannot say
 *
 * A row states what the cloud ROW knows: title, visibility, when it was last
 * published. It cannot say whether this build can read the chat, and that is a
 * deliberate consequence of the head being opaque to the server and the host -
 * v1 computed a `readability` verdict at list time from a record version the
 * server stamped, and there is no such stamp any more. A version refusal is
 * discovered on open, which costs one refusal rendered a click later than it
 * used to be.
 */

export interface EpicSidebarCloudChatsProps {
  readonly taskId: string;
  /** Chat ids this device already has locally, which the section skips. */
  readonly localChatIds: ReadonlySet<string>;
}

export function EpicSidebarCloudChats(
  props: EpicSidebarCloudChatsProps,
): React.JSX.Element | null {
  const client = useHostClient();
  const [openChat, setOpenChat] = useState<CloudChatSummary | null>(null);

  const list = useCloudChatList({
    client,
    taskId: props.taskId,
    enabled: props.taskId.length > 0,
  });

  // An older host, or any other failure: the section is simply not there. Both
  // collapse deliberately - see the note above on why neither is a notice.
  if (list.isError) return null;

  if (list.isPending) {
    return (
      <div className="flex w-full items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} />
        <span>Checking your other devices…</span>
      </div>
    );
  }

  // A chat this device already holds locally is shown by the local tree, and
  // showing it twice would read as two chats.
  const rows = list.data.chats.filter(
    (chat) => !props.localChatIds.has(chat.identity.chatId),
  );
  if (rows.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-0.5">
      <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
        On your other devices
      </p>
      {rows.map((chat) => (
        <CloudChatRow
          key={rowKeyOf(chat.identity)}
          chat={chat}
          onOpen={() => setOpenChat(chat)}
        />
      ))}
      <CloudChatDialog
        identity={openChat?.identity ?? null}
        summary={openChat}
        open={openChat !== null}
        onOpenChange={(open) => {
          if (!open) setOpenChat(null);
        }}
      />
    </div>
  );
}

function CloudChatRow(props: {
  readonly chat: CloudChatSummary;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const { chat } = props;
  const Icon = chat.visibility === "task" ? Globe : Lock;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm",
        "hover:bg-accent",
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {chat.title ?? "Untitled chat"}
      </span>
      {chat.publishedAt === null && (
        <span className="shrink-0 text-xs text-muted-foreground">
          not published
        </span>
      )}
    </button>
  );
}

/**
 * A row key over the whole identity triple.
 *
 * `chatId` alone is host-minted and two hosts can mint the same one under a
 * task, so keying on it would collapse two genuinely different chats into one
 * React element - and swap their content when the list reorders.
 */
function rowKeyOf(identity: CloudChatIdentity): string {
  return `${identity.taskId}:${identity.ownerUserId}:${identity.chatId}`;
}
