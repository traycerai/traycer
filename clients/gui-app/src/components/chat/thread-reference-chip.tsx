import {
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { TaskReferenceChip } from "@/components/chat/task-reference-chip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import {
  findHeldBotThread,
  subscribeToHeldBotThreads,
  type HeldBotThread,
} from "@/lib/bots/held-bot-threads";
import { cn } from "@/lib/utils";

/**
 * An id-shaped token that named no agent (Tracy Bots T160): a chip for the
 * thread it names when the window holds that thread in a bot's thread list -
 * the bot's picture, "thread", and the first words of the post it hangs off -
 * that opens the bot's channel with the thread beside it. Any other token
 * goes on to {@link TaskReferenceChip}: a task's chip, or the id as written.
 */
export function ThreadReferenceChip(props: {
  readonly referenceId: string;
  readonly display: "text" | "code";
}): ReactNode {
  const queryClient = useContext(QueryClientContext);
  if (queryClient === undefined) return <TaskReferenceChip {...props} />;
  return <HeldThreadReference queryClient={queryClient} {...props} />;
}

function HeldThreadReference(props: {
  readonly queryClient: QueryClient;
  readonly referenceId: string;
  readonly display: "text" | "code";
}): ReactNode {
  const { queryClient, referenceId, display } = props;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeToHeldBotThreads(queryClient, onStoreChange),
    [queryClient],
  );
  const held = useSyncExternalStore(subscribe, () =>
    findHeldBotThread(queryClient, referenceId),
  );
  if (held === null) {
    return <TaskReferenceChip referenceId={referenceId} display={display} />;
  }
  const title = held.thread.anchor?.excerpt ?? null;
  return (
    <TooltipWrapper
      label={`${title ?? "Thread"}\n${held.thread.threadId}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <ThreadReferenceButton held={held} title={title} />
    </TooltipWrapper>
  );
}

function ThreadReferenceButton(props: {
  readonly held: HeldBotThread;
  readonly title: string | null;
}): ReactNode {
  const { held, title } = props;
  const openChannel = useOpenBotChannel();
  return (
    <button
      type="button"
      onClick={() =>
        openChannel(held.botId, {
          kind: "thread",
          threadId: held.thread.threadId,
          messageId: null,
        })
      }
      className={cn(
        "mx-0.25 inline-flex max-w-[min(26rem,80vw)] items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 align-baseline",
        "text-ui-sm font-medium text-primary transition-colors hover:bg-primary/15 hover:text-primary focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
      data-thread-reference={held.thread.threadId}
      data-bot-id={held.botId}
      // Excluded from quote selection, as the agent and task chips are: a drag
      // across it must not append its title as quoted text.
      data-quote-exclude=""
    >
      <NamedBotAvatar botId={held.botId} size="xs" />
      <span className="shrink-0 font-normal">thread</span>
      {title === null ? null : <span className="truncate">{title}</span>}
    </button>
  );
}
