import { ArrowLeft, ChevronRight } from "lucide-react";
import { Fragment, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LivePulse } from "@/components/ui/live-pulse";
import {
  cleanSubagentNotificationText,
  subagentCardPath,
  subagentHasChildText,
} from "@/components/chat/segments/subagent-display";
import { SubagentAvatar } from "@/components/chat/segments/subagent-avatar";
import { SubagentConversation } from "@/components/chat/segments/subagent-conversation";
import type { SubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { SubagentResultPanel } from "@/components/chat/segments/subagent-segment";
import type {
  ChatMessage as ChatMessageModel,
  SubagentSegment,
} from "@/stores/composer/chat-store";

interface SubagentChatViewProps {
  readonly drillIn: SubagentDrillIn;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  /** The lower dock's height: the conversation scrolls clear of the composer. */
  readonly bottomInset: number;
}

/**
 * One subagent's conversation as a full-height, read-only chat INSIDE the
 * chat tile: a breadcrumb back to the transcript (and to every ancestor card),
 * the task the parent handed over, then the conversation drawn by the same
 * `SubagentConversation` the card uses. It covers the transcript rather than
 * replacing it, so the transcript keeps its scroll position and window.
 *
 * Reads the card from the rendered messages on every render, so a running
 * subagent keeps streaming here exactly as it does in its card.
 */
export function SubagentChatView(props: SubagentChatViewProps) {
  const { bottomInset, drillIn, messages } = props;
  const { openId } = drillIn;
  const path = useMemo(
    () => (openId === null ? null : subagentCardPath(messages, openId)),
    [messages, openId],
  );
  if (openId === null) return null;
  const card = path?.at(-1) ?? null;
  return (
    <section
      data-testid="subagent-chat-view"
      aria-label={
        card === null
          ? "Subagent conversation"
          : `${cardName(card)} conversation`
      }
      // z-10 with the tile's composer dock and after the transcript's own
      // z-10 chrome (the scroll pill) in tree order: the view covers the
      // transcript and the dock stays on top of it, still usable.
      className="absolute inset-0 z-10 flex flex-col bg-background"
    >
      <SubagentChatBreadcrumb path={path ?? []} drillIn={drillIn} />
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingBottom: bottomInset }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-4">
          {card === null ? (
            <p className="m-0 text-ui-sm text-muted-foreground">
              This subagent is no longer in the loaded transcript.
            </p>
          ) : (
            <SubagentChatBody card={card} />
          )}
        </div>
      </div>
    </section>
  );
}

function cardName(card: SubagentSegment): string {
  return cleanSubagentNotificationText(card.name) ?? "Subagent";
}

function SubagentChatBreadcrumb(props: {
  readonly path: ReadonlyArray<SubagentSegment>;
  readonly drillIn: SubagentDrillIn;
}) {
  const { drillIn, path } = props;
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex w-full min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-3 py-1.5"
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={drillIn.close}
        data-testid="subagent-chat-back"
      >
        <ArrowLeft aria-hidden />
        Chat
      </Button>
      {path.map((card, index) => {
        const current = index === path.length - 1;
        return (
          <Fragment key={card.id}>
            <ChevronRight
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground/60"
            />
            <Button
              type="button"
              variant={current ? "ghost" : "muted"}
              size="xs"
              aria-current={current ? "page" : undefined}
              onClick={() => drillIn.open(card.id)}
            >
              {cardName(card)}
            </Button>
          </Fragment>
        );
      })}
    </nav>
  );
}

function SubagentChatBody(props: { readonly card: SubagentSegment }) {
  const { card } = props;
  const task = cleanSubagentNotificationText(card.task);
  const agentType = cleanSubagentNotificationText(card.agentType);
  // The card's own presence rule: no Result once the conversation has text.
  const shownResult = subagentHasChildText(card.children) ? null : card.result;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <SubagentAvatar
          seed={card.id}
          active={card.isStreaming}
          size={16}
          className={null}
        />
        <span className="min-w-0 truncate font-mono text-code-sm font-medium text-foreground/90">
          {cardName(card)}
        </span>
        {agentType !== null ? (
          <Badge variant="secondary" className="shrink-0 capitalize">
            {agentType}
          </Badge>
        ) : null}
        {card.isStreaming ? (
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel="Subagent running"
            className={undefined}
          />
        ) : null}
      </div>
      {task !== null ? (
        <div className="flex flex-col items-end gap-1">
          <span className="select-none font-medium uppercase text-overline text-muted-foreground/80">
            Task
          </span>
          <div className="max-w-full whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/30 px-4 py-3 text-ui leading-7 text-foreground [overflow-wrap:anywhere]">
            {task}
          </div>
        </div>
      ) : null}
      <SubagentConversation
        entries={card.children}
        isStreaming={card.isStreaming}
      />
      {shownResult !== null ? (
        <SubagentResultPanel
          result={shownResult}
          isStreaming={card.isStreaming}
        />
      ) : null}
      {card.children.length === 0 && card.result === null ? (
        <p className="m-0 text-ui-sm text-muted-foreground">
          No conversation recorded for this subagent.
        </p>
      ) : null}
    </>
  );
}
