import type { ReactNode } from "react";
import { StatusGlyph } from "@/components/notifications/status-glyph";
import {
  APPROVAL_TONE,
  INTERVIEW_TONE,
  type IndicatorTone,
} from "@/components/notifications/notification-indicator-tones";
import { useRelativeTimestamp } from "@/lib/relative-time";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import type {
  NeedsYouItem as NeedsYouItemData,
  NeedsYouReason,
} from "@/stores/notifications/needs-you-items";

const REASON_TONE: Readonly<Record<NeedsYouReason, IndicatorTone>> = {
  approval: APPROVAL_TONE,
  reply: INTERVIEW_TONE,
};

/**
 * One prompt waiting on the person (D13): the ask, "task · agent" and the
 * time. The whole row opens the chat on its pending card through the
 * notification's own activation; replying and approving happen there. Shared
 * by the Notifications drawer's Needs you group and the Activity view's Needs you block.
 */
export function NeedsYouItem(props: {
  readonly item: NeedsYouItemData;
  readonly onActivate: (row: MergedNotificationRow) => void;
}): ReactNode {
  const { item } = props;
  const time = useRelativeTimestamp(item.createdAt);
  const context =
    item.agentTitle === null
      ? item.taskTitle
      : `${item.taskTitle} · ${item.agentTitle}`;
  return (
    <button
      type="button"
      data-testid="needs-you-item"
      data-notification-id={item.row.feedId}
      data-needs-you-reason={item.reason}
      onClick={() => props.onActivate(item.row)}
      className="flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset active:press-scrim"
    >
      <StatusGlyph
        status={REASON_TONE[item.reason]}
        className="mt-0.5 size-4"
        testId={undefined}
        label={null}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui-sm font-medium text-foreground">
          {item.ask}
        </span>
        <span className="truncate text-ui-xs text-muted-foreground">
          {context}
        </span>
      </span>
      <span className="shrink-0 pt-0.5 text-ui-xs text-muted-foreground tabular-nums">
        {time}
      </span>
    </button>
  );
}
