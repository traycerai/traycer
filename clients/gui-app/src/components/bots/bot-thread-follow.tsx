import type { ReactNode } from "react";
import { ChevronDown, EllipsisVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

/**
 * The thread header's follow control (decision 137): "Following", with why
 * beside it and Unfollow in its menu, or "Follow". Nothing on a host that
 * cannot read and write follows, or until they are read.
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
  if (follow === null) {
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid="bot-thread-follow"
        onClick={() => set("following")}
      >
        Follow
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-testid="bot-thread-following"
          className="min-w-0"
        >
          <span>Following</span>
          <span
            className="min-w-0 truncate font-normal text-muted-foreground"
            data-testid="bot-thread-following-reason"
          >
            {`· ${followReasonText(follow, postedByViewer)}`}
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          data-testid="bot-thread-unfollow"
          onSelect={() => set("unfollowed")}
        >
          Unfollow
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A Threads tab row's menu: Follow or Unfollow the thread, whichever it is
 * not now.
 */
export function BotThreadRowMenu(props: {
  readonly botId: string;
  readonly threadId: string;
  readonly following: boolean;
}): ReactNode {
  const { botId, threadId, following } = props;
  const update = useBotThreadFollowSetMutation(useTabHostClient());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Thread actions"
          data-testid="bot-thread-row-menu"
        >
          <EllipsisVertical aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
