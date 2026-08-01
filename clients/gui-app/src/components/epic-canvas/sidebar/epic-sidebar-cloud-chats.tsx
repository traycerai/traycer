import { useState } from "react";
import { Globe, Lock } from "lucide-react";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useHostClient } from "@/lib/host/runtime";
import { cn } from "@/lib/utils";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import {
  cloudChatRowKey,
  composeCloudChatSectionState,
} from "@/lib/chats/cloud-chat-section-state";
import { CloudChatDialog } from "@/components/epic-canvas/sidebar/cloud-chat-dialog";

/**
 * Chats in this task that live in the cloud rather than on a host this device
 * can reach - the list half of the owner-offline story.
 *
 * ## It HIDES rather than fails
 *
 Four states collapse to rendering nothing - an older host, any other failure,
 * a signed-out viewer, and a task whose cloud chats are all already local. The
 * rule lives in `composeCloudChatSectionState`, which is where the argument for
 * it is written down and where it is tested.
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
  /**
   * The cloud row's task. In the 3.0 model an epic id IS the task id - the
   * publisher's own cloud calls pass `taskId: epicId` - so there is no mapping
   * layer here and there should not be one.
   */
  readonly taskId: string;
  /**
   * Chat ids the local tree already renders, SORTED.
   *
   * An array rather than a `Set` because it comes from `useEpicChatIds`, which
   * returns a stable sorted array so `useShallow` can bail a re-render on the
   * projection churn that does not change the id set. Membership is a linear
   * scan over a handful of ids, once per cloud row.
   */
  readonly localChatIds: readonly string[];
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

  const state = composeCloudChatSectionState({
    chats: list.data?.chats,
    isError: list.isError,
    isFetching: list.isFetching,
    localChatIds: props.localChatIds,
  });

  if (state.kind === "hidden") return null;

  if (state.kind === "loading") {
    return (
      <div className="flex w-full items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} />
        <span>Checking your other devices…</span>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-0.5">
      <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
        On your other devices
      </p>
      {state.rows.map((chat) => (
        <CloudChatRow
          key={cloudChatRowKey(chat.identity)}
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
