import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ImagePlus,
  Inbox,
  Pencil,
  SendHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type { KeyboardEvent } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import { ChatComposerAttachmentsStrip } from "@/components/chat/composer/chat-composer-attachments-strip";
import { ComposerContentRenderer } from "@/components/chat/composer/content-renderer";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useComposerPickerItems } from "@/components/chat/composer/picker/use-composer-picker-items";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  composerClipboardPlainText,
  copyComposerContentToClipboard,
} from "@/lib/composer/composer-clipboard";
import { useEpicArtifact, useOpenEpicId } from "@/lib/epic-selectors";
import { cn, formatSingleLine } from "@/lib/utils";
import { deriveA2AReceivedCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import {
  chatFindA2AReceivedBodyUnitId,
  chatFindMessageContentUnitId,
} from "@/components/chat/chat-find";
import type {
  ChatMessage as ChatMessageModel,
  ChatMessageSteerBadge,
} from "@/stores/composer/chat-store";
import {
  useA2AReceivedOpen,
  useSetA2AReceivedOpen,
} from "@/stores/chats/a2a-open-store-context";
import {
  useChatCollapsibleTileInstanceId,
  useChatFindForcedOpen,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import type {
  ChatMessageEditing,
  ChatMessageUserActions,
} from "./chat-message";
import { ChatUserMessageContent } from "./chat-user-message-content";
import { UserMessageAttachmentGallery } from "./user-message-attachment-gallery";
import { ComposerArea } from "@/components/home/composer/composer-shell";
import { LivePulse } from "@/components/ui/live-pulse";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AgentReferenceMarkdown } from "./segments/agent-reference-markdown";
import { SegmentCard } from "./segments/segment-card";
import { SegmentPanel } from "./segments/segment-panel";
import { useTombstonedProfileLabel } from "./use-tombstoned-profile-label";
import { AccentDot } from "@/components/providers/accent-dot";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import type { ProviderId } from "@/components/home/data/landing-options";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useComposerPaste } from "@/hooks/composer/use-composer-paste";
import { useWorkspaceMentionRoots } from "@/hooks/composer/use-workspace-mention-roots";
import { useEpicAttachmentBytesPresence } from "@/lib/attachments/use-attachment-blob-src";

const NOOP: () => void = () => undefined;

// Keep long prompts compact: ~3-4 lines (leading-7 ≈ 28px/line) stay visible
// before the bubble clamps and fades, with "Show more" revealing the rest.
const DISPLAY_MAX_HEIGHT_PX = 120;

const COPIED_RESET_MS = 1600;

const handleCopyError = (): void => {
  reportableErrorToast("Couldn't copy to clipboard.", undefined, {
    title: "Could not copy to clipboard",
    message: null,
    code: null,
    source: "Clipboard",
  });
};

interface UserBodyProps {
  message: ChatMessageModel;
  actions: ChatMessageUserActions | null;
}

export function UserMessageBody({
  actions,
  message,
}: UserBodyProps): ReactNode {
  const editing = actions?.editing ?? null;

  if (message.role !== "user") {
    return (
      <>
        <UserMessageAttachmentGallery
          attachments={message.attachments}
          align="end"
        />
        <div className="w-full rounded-lg border border-border/40 bg-muted/20 px-4 py-3 text-ui leading-7 text-muted-foreground">
          <ChatUserMessageContent
            content={message.content}
            attachments={message.attachments}
          />
        </div>
      </>
    );
  }

  if (editing !== null) {
    return <InlineUserMessageEditor editing={editing} />;
  }

  if (message.agentSenderInfo !== null) {
    return (
      <>
        <UserMessageAttachmentGallery
          attachments={message.attachments}
          align="end"
        />
        <AgentMessageDisplayView
          messageId={message.id}
          messageText={message.content}
          agentMessage={message.agentMessage}
          agentSenderInfo={message.agentSenderInfo}
        />
      </>
    );
  }

  return <UserMessageDisplayView message={message} actions={actions} />;
}

