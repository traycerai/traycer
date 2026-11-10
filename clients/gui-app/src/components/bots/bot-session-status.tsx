import { useContext, useMemo, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bell, ClipboardCheck } from "lucide-react";
import { useStore } from "zustand";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import {
  ChatStatusExtraRowsContext,
  ChatStatusFreshContext,
  type ChatStatusExtraRow,
} from "@/components/chat/chat-status-capabilities";
import { selectContextUsage } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import { BotSessionStatusDataContext } from "@/components/bots/bot-session-status-context";
import { useReadingWidthStyle } from "@/lib/layout-overrides";
import { cn } from "@/lib/utils";
import { describeSeconds } from "@/lib/bots/bot-trunk-model";
import { formatAbsoluteDateTime } from "@/lib/relative-time";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { openEpicFromListIntent } from "@/lib/tab-navigation/intents";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const NO_STOPS: ReadonlySet<string> = new Set();
const noStop = (): null => null;
const noItem = (): void => {};

export function BotSessionStatus(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly chatId: string;
  readonly threadId: string | null;
}): ReactNode {
  const data = useContext(BotSessionStatusDataContext);
  const navigate = useNavigate();
  const readingWidth = useReadingWidthStyle();
  const usage = useStore(props.handle.store, selectContextUsage);
  const items = useStore(props.handle.store, (state) => state.backgroundItems);
  const fresh = useStore(
    props.handle.store,
    (state) =>
      state.connectionStatus === "open" &&
      state.snapshotLoaded &&
      state.transcriptBaselineEpoch === state.connectionEpoch,
  );
  const rows = useMemo<readonly ChatStatusExtraRow[]>(() => {
    if (data === null) return [];
    const tasks = data.tasks.filter((task) => {
      const belongs =
        task.cadence.kind === "every" || task.createdByChatId === null
          ? props.threadId === null
          : task.createdByChatId === props.threadId;
      return (
        belongs &&
        (task.cadence.kind !== "none" ||
          task.lastCheckinAt !== null ||
          task.lastCheckin !== null ||
          (task.checkins?.length ?? 0) > 0)
      );
    });
    const taskRows = tasks.map((task) => ({
      id: `task:${task.taskId}`,
      countable: true,
      content: (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-ui-xs underline"
          onClick={() =>
            navigateToTabIntent(
              navigate,
              openEpicFromListIntent({
                epicId: task.taskId,
                focus: undefined,
                name: task.label ?? undefined,
                replaceEmptyDraftId: null,
              }),
              undefined,
            )
          }
        >
          <ClipboardCheck
            aria-hidden
            className="size-3.5 shrink-0 text-primary/80"
          />
          {task.label ?? task.taskId} · Check-ins
          <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
            Check-in task
          </span>
        </button>
      ),
    }));
    const subscriptions = (data.subscriptions ?? []).filter((subscription) =>
      subscription.target.kind === "trunk"
        ? props.threadId === null
        : subscription.target.threadId === props.threadId,
    );
    const subscriptionRows = subscriptions.map((subscription) => ({
      id: `subscription:${subscription.target.kind === "trunk" ? "trunk" : subscription.target.threadId}`,
      countable: true,
      content: (
        <>
          <Bell aria-hidden className="size-3.5 shrink-0 text-primary/80" />
          <span className="min-w-0 flex-1 text-ui-xs">
            Notifications ·{" "}
            {subscription.everySeconds === null
              ? "Each burst"
              : `Every ${describeSeconds(subscription.everySeconds)}`}
            {subscription.attentionOnly ? " · Attention only" : ""}
            {subscription.since === null
              ? ""
              : ` · Since ${formatAbsoluteDateTime(subscription.since)}`}
          </span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
            Subscription
          </span>
        </>
      ),
    }));
    return [
      ...taskRows,
      ...subscriptionRows,
      ...(data.subscriptions === null
        ? [
            {
              id: "subscriptions-unavailable",
              countable: false,
              content: <span>Subscriptions unavailable</span>,
            },
          ]
        : []),
    ];
  }, [data, navigate, props.threadId]);
  if (data === null) return null;
  return (
    <ChatStatusFreshContext value={fresh}>
      <ChatStatusExtraRowsContext value={rows}>
        <div className="shrink-0 px-4 pt-4">
          <div
            className={cn("mx-auto w-full", readingWidth.className)}
            style={{ maxWidth: readingWidth.maxWidth }}
          >
            <div className="@container mx-3 overflow-hidden rounded-t-lg border border-border bg-foreground/3">
              <BackgroundItemsPanel
                items={fresh ? (items ?? []) : []}
                epicId={props.botId}
                chatId={props.chatId}
                viewTabId={`bot:${props.botId}`}
                canAct={false}
                readOnly
                pendingStopTaskIds={NO_STOPS}
                stopAllPending={false}
                sessionStopPending={false}
                turnActive={false}
                scrollRegionMaxHeightClass="max-h-60"
                separated={false}
                onItemClick={noItem}
                onStopItem={noStop}
                onStopAll={noStop}
                onStopSession={noStop}
              />
            </div>
            <div className="flex justify-end px-4 py-1">
              <ContextUsageChip usage={usage} onCompact={null} />
            </div>
          </div>
        </div>
      </ChatStatusExtraRowsContext>
    </ChatStatusFreshContext>
  );
}
