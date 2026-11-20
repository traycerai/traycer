import type { ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  useBotThreadFollowSetMutation,
  useBotThreadFollows,
} from "@/hooks/bots/use-bot-thread-follow";
import {
  followReasonText,
  followingOf,
} from "@/lib/bots/bot-notification-settings";

/** The "⋮" Thread actions menu, the one menu a thread's actions live in. */
function ThreadActionsMenu(props: {
  readonly triggerTestId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Thread actions"
          data-testid={props.triggerTestId}
        >
          <EllipsisVertical aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{props.children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The thread header's menu (decision 137): Follow, or why the thread is
 * followed with Unfollow under it. Nothing on a host that cannot read and
 * write follows, or until they are read.
 */
export function BotThreadFollowControl(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadId: string;
  /** The viewer posted the thread's post: "you posted" rather than "you replied". */
  readonly postedByViewer: boolean;
}): ReactNode {
  const { botId, hostId, threadId, postedByViewer } = props;
  const follows = useBotThreadFollows(botId, hostId);
  const update = useBotThreadFollowSetMutation(useTabHostClient());
  const data = follows?.data;
  if (data === undefined) return null;
  const follow = followingOf(data.follows, threadId);
  const set = (state: "following" | "unfollowed"): void =>
    update.mutate({ botId, threadId, state });
  return (
    <ThreadActionsMenu triggerTestId="bot-thread-menu">
      {follow === null ? (
        <DropdownMenuItem
          data-testid="bot-thread-follow"
          onSelect={() => set("following")}
        >
          Follow
        </DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuLabel data-testid="bot-thread-following-reason">
            {`Following · ${followReasonText(follow, postedByViewer)}`}
          </DropdownMenuLabel>
          <DropdownMenuItem
            data-testid="bot-thread-unfollow"
            onSelect={() => set("unfollowed")}
          >
            Unfollow
          </DropdownMenuItem>
        </>
      )}
    </ThreadActionsMenu>
  );
}

/**
 * A Threads card's menu: Open thread, which shows its channel with the
 * thread beside it, and Follow or Unfollow the thread, whichever it is not
 * now.
 */
export function BotThreadRowMenu(props: {
  readonly botId: string;
  readonly threadId: string;
  readonly following: boolean;
  /** Opens the thread beside its channel; `null` for one whose post is gone. */
  readonly onOpenThread: (() => void) | null;
}): ReactNode {
  const { botId, threadId, following, onOpenThread } = props;
  const update = useBotThreadFollowSetMutation(useTabHostClient());
  return (
    <ThreadActionsMenu triggerTestId="bot-thread-row-menu">
      {onOpenThread === null ? null : (
        <DropdownMenuItem
          data-testid="bot-thread-row-open"
          onSelect={onOpenThread}
        >
          Open thread
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        data-testid={
          following ? "bot-thread-row-unfollow" : "bot-thread-row-follow"
        }
        onSelect={() =>
          update.mutate({
            botId,
            threadId,
            state: following ? "unfollowed" : "following",
          })
        }
      >
        {following ? "Unfollow" : "Follow"}
      </DropdownMenuItem>
    </ThreadActionsMenu>
  );
}