/**
 * Display variant for a `role: "user"` message whose sender was another
 * agent. It is rendered as operational agent traffic, not as a human-authored
 * user bubble; the visible body is the structured message body only.
 */
function AgentMessageDisplayView({
  messageId,
  messageText,
  agentMessage,
  agentSenderInfo,
}: {
  messageId: string;
  messageText: string;
  agentMessage: ChatMessageModel["agentMessage"];
  agentSenderInfo: NonNullable<ChatMessageModel["agentSenderInfo"]>;
}): ReactNode {
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const collapsibleKey = useMemo(
    () => deriveA2AReceivedCollapsibleKey(tileInstanceId, messageId),
    [messageId, tileInstanceId],
  );
  const bodyFindUnitId = chatFindA2AReceivedBodyUnitId(messageId);
  const userOpen = useA2AReceivedOpen(messageId);
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const open = userOpen || findForcedOpen;
  const setOpen = useSetA2AReceivedOpen();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(messageId, next);
      if (!next) setFindForcedOpen(collapsibleKey, false);
    },
    [collapsibleKey, messageId, setFindForcedOpen, setOpen],
  );

  const epicId = useOpenEpicId();
  const tileNavigation = useEpicTileNavigation();
  const senderNode = useEpicArtifact(agentSenderInfo.agentId);
  // Resolve the live sender from the epic projection. A chat or
  // terminal-agent is openable as a tab; an absent node (e.g. a
  // cross-host sender not in this projection) renders as plain text.
  const openTarget = useMemo((): {
    readonly type: "chat" | "terminal-agent";
    readonly hostId: string;
  } | null => {
    if (senderNode === null) return null;
    if ("harnessId" in senderNode) {
      return { type: "terminal-agent", hostId: senderNode.hostId };
    }
    if ("kind" in senderNode) return null; // artifacts aren't agents
    if (senderNode.hostId === null) return null;
    return { type: "chat", hostId: senderNode.hostId };
  }, [senderNode]);

  const liveTitle =
    senderNode !== null && "title" in senderNode && senderNode.title.length > 0
      ? senderNode.title
      : null;
  const senderName =
    liveTitle ??
    agentMessage?.senderTitle ??
    agentSenderInfo.senderTitle ??
    `${agentSenderInfo.agentId.slice(0, 8)}…`;
  const expectReply =
    agentMessage?.reply.expectsReply ?? agentSenderInfo.expectReply;

  const openSenderTab = useCallback(() => {
    if (openTarget === null) return;
    tileNavigation.openTileInEpic(epicId, {
      id: agentSenderInfo.agentId,
      instanceId: uuidv4(),
      type: openTarget.type,
      name: senderName,
      hostId: openTarget.hostId,
    });
  }, [agentSenderInfo.agentId, epicId, openTarget, senderName, tileNavigation]);

  const header = (
    <>
      <Inbox className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="shrink-0 text-ui-sm font-medium text-foreground/85">
        Received message
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-sm">
        <span className="text-muted-foreground">from agent </span>
        <span className="font-medium text-foreground/85">{senderName}</span>
      </span>
    </>
  );

  const preview = (
    <p className="m-0 line-clamp-2 text-ui-sm leading-6 text-foreground/85">
      {formatSingleLine(messageText, { maxLength: 180, ellipsis: "…" })}
    </p>
  );

  const body = open ? (
    <div className="flex flex-col gap-2">
      {openTarget !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openSenderTab}
            className="w-fit rounded px-1.5 py-0.5 text-ui-sm font-medium text-primary underline-offset-2 transition-colors hover:bg-primary/10 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Open sending agent
          </button>
          {expectReply ? (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1.5 text-overline font-medium uppercase text-primary">
                reply expected
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      <SegmentPanel
        label="Message"
        copyValue={messageText}
        tone="default"
        bodyChrome="framed"
        className={undefined}
      >
        <div className="max-h-[min(40vh,24rem)] overflow-auto px-3 py-2">
          <div data-chat-find-unit={bodyFindUnitId}>
            <AgentReferenceMarkdown
              isStreaming={false}
              markdown={messageText}
              proseSize="compact"
              quotable={false}
            />
          </div>
        </div>
      </SegmentPanel>
    </div>
  ) : null;

  return (
    <div className="w-full max-w-[min(100%,48rem)]">
      <SegmentCard
        open={open}
        onOpenChange={handleOpenChange}
        header={header}
        headerAction={null}
        collapsedPreview={preview}
        body={body}
        tone="primary"
        headerPosition="normal"
        bodyOverflow="hidden"
        expandable
        headerFindUnitId={null}
        bodyFindUnitId={null}
        className={undefined}
      />
    </div>
  );
}

function UserMessageDisplayView({
  message,
  actions,
}: {
  message: ChatMessageModel;
  actions: ChatMessageUserActions | null;
}): ReactNode {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (el === null) return;
    const check = (): void => {
      const next = el.scrollHeight > DISPLAY_MAX_HEIGHT_PX;
      setIsOverflowing((prev) => (prev === next ? prev : next));
    };
    const observer = new ResizeObserver(check);
    observer.observe(el);
    check();
    return () => observer.disconnect();
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const body =
    message.structuredContent !== null ? (
      <ComposerContentRenderer
        content={message.structuredContent}
        variant={undefined}
        className={undefined}
        testId={undefined}
      />
    ) : (
      <ChatUserMessageContent
        content={message.content}
        attachments={message.attachments}
      />
    );

  const tombstonedProfileLabel = useTombstonedProfileLabel(
    message.sessionAnchor,
  );
  // Present whenever `tombstonedProfileLabel` is (the resolver only returns a
  // label for an anchor with a non-null `profileId`) - re-derived separately
  // since the hook's return doesn't narrow `sessionAnchor` for TypeScript.
  const tombstoneIdentity = tombstoneFooterIdentity(message.sessionAnchor);
  const confirmingDelete = actions?.confirmingDelete ?? false;
  const visibleSteerBadge =
    message.steerBadge !== null && message.steerBadge.status !== "steered"
      ? message.steerBadge
      : null;
  // Only clamp while collapsed; expanding drops both the height cap and the
  // bottom fade so the full prompt is readable in place. The overflow probe
  // keeps measuring the (now uncapped) content, so the toggle stays visible.
  const clamped = isOverflowing && !expanded;
  const findUnitId = chatFindMessageContentUnitId(message.id);
  const copyText = useMemo(
    () =>
      message.structuredContent === null
        ? message.content
        : composerClipboardPlainText(message.structuredContent),
    [message.content, message.structuredContent],
  );

  return (
    <div
      className="group/user-message flex min-w-0 max-w-[min(100%,48rem)] flex-col items-end"
      data-user-message-display=""
    >
      {visibleSteerBadge !== null ? (
        <div className="mb-1.5">
          <UserMessageSteerBadge badge={visibleSteerBadge} />
        </div>
      ) : null}
      <div className="relative min-w-0 max-w-full">
        <div className="rounded-lg border border-border/50 bg-muted/30 px-4 py-3 text-ui leading-7 text-foreground [overflow-wrap:anywhere]">
          <UserMessageAttachmentGallery
            attachments={message.attachments}
            align="start"
          />
          <div
            ref={contentRef}
            data-chat-find-unit={findUnitId}
            style={clamped ? { maxHeight: DISPLAY_MAX_HEIGHT_PX } : undefined}
            className={cn(
              "min-w-0",
              clamped && [
                "overflow-hidden",
                "[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]",
              ],
            )}
          >
            {body}
          </div>
          {isOverflowing ? (
            <ShowMoreToggle expanded={expanded} onToggle={toggleExpanded} />
          ) : null}
        </div>
        {/* The action chip floats over the bubble's bottom-right border instead
            of reserving a row beneath it, so the assistant reply sits close
            under the user message rather than after a tall hover gap. The copy
            button is rendered independently of `actions` so it stays available
            on hover even while a turn is streaming (when edit/delete are gated
            off and `actions` is null). */}
        <UserMessageActionOverlay
          confirmingDelete={confirmingDelete}
          actions={actions}
          copyText={copyText}
          structuredContent={message.structuredContent}
        />
      </div>
      {tombstonedProfileLabel !== null && tombstoneIdentity !== null ? (
        <UserMessageTombstonedProfileFooter
          profileId={tombstoneIdentity.profileId}
          harnessId={tombstoneIdentity.harnessId}
          accentColor={tombstoneIdentity.accentColor}
          label={tombstonedProfileLabel}
        />
      ) : null}
    </div>
  );
}

function UserMessageActionOverlay({
  confirmingDelete,
  actions,
  copyText,
  structuredContent,
}: {
  readonly confirmingDelete: boolean;
  readonly actions: ChatMessageUserActions | null;
  readonly copyText: string;
  readonly structuredContent: JsonContent | null;
}): ReactNode {
  return (
    <div
      className={cn(
        "absolute right-3 top-full z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5 shadow-sm transition-opacity",
        confirmingDelete
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0 group-hover/user-message:pointer-events-auto group-hover/user-message:opacity-100 group-focus-within/user-message:pointer-events-auto group-focus-within/user-message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
      )}
    >
      {actions !== null ? <MessageActionBar actions={actions} /> : null}
      {!confirmingDelete && copyText.trim().length > 0 ? (
        <MessageCopyButton
          text={copyText}
          structuredContent={structuredContent}
        />
      ) : null}
    </div>
  );
}

// `message.sessionAnchor?.profileId ?? null` doesn't narrow the anchor's
// discriminated-union type for TypeScript, so the footer's other identity
// fields (harnessId, accentColor) need their own re-derivation - pulled into
// one helper instead of three inline optional chains in the render body.
function tombstoneFooterIdentity(
  sessionAnchor: ChatMessageModel["sessionAnchor"],
): {
  readonly profileId: string;
  readonly harnessId: ProviderId;
  readonly accentColor: string | null;
} | null {
  if (sessionAnchor === null) return null;
  if (sessionAnchor.profileId === null) return null;
  return {
    profileId: sessionAnchor.profileId,
    harnessId: sessionAnchor.harnessId,
    accentColor: sessionAnchor.accentColor,
  };
}

function UserMessageTombstonedProfileFooter({
  profileId,
  harnessId,
  accentColor,
  label,
}: {
  readonly profileId: string;
  readonly harnessId: ProviderId;
  readonly accentColor: string | null;
  readonly label: string;
}): ReactNode {
  return (
    <span className="mt-1 flex items-center gap-1.5 text-ui-xs text-muted-foreground">
      <HarnessIcon harnessId={harnessId} />
      <AccentDot
        profileId={profileId}
        accentColor={accentColor}
        label={null}
        variant="inline"
        size="default"
        className={undefined}
      />
      Ran on {label} (removed)
    </span>
  );
}

/**
 * Bottom-anchored disclosure toggle for an overflowing user prompt. Only
 * mounts when the bubble was clamped, so the label flips between expanding the
 * full prompt and collapsing it back to the masked preview height.
 */
function ShowMoreToggle({
  expanded,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  return (
    <div className="mt-1 flex justify-center">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-expanded={expanded}
        className="text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronUp className="size-3" aria-hidden />
        ) : (
          <ChevronDown className="size-3" aria-hidden />
        )}
        {expanded ? "Show less" : "Show more"}
      </Button>
    </div>
  );
}

