import type { ReactNode } from "react";
import {
  ChatRowIdleTime,
  NestedChatStatusGlyph,
} from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { INDENT_PX } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import type { OwnChatStatusKind } from "@/components/epic-canvas/sidebar/use-chat-archive-hidden-ids";
import {
  SIDE_TAB_HOVER_CLASS,
  SIDE_TAB_TITLE_CLASS,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import {
  BACKGROUND_ACTIVITY_TITLE,
  UNKNOWN_ACTIVITY_TITLE,
} from "@/components/notifications/notification-indicator-icon";
import {
  APPROVAL_TONE,
  FAILURE_TONE,
  FORK_TONE,
  INTERVIEW_TONE,
} from "@/components/notifications/notification-indicator-tones";
import { UnknownActivityGlyph } from "@/components/notifications/unknown-activity-glyph";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * A live agent's state: the ladder without "done", which is not live, and
 * with "unknown" for an agent on a host this device is not served activity
 * for - it may well be live, so it is listed rather than dropped.
 */
export type LiveAgentKind = Exclude<
  OwnChatStatusKind,
  "done" | "terminal-failure"
>;

/** Each state's name, the tooltip the same glyph carries in the Agents tree. */
const LIVE_KIND_LABEL: Readonly<Record<LiveAgentKind, string>> = {
  failure: FAILURE_TONE.title,
  fork: FORK_TONE.title,
  interview: INTERVIEW_TONE.title,
  approval: APPROVAL_TONE.title,
  running: "Agent in progress",
  background: BACKGROUND_ACTIVITY_TITLE,
  unknown: UNKNOWN_ACTIVITY_TITLE,
};

const WAITING_CHIP: Readonly<Partial<Record<LiveAgentKind, string>>> = {
  approval: "Approve",
  interview: "Reply",
  fork: "Resolve",
};

/**
 * The Activity view's list of live agents, under the active task's row. Inset
 * so a top-level agent's title sits one `INDENT_PX` step past the task's
 * title (which clears `SIDE_TAB_LEADING_CLASS`'s tile and badge space), the
 * same step each deeper agent takes.
 */
export const LIVE_AGENTS_LIST_CLASS = "flex flex-col gap-0.5 pt-0.5 pl-6";

/**
 * One live agent as the Activity view lists it (D9): its status glyph, its
 * title indented by its depth, and its waiting chip or else its idle time.
 * Presentational, so the layout editor's pictures draw this same row from
 * sample data and cannot drift from the live list.
 */
export function LiveAgentRowView(props: {
  readonly nodeId: string;
  readonly kind: LiveAgentKind;
  /** How many live agents it sits under. */
  readonly depth: number;
  readonly title: string;
  readonly updatedAt: number;
  readonly onClick: (() => void) | undefined;
}): ReactNode {
  const chip = WAITING_CHIP[props.kind] ?? null;
  const shownTitle = props.title.length > 0 ? props.title : "Untitled agent";
  return (
    <button
      type="button"
      data-testid={`strip-live-agent-${props.nodeId}`}
      data-live-kind={props.kind}
      aria-label={`${shownTitle}, ${LIVE_KIND_LABEL[props.kind]}`}
      onClick={props.onClick}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-2 rounded-lg pr-2 text-left text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [-webkit-app-region:no-drag]",
        SIDE_TAB_HOVER_CLASS,
      )}
      style={{
        paddingInlineStart: `${String(8 + props.depth * INDENT_PX)}px`,
      }}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        {props.kind === "unknown" ? (
          <UnknownActivityGlyph testId={undefined} />
        ) : (
          <NestedChatStatusGlyph kind={props.kind} />
        )}
      </span>
      <span className={cn(SIDE_TAB_TITLE_CLASS, "min-w-0 flex-1 truncate")}>
        {shownTitle}
      </span>
      {chip === null ? (
        <ChatRowIdleTime updatedAt={props.updatedAt} />
      ) : (
        <Badge variant="warning" data-testid="strip-live-agent-waiting-chip">
          {chip}
        </Badge>
      )}
    </button>
  );
}
