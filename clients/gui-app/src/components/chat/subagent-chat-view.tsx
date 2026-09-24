import { ArrowLeft, ChevronRight } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LivePulse } from "@/components/ui/live-pulse";
import {
  chatFindSubagentChatResultUnitId,
  chatFindSubagentChatTaskUnitId,
} from "@/components/chat/chat-find";
import {
  cleanSubagentNotificationText,
  subagentCardPath,
  subagentHasChildText,
} from "@/components/chat/segments/subagent-display";
import { SubagentAvatar } from "@/components/chat/segments/subagent-avatar";
import { SubagentConversation } from "@/components/chat/segments/subagent-conversation";
import {
  queryOpenAsChatControl,
  type SubagentDrillIn,
} from "@/components/chat/segments/subagent-open-as-chat";
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
  /**
   * The conversation's scroll area: chat find resolves the open card's anchors
   * under it, and the chat's scroll keys drive it while the view is open.
   */
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /** The transcript the view covers: closing returns focus to a control in it. */
  readonly transcriptRef: RefObject<HTMLElement | null>;
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
 *
 * Escape steps back one breadcrumb level, and focus follows every step - see
 * `useStepBackOnEscape` and `useDrillInFocus`.
 */
export function SubagentChatView(props: SubagentChatViewProps) {
  const { bottomInset, drillIn, messages, scrollRef, transcriptRef } = props;
  const { openId } = drillIn;
  const sectionRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const path = useMemo(
    () => (openId === null ? null : subagentCardPath(messages, openId)),
    [messages, openId],
  );
  const pathIds = useMemo(() => path?.map((card) => card.id) ?? [], [path]);
  // One breadcrumb level, like the crumb to the left of the current one.
  const stepBack = useCallback((): void => {
    const parent = path?.at(-2);
    if (parent === undefined) {
      drillIn.close();
    } else {
      drillIn.open(parent.id);
    }
  }, [drillIn, path]);
  useStepBackOnEscape(sectionRef, openId !== null, stepBack);
  useDrillInFocus({ openId, pathIds, sectionRef, headingRef, transcriptRef });
  if (openId === null) return null;
  const card = path?.at(-1) ?? null;
  return (
    <section
      ref={sectionRef}
      data-testid="subagent-chat-view"
      aria-label={
        card === null
          ? "Subagent conversation"
          : `${cardName(card)} conversation`
      }
      // Focus lands here only when there is no card heading to take it.
      tabIndex={-1}
      // z-10 with the tile's composer dock and after the transcript's own
      // z-10 chrome (the scroll pill) in tree order: the view covers the
      // transcript and the dock stays on top of it, still usable.
      className="absolute inset-0 z-10 flex flex-col bg-background outline-none"
    >
      <SubagentChatBreadcrumb path={path ?? []} drillIn={drillIn} />
      <div
        ref={scrollRef}
        // Ctrl/Cmd+A selects this conversation; the transcript container
        // withdraws its own declaration while the view is open.
        data-selection-root=""
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingBottom: bottomInset }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-4">
          {card === null ? (
            <p className="m-0 text-ui-sm text-muted-foreground">
              This subagent is no longer in the loaded transcript.
            </p>
          ) : (
            <SubagentChatBody card={card} headingRef={headingRef} />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Escape steps back one breadcrumb level while focus is inside the view.
 *
 * A NATIVE listener on the view, never a React one: React delivers a portalled
 * dialog's or menu's keydown to its React ancestors, so a dialog opened from
 * inside the conversation would close the view along with itself. A layer that
 * keeps focus in the view (a tooltip) dismisses on the document's capture
 * phase first and marks the event handled - Radix's escape layer
 * `preventDefault`s it - so that Escape is its, and the next one is ours.
 */
function useStepBackOnEscape(
  sectionRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  stepBack: () => void,
): void {
  useEffect(() => {
    const section = sectionRef.current;
    if (!isOpen || section === null) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      stepBack();
    };
    section.addEventListener("keydown", onKeyDown);
    return () => {
      section.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, sectionRef, stepBack]);
}

interface DrillInFocusStep {
  readonly openId: string | null;
  readonly pathIds: ReadonlyArray<string>;
}

const CLOSED_DRILL_IN_STEP: DrillInFocusStep = { openId: null, pathIds: [] };

interface DrillInFocusArgs extends DrillInFocusStep {
  readonly sectionRef: RefObject<HTMLElement | null>;
  readonly headingRef: RefObject<HTMLElement | null>;
  readonly transcriptRef: RefObject<HTMLElement | null>;
}

/**
 * Focus follows the drill-in, one rule per direction:
 *   - down (the transcript's control, or a nested card's inside the view):
 *     the opened card's heading, so a screen reader lands on what opened;
 *   - back up (Escape, a crumb): the open-as-chat control, in the view now
 *     showing, on the card that leads back down to where the reader was;
 *   - out (Escape at the top, the back control): the control in the
 *     transcript that opened the view, however deep the reader went since.
 * Runs after commit, so every control it looks for is the one now mounted.
 */
function useDrillInFocus(args: DrillInFocusArgs): void {
  const { headingRef, openId, pathIds, sectionRef, transcriptRef } = args;
  const previousRef = useRef<DrillInFocusStep>(CLOSED_DRILL_IN_STEP);
  const entryIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { openId, pathIds };
    if (openId === previous.openId) return;
    if (openId === null) {
      const entryId = entryIdRef.current;
      entryIdRef.current = null;
      // Without scrolling: the transcript held still under the view, so the
      // control is where the reader left it - and when an outside jump closed
      // the view, scrolling to the control would undo the jump's landing.
      closedFocusTarget(transcriptRef.current, entryId, previous)?.focus({
        preventScroll: true,
      });
      return;
    }
    if (previous.openId === null) entryIdRef.current = openId;
    const section = sectionRef.current;
    const returnTo =
      section === null
        ? null
        : steppedBackFocusTarget(section, openId, previous);
    (returnTo ?? headingRef.current ?? section)?.focus();
  }, [headingRef, openId, pathIds, sectionRef, transcriptRef]);
}

/** Out: the transcript control that opened the view, else the top card's. */
function closedFocusTarget(
  transcript: HTMLElement | null,
  entryId: string | null,
  previous: DrillInFocusStep,
): HTMLElement | null {
  if (transcript === null) return null;
  const entry =
    entryId === null ? null : queryOpenAsChatControl(transcript, entryId);
  if (entry !== null) return entry;
  const topId = previous.pathIds.at(0);
  return topId === undefined ? null : queryOpenAsChatControl(transcript, topId);
}

/**
 * Back up to `openId`: the control on its child that leads down to the card
 * just left. `null` for a step down, which focuses the heading instead.
 */
function steppedBackFocusTarget(
  view: HTMLElement,
  openId: string,
  previous: DrillInFocusStep,
): HTMLElement | null {
  const index = previous.pathIds.indexOf(openId);
  if (index < 0) return null;
  const leftId = previous.pathIds.at(index + 1);
  return leftId === undefined ? null : queryOpenAsChatControl(view, leftId);
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

function SubagentChatBody(props: {
  readonly card: SubagentSegment;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { card, headingRef } = props;
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
        {/* Programmatically focusable only: where focus lands on opening. */}
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="m-0 min-w-0 truncate font-mono text-code-sm font-medium text-foreground/90 outline-none"
        >
          {cardName(card)}
        </h2>
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
          <div
            // Find's anchors for this view: `buildSubagentChatFindRows`.
            data-chat-find-unit={chatFindSubagentChatTaskUnitId(card.id)}
            className="max-w-full whitespace-pre-wrap rounded-lg border border-border/50 bg-muted/30 px-4 py-3 text-ui leading-7 text-foreground [overflow-wrap:anywhere]"
          >
            {task}
          </div>
        </div>
      ) : null}
      <SubagentConversation
        entries={card.children}
        isStreaming={card.isStreaming}
      />
      {shownResult !== null ? (
        <div data-chat-find-unit={chatFindSubagentChatResultUnitId(card.id)}>
          <SubagentResultPanel
            result={shownResult}
            isStreaming={card.isStreaming}
          />
        </div>
      ) : null}
      {card.children.length === 0 && card.result === null ? (
        <p className="m-0 text-ui-sm text-muted-foreground">
          No conversation recorded for this subagent.
        </p>
      ) : null}
    </>
  );
}