function UserMessageSteerBadge({
  badge,
}: {
  readonly badge: ChatMessageSteerBadge;
}): ReactNode {
  const label = userMessageSteerBadgeLabel(badge);

  return (
    <div className="flex items-center gap-1 self-start px-1 text-overline font-medium uppercase text-muted-foreground/65">
      {badge.status === "steering" ? (
        <LivePulse
          size="xs"
          tone="active"
          ariaLabel="Steering queued message"
          className={undefined}
        />
      ) : (
        <SendHorizontal className="size-3" aria-hidden />
      )}
      <span>{label}</span>
    </div>
  );
}

function userMessageSteerBadgeLabel(badge: ChatMessageSteerBadge): string {
  if (badge.status === "requested") return "Steer requested";
  if (badge.status === "steering") return "Steering";
  return "Steered";
}

function InlineUserMessageEditor({
  editing,
}: {
  editing: ChatMessageEditing;
}): ReactNode {
  const [pickerStore] = useState(() => createComposerPickerStore());
  const hostClient = useTabHostClient();
  const resolvedMentionRoots = useWorkspaceMentionRoots(
    editing.mentionRoots,
    editing.fallbackToGlobalMentionRoots,
  );
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const hasPastedImageBytes = useEpicAttachmentBytesPresence();
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const visibilityFrameRef = useRef<number | null>(null);
  const { onPaste, onDrop, onDragOver, attachImageFiles, isIngestingImages } =
    useComposerPaste(editorRef);
  const attachmentPending = isIngestingImages;

  // Without this, the picker opens empty - nothing writes items into the store.
  useComposerPickerItems({
    pickerStore,
    hostClient,
    harnessId: editing.slashProviderId,
    mentionRoots: resolvedMentionRoots,
    currentEpicId: editing.currentEpicId,
    // The inline editor mounts only while a message is being edited - active.
    isActive: true,
  });

  const submit = useCallback(() => {
    if (!editing.canSubmit || editing.pending || attachmentPending) {
      return;
    }
    editing.onSubmit();
  }, [attachmentPending, editing]);

  const cancel = useCallback(() => {
    if (editing.pending) return;
    editing.onCancel();
  }, [editing]);

  const removeImageAttachment = useCallback((id: string) => {
    editorRef.current?.removeImageAttachmentById(id);
  }, []);

  const openImagePicker = useCallback(() => {
    const input = imageInputRef.current;
    if (input === null) return;
    input.value = "";
    input.click();
  }, []);

  const handleImageChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      attachImageFiles(files);
    },
    [attachImageFiles],
  );

  const onSnapshot = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      editing.onSnapshot(content, selection);
      if (visibilityFrameRef.current !== null) {
        cancelAnimationFrame(visibilityFrameRef.current);
      }
      visibilityFrameRef.current = requestAnimationFrame(() => {
        visibilityFrameRef.current = null;
        scrollIntoViewOnlyIfNeeded(containerRef.current);
      });
    },
    [editing],
  );

  useLayoutEffect(() => {
    const focusFrame = focusFrameRef;
    const visibilityFrame = visibilityFrameRef;
    // ComposerMenu is now caret-anchored (portal'd to body, positioned by
    // floating-ui), so it picks the best direction at open-time on its own.
    // No headroom-reserving scroll needed.
    const scrollSnapshot = captureScrollSnapshot(containerRef.current);
    let attempt = 0;
    const focusWhenReady = (): void => {
      editorRef.current?.focusAtEnd();
      restoreScrollSnapshot(scrollSnapshot);
      attempt += 1;
      if (attempt >= 4) {
        focusFrameRef.current = null;
        return;
      }
      focusFrameRef.current = requestAnimationFrame(focusWhenReady);
    };
    focusWhenReady();
    return () => {
      if (focusFrame.current !== null) {
        cancelAnimationFrame(focusFrame.current);
      }
      if (visibilityFrame.current !== null) {
        cancelAnimationFrame(visibilityFrame.current);
      }
    };
  }, []);
  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    },
    [cancel],
  );
  const editor = useMemo(
    () => (
      <ComposerPromptEditor
        ref={editorRef}
        pickerStore={pickerStore}
        initialContent={editing.initialContent}
        initialSelection={null}
        slashProviderId={editing.slashProviderId}
        hasPastedImageBytes={hasPastedImageBytes}
        isActive
        disabled={editing.pending}
        placeholder="Edit message"
        editorClassName="max-h-[min(60vh,18rem)] min-h-9 overflow-y-auto text-ui leading-7 text-foreground"
        stabilizeImageAttachmentCaret={false}
        onSnapshot={onSnapshot}
        onSubmit={submit}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onKeyDown={handleEditorKeyDown}
        onFocus={NOOP}
        onBlur={NOOP}
        onEditorReady={null}
      />
    ),
    [
      editing,
      handleEditorKeyDown,
      onDragOver,
      onDrop,
      onPaste,
      onSnapshot,
      pickerStore,
      hasPastedImageBytes,
      submit,
    ],
  );
  const editorSlot = useMemo(
    () => (
      <>
        <ChatComposerAttachmentsStrip
          content={editing.currentContent}
          editingQueueItemId={null}
          onCancelQueueEdit={null}
          onRemoveImage={removeImageAttachment}
        />
        {editor}
      </>
    ),
    [editing.currentContent, editor, removeImageAttachment],
  );
  const toolbar = useMemo(
    () => (
      <div className="flex items-center gap-1 px-4 pb-3 pt-2">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={handleImageChange}
        />
        <MessageActionButton
          label="Attach image"
          variant="ghost"
          size="icon-sm"
          tooltip
          disabled={editing.pending}
          className="mr-auto text-muted-foreground hover:text-foreground"
          onClick={openImagePicker}
        >
          <ImagePlus className="size-4" aria-hidden />
        </MessageActionButton>
        <MessageActionButton
          label="Cancel edit"
          variant="secondary"
          size="default"
          tooltip
          disabled={editing.pending}
          className={undefined}
          onClick={cancel}
        >
          Cancel
        </MessageActionButton>
        <MessageActionButton
          label="Send edit"
          variant="default"
          size="default"
          tooltip
          disabled={!editing.canSubmit || editing.pending || attachmentPending}
          className={undefined}
          onClick={submit}
        >
          {attachmentPending ? (
            <AgentSpinningDots
              className="text-current"
              testId="edit-attachment-pending"
              variant={undefined}
            />
          ) : null}
          Send
        </MessageActionButton>
      </div>
    ),
    [
      cancel,
      editing.canSubmit,
      editing.pending,
      handleImageChange,
      openImagePicker,
      attachmentPending,
      submit,
    ],
  );

  return (
    <div ref={containerRef} className="w-full">
      <ComposerArea
        pickerStore={pickerStore}
        overlay={null}
        editor={editorSlot}
        toolbar={toolbar}
      />
    </div>
  );
}

