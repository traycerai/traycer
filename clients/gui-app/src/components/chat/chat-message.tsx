import { memo, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { AssistantMessageBody } from "./chat-message-assistant-body";
import { chatFindSegmentUnitId } from "./chat-find";
import { singleSpecialSegment } from "./chat-special-segment";
import { UserMessageBody } from "./chat-message-user-body";
import { ForkedChatLinkSegment } from "./segments/forked-chat-link-segment";
import { SetupCardSegment } from "./segments/setup-card-segment";
import type { NextStepActionHandler } from "./segments/next-steps-action-group";

interface ChatMessageProps {
  message: ChatMessageModel;
  actions: ChatMessageActions | null;
  backgroundToolBlockIds: ReadonlySet<string>;
  nextStepActions: NextStepActionHandler | null;
}

/**
 * How a fork is seeded.
 *
 *  - `plain` - the ordinary per-message fork button: source binding verbatim,
 *    no special question handling. Titled "Fork".
 *  - `cross-question` - a fork FROM a pending question: same working copy (its
 *    binding verbatim: local stays local, an existing worktree is adopted) to
 *    interrogate the assistant, with the question carried as inline reference
 *    and the composer immediately free. Titled "Cross Question".
 *  - `ab-worktree` - a fork FROM a pending question into NEW worktrees off each
 *    folder's current branch carrying uncommitted + staged changes, to proceed
 *    down an alternate path in parallel, with the question re-opened as an
 *    answerable card. Titled "A/B Fork".
 *
 * `cross-question` / `ab-worktree` are offered on pending-question cards and
 * resolved Q&A rows; the per-message footer button is always `plain`.
 */
export type ChatForkMode = "plain" | "cross-question" | "ab-worktree";

export interface ChatMessageEditing {
  readonly initialContent: JsonContent;
  readonly currentContent: JsonContent;
  readonly pending: boolean;
  readonly canSubmit: boolean;
  readonly slashProviderId: GuiHarnessId;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly fallbackToGlobalMentionRoots: boolean;
  readonly currentEpicId: string | null;
  readonly onSnapshot: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

export interface ChatMessageForkAction {
  readonly enabled: boolean;
  readonly pending: boolean;
  /** Opens the fork dialog with the selected message-level or Q&A mode. */
  readonly onFork: (
    mode: ChatForkMode,
    interviewBlockId: string | null,
  ) => void;
}

export interface ChatMessageUserActions {
  readonly type: "user";
  readonly enabled: boolean;
  readonly confirmingDelete: boolean;
  readonly editing: ChatMessageEditing | null;
  readonly onEdit: () => void;
  readonly onDeleteRequest: () => void;
  readonly onDeleteConfirm: () => void;
  readonly onDeleteCancel: () => void;
}

export interface ChatMessageAssistantActions {
  readonly type: "assistant";
  readonly fork: ChatMessageForkAction | null;
}

export type ChatMessageActions =
  ChatMessageUserActions | ChatMessageAssistantActions;

const ROLE_LABELS: Record<ChatMessageModel["role"], string> = {
  user: "You",
  assistant: "Assistant",
  system: "System",
};

function messageAlignmentClass(message: ChatMessageModel): string {
  if (message.role === "system") return "items-center";
  if (message.role === "user" && message.agentSenderInfo !== null) {
    return "items-start";
  }
  if (message.role === "user") return "items-end";
  return "items-start";
}

// A synthesized row can carry a single full-width "special" segment (a
// setup-card or a forked-chat-link) with no sender/body. Render it directly,
// bypassing the role branches below.
function renderSingleSpecialSegment(
  message: ChatMessageModel,
): ReactElement | null {
  const segment = singleSpecialSegment(message.segments);
  if (segment === null) return null;
  if (segment.kind === "setup-card") {
    return (
      <div
        data-chat-find-unit={chatFindSegmentUnitId(segment.id)}
        className="flex w-full flex-col"
      >
        <SetupCardSegment
          model={segment.model}
          viewTabId={segment.viewTabId}
          variant="card"
        />
      </div>
    );
  }
  if (segment.kind === "forked-chat-link") {
    return (
      <div data-chat-find-unit={chatFindSegmentUnitId(segment.id)}>
        <ForkedChatLinkSegment
          viewTabId={segment.viewTabId}
          sourceChatId={segment.sourceChatId}
          sourceChatTitle={segment.sourceChatTitle}
          sourceHostId={segment.sourceHostId}
        />
      </div>
    );
  }
  return null;
}

function ChatMessageImpl(props: ChatMessageProps) {
  const { actions, backgroundToolBlockIds, message, nextStepActions } = props;
  const specialSegment = renderSingleSpecialSegment(message);
  if (specialSegment !== null) {
    return specialSegment;
  }
  // Assistant rows no longer carry a provider/model label above the bubble -
  // that moved into the elapsed footer's info tooltip (see AssistantMessageBody).
  if (message.role === "assistant") {
    const assistantActions = actions?.type === "assistant" ? actions : null;
    return (
      <div
        className={cn(
          "group/message flex w-full flex-col gap-1.5",
          messageAlignmentClass(message),
        )}
      >
        <AssistantMessageBody
          segments={message.segments}
          backgroundToolBlockIds={backgroundToolBlockIds}
          runState={message.runState}
          messageId={message.id}
          createdAt={message.createdAt}
          pausedDurationMs={message.pausedDurationMs ?? 0}
          pausedSinceMs={message.pausedSinceMs ?? null}
          completedAt={message.completedAt}
          stopped={message.stopped}
          meta={message.assistantMeta}
          nextStepActions={nextStepActions}
          forkAction={assistantActions?.fork ?? null}
        />
      </div>
    );
  }

  const senderLabel = message.senderLabel ?? ROLE_LABELS[message.role];
  const label =
    message.statusLabel === null
      ? senderLabel
      : `${senderLabel} - ${message.statusLabel}`;
  const sender = (
    <span className="text-overline font-medium text-muted-foreground/60">
      <span className="uppercase">{label}</span>
    </span>
  );

  return (
    <div
      className={cn(
        "group/message flex w-full flex-col gap-1.5",
        messageAlignmentClass(message),
      )}
    >
      {message.agentSenderInfo === null ? sender : null}
      <UserMessageBody
        message={message}
        actions={actions?.type === "user" ? actions : null}
      />
    </div>
  );
}

/**
 * Collapsible open state lives in provider-scoped stores under `ChatMessages`;
 * toggling one card only re-renders the subscribing leaf segment, not every
 * visible row. That leaves `ChatMessage` free to bail on default shallow
 * equality whenever its render-driving props are reference-equal.
 */
export const ChatMessage = memo(ChatMessageImpl);