function MessageActionBar({
  actions,
}: {
  actions: ChatMessageUserActions;
}): ReactNode {
  if (!actions.enabled && actions.editing === null) return null;

  if (actions.confirmingDelete) {
    return (
      <>
        <MessageActionButton
          label="Confirm delete"
          variant="ghost"
          size="icon-sm"
          tooltip={false}
          disabled={!actions.enabled}
          className="text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
          onClick={actions.onDeleteConfirm}
        >
          <Check className="size-3.5" aria-hidden />
        </MessageActionButton>
        <MessageActionButton
          label="Cancel delete"
          variant="ghost"
          size="icon-sm"
          tooltip={false}
          disabled={!actions.enabled}
          className="text-destructive hover:text-destructive"
          onClick={actions.onDeleteCancel}
        >
          <X className="size-3.5" aria-hidden />
        </MessageActionButton>
      </>
    );
  }

  return (
    <>
      <MessageActionButton
        label="Edit message"
        variant="ghost"
        size="icon-sm"
        tooltip={false}
        disabled={!actions.enabled}
        className={undefined}
        onClick={actions.onEdit}
      >
        <Pencil className="size-3.5" aria-hidden />
      </MessageActionButton>
      <MessageActionButton
        label="Delete message"
        variant="ghost"
        size="icon-sm"
        tooltip={false}
        disabled={!actions.enabled}
        className="text-destructive hover:text-destructive"
        onClick={actions.onDeleteRequest}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </MessageActionButton>
    </>
  );
}

function MessageActionButton(props: {
  readonly label: string;
  readonly variant: "default" | "ghost" | "secondary";
  readonly size: "default" | "icon-sm";
  readonly tooltip: boolean;
  readonly disabled: boolean;
  readonly className: string | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const button = (
    <Button
      type="button"
      variant={props.variant}
      size={props.size}
      disabled={props.disabled}
      aria-label={props.label}
      className={props.className}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
  // The pencil/trash glyphs are self-explanatory, so the action chip skips the
  // hover tooltip; text buttons (editor Cancel/Send) keep theirs.
  if (!props.tooltip) return button;
  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {button}
    </TooltipWrapper>
  );
}

/**
 * Copy-to-clipboard button for the user message action chip. Sits alongside
 * edit/delete but stays available even while a turn is streaming (when those
 * two are gated off), so a user can always grab their own prompt text.
 */
function MessageCopyButton({
  text,
  structuredContent,
}: {
  text: string;
  structuredContent: JsonContent | null;
}): ReactNode {
  const { copied, copy, copyWith } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: handleCopyError,
  });
  const onClick = useCallback(() => {
    if (structuredContent === null) {
      copy(text);
      return;
    }
    copyWith(() =>
      copyComposerContentToClipboard({
        content: structuredContent,
        plainText: text,
      }),
    );
  }, [copy, copyWith, structuredContent, text]);

  return (
    <MessageActionButton
      label={copied ? "Copied" : "Copy message"}
      variant="ghost"
      size="icon-sm"
      tooltip={false}
      disabled={false}
      className={undefined}
      onClick={onClick}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </MessageActionButton>
  );
}

function scrollIntoViewOnlyIfNeeded(element: HTMLElement | null): void {
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  const scrollContainer = nearestScrollContainer(element);
  const containerRect = scrollContainer?.getBoundingClientRect() ?? null;
  const viewportBottom =
    containerRect?.bottom ??
    window.visualViewport?.height ??
    document.documentElement.clientHeight;
  const viewportTop = containerRect?.top ?? 0;
  const padding = 16;
  if (rect.bottom > viewportBottom - padding) {
    scrollByAmount(scrollContainer, rect.bottom - viewportBottom + padding);
    return;
  }
  if (rect.top < viewportTop + padding) {
    scrollByAmount(scrollContainer, rect.top - viewportTop - padding);
  }
}

type ScrollSnapshot = {
  readonly container: HTMLElement | null;
  readonly left: number;
  readonly top: number;
};

function captureScrollSnapshot(element: HTMLElement | null): ScrollSnapshot {
  const scrollContainer =
    element === null ? null : nearestScrollContainer(element);
  if (scrollContainer === null) {
    return { container: null, left: window.scrollX, top: window.scrollY };
  }
  return {
    container: scrollContainer,
    left: scrollContainer.scrollLeft,
    top: scrollContainer.scrollTop,
  };
}

function restoreScrollSnapshot(snapshot: ScrollSnapshot): void {
  if (snapshot.container === null) {
    window.scrollTo(snapshot.left, snapshot.top);
    return;
  }
  snapshot.container.scrollLeft = snapshot.left;
  snapshot.container.scrollTop = snapshot.top;
}

function nearestScrollContainer(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent !== null) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (
      overflowY === "auto" ||
      overflowY === "scroll" ||
      overflowY === "overlay"
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

function scrollByAmount(element: HTMLElement | null, top: number): void {
  if (element === null) {
    window.scrollBy({ top, behavior: "auto" });
    return;
  }
  element.scrollBy({ top, behavior: "auto" });
}
