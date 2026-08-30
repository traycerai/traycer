import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ImagePlus,
  Inbox,
  MoreHorizontal,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  composerClipboardPlainText,
  copyComposerContentToClipboard,
} from "@/lib/composer/composer-clipboard";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  containsImageAtoms,
  omitImageAtomsByHash,
} from "@/lib/composer/image-atoms";
import { stringValue } from "@/lib/composer/tiptap-json-content";
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
import { BrowserReferenceChips } from "./browser-reference-chips";
import { ComposerArea } from "@/components/home/composer/composer-shell";
import { LivePulse } from "@/components/ui/live-pulse";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AgentHeaderLink } from "./segments/agent-header-link";
import { AgentMessageBody } from "./segments/agent-message-body";
import { ReplyExpectedBadge } from "./segments/reply-expected-badge";
import { SegmentCard } from "./segments/segment-card";
import { useTombstonedProfileLabel } from "./use-tombstoned-profile-label";
import { AccentDot } from "@/components/providers/accent-dot";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import type { ProviderId } from "@/components/home/data/landing-options";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  isAttachmentIngestPending,
  useComposerPaste,
} from "@/hooks/composer/use-composer-paste";
import { useWorkspaceMentionRoots } from "@/hooks/composer/use-workspace-mention-roots";
import { useEpicAttachmentBytesPresence } from "@/lib/attachments/use-attachment-blob-src";
import { useChatAttachmentByteReader } from "@/lib/attachments/use-chat-image-fetcher";
import { useRunnerHost } from "@/providers/use-runner-host";

const NOOP: () => void = () => undefined;

function visibleUserSteerBadge(
  message: ChatMessageModel,
): ChatMessageSteerBadge | null {
  if (message.steerBadge === null) return null;
  if (message.steerBadge.status === "steered") return null;
  return message.steerBadge;
}

function userMessageDisplayContent(
  message: ChatMessageModel,
): JsonContent | null {
  if (message.structuredContent === null) return null;
  const hashes = new Set(
    (message.browserAnnotations ?? []).map(
      (annotation) => annotation.imageHash,
    ),
  );
  return omitImageAtomsByHash(message.structuredContent, hashes);
}

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
          browserAnnotations={message.browserAnnotations}
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
          browserAnnotations={message.browserAnnotations}
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
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-sm">
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground">from agent </span>
          <AgentHeaderLink
            name={senderName}
            onOpen={openTarget !== null ? openSenderTab : null}
          />
        </span>
        {expectReply ? <ReplyExpectedBadge /> : null}
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
      <AgentMessageBody
        value={messageText}
        bodyFindUnitId={bodyFindUnitId}
        isStreaming={false}
      />
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

  const displayContent = useMemo(
    () => userMessageDisplayContent(message),
    [message],
  );
  const body =
    displayContent !== null ? (
      <ComposerContentRenderer
        content={displayContent}
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

  const profileProvenance = useTombstonedProfileLabel(message.sessionAnchor);
  // Present whenever `profileProvenance` is (the resolver only returns a
  // verdict for an anchor with a non-null `profileId`) - re-derived separately
  // since the hook's return doesn't narrow `sessionAnchor` for TypeScript.
  const tombstoneIdentity = tombstoneFooterIdentity(message.sessionAnchor);
  const confirmingDelete = actions?.confirmingDelete ?? false;
  const visibleSteerBadge = visibleUserSteerBadge(message);
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
            browserAnnotations={message.browserAnnotations}
            align="start"
          />
          <BrowserReferenceChips
            annotations={message.browserAnnotations ?? []}
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
        <UserMessageTouchMenu
          confirmingDelete={confirmingDelete}
          actions={actions}
          copyText={copyText}
          structuredContent={message.structuredContent}
        />
      </div>
      {profileProvenance !== null && tombstoneIdentity !== null ? (
        <UserMessageTombstonedProfileFooter
          profileId={tombstoneIdentity.profileId}
          harnessId={tombstoneIdentity.harnessId}
          accentColor={tombstoneIdentity.accentColor}
          label={profileProvenance.label}
          removed={profileProvenance.removedOnThisHost}
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
        // The group-focus-within reveal is fine-pointer-only: on coarse
        // pointers the touch "…" menu (UserMessageTouchMenu) replaces this
        // chip, and Radix returning focus to that trigger on menu close would
        // otherwise reveal the chip on top of it. The chip's own
        // focus-within reveal stays unscoped so tabbing into its buttons with
        // a hardware keyboard still shows them on any device.
        confirmingDelete
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0 group-hover/user-message:pointer-events-auto group-hover/user-message:opacity-100 pointer-fine:group-focus-within/user-message:pointer-events-auto pointer-fine:group-focus-within/user-message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
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

/**
 * `removed` is the ONLY thing separating a genuine local deletion from a turn
 * that simply ran on another machine: profile ids are host-local, so an anchor
 * carried here by a fork/clone can never match this host's list and claiming
 * "(removed)" for it would be a false accusation about a profile that is alive
 * and well elsewhere. The provenance itself is kept either way.
 */
function UserMessageTombstonedProfileFooter({
  profileId,
  harnessId,
  accentColor,
  label,
  removed,
}: {
  readonly profileId: string;
  readonly harnessId: ProviderId;
  readonly accentColor: string | null;
  readonly label: string;
  readonly removed: boolean;
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
      {removed ? `Ran on ${label} (removed)` : `Ran on ${label}`}
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
  const tabHostId = useTabHostId();
  const resolvedMentionRoots = useWorkspaceMentionRoots(
    editing.mentionRoots,
    editing.fallbackToGlobalMentionRoots,
    tabHostId,
  );
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const hasPastedImageBytes = useEpicAttachmentBytesPresence();
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const visibilityFrameRef = useRef<number | null>(null);
  const runnerHost = useRunnerHost();
  const {
    onPaste,
    onDrop,
    onDragOver,
    attachImageFiles,
    isIngestingImages,
    isResolvingFilePaths,
  } = useComposerPaste(editorRef, runnerHost.fileDrops, resolvedMentionRoots);
  const attachmentPending = isAttachmentIngestPending({
    isIngestingImages,
    isResolvingFilePaths,
  });

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

  const scheduleVisibilityCheck = useCallback(() => {
    if (visibilityFrameRef.current !== null) {
      cancelAnimationFrame(visibilityFrameRef.current);
    }
    visibilityFrameRef.current = requestAnimationFrame(() => {
      visibilityFrameRef.current = null;
      scrollIntoViewOnlyIfNeeded(containerRef.current);
    });
  }, []);

  const onDocumentChange = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      editing.onSnapshot(content, selection);
      scheduleVisibilityCheck();
    },
    [editing, scheduleVisibilityCheck],
  );

  // Inline message editing tracks no persisted selection of its own (unlike
  // the chat/landing/modal composer drafts) - a caret move only needs the
  // same visibility nudge a real edit gets, never a content dispatch.
  const onSelectionChange = useCallback(() => {
    scheduleVisibilityCheck();
  }, [scheduleVisibilityCheck]);

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
        ingestPastedComposerImages={null}
        isActive
        disabled={editing.pending}
        placeholder="Edit message"
        editorClassName="max-h-[min(60vh,18rem)] min-h-9 overflow-y-auto text-ui leading-7 text-foreground"
        stabilizeImageAttachmentCaret={false}
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
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
      onDocumentChange,
      onSelectionChange,
      pickerStore,
      hasPastedImageBytes,
      submit,
    ],
  );
  const editorSlot = useMemo(
    () => (
      <>
        <ChatComposerAttachmentsStrip
          taskId={null}
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
        utilityRail={null}
        attachmentsStrip={null}
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
 * Rewrite each hash-only `imageAttachment` node to carry inline `b64content`
 * (resolved from the epic's attachments store) so the copied clipboard payload
 * is self-contained. A hash whose bytes are unresolvable (a dangling ref) is
 * left hash-only — the destination composer's paste validation strips it.
 */
async function inlineCopiedImageBytes(
  content: JsonContent,
  resolveBytes: (hash: string) => Promise<Uint8Array | null>,
): Promise<JsonContent> {
  const hashes = hashOnlyImageHashesInContent(content);
  if (hashes.length === 0) return content;
  const bytesByHash = new Map<string, Uint8Array>();
  await Promise.all(
    hashes.map(async (hash) => {
      const bytes = await resolveBytes(hash);
      if (bytes !== null) bytesByHash.set(hash, bytes);
    }),
  );
  if (bytesByHash.size === 0) return content;
  return inlineHashOnlyImageNodes(content, bytesByHash);
}

function hashOnlyImageHashesInContent(content: JsonContent): string[] {
  const hashes = new Set<string>();
  const visit = (node: JsonContent): void => {
    if (node.type === "imageAttachment") {
      const hash = stringValue(node.attrs?.hash);
      const b64content = stringValue(node.attrs?.b64content);
      if (hash !== null && b64content === null) hashes.add(hash);
      return;
    }
    node.content?.forEach(visit);
  };
  visit(content);
  return Array.from(hashes);
}

function inlineHashOnlyImageNodes(
  node: JsonContent,
  bytesByHash: ReadonlyMap<string, Uint8Array>,
): JsonContent {
  if (node.type === "imageAttachment") {
    const hash = stringValue(node.attrs?.hash);
    const b64content = stringValue(node.attrs?.b64content);
    if (hash === null || b64content !== null) return node;
    const bytes = bytesByHash.get(hash);
    if (bytes === undefined) return node;
    // An image node carries exactly one payload; swap the hash for base64.
    const { hash: _hash, ...rest } = node.attrs ?? {};
    return { ...node, attrs: { ...rest, b64content: bytesToBase64(bytes) } };
  }
  const children = node.content;
  if (children === undefined) return node;
  return {
    ...node,
    content: children.map((child) =>
      inlineHashOnlyImageNodes(child, bytesByHash),
    ),
  };
}

/**
 * Copy behavior shared by the hover chip's copy button and the coarse-pointer
 * "…" menu's Copy item, so both entry points write the identical clipboard
 * payload (rich composer content with re-inlined image bytes when the message
 * is structured, plain text otherwise).
 */
function useUserMessageCopy(
  text: string,
  structuredContent: JsonContent | null,
): { readonly copied: boolean; readonly onCopy: () => void } {
  const { copied, copy, copyWith } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: handleCopyError,
  });
  // Chat-plane read with the reader's own bound. This replaces a
  // `hasAttachmentBytes` pre-check that existed purely to stop
  // `readAttachmentBytes` from waiting indefinitely and hanging the clipboard
  // write; the bytes are no longer answerable synchronously, so the same
  // guarantee now comes from the timeout. A hash that does not resolve stays
  // hash-only, exactly as before, and downstream paste validation drops it.
  const resolveAttachmentBytes = useChatAttachmentByteReader();
  const onCopy = useCallback(() => {
    if (structuredContent === null) {
      copy(text);
      return;
    }
    // Re-inline each hash-only image node's bytes as `b64content` before writing
    // to the clipboard, so a paste onto the start page (or into another epic's
    // chat) carries real bytes instead of a bare hash that resolves nowhere.
    copyWith(async () => {
      const content = await inlineCopiedImageBytes(
        structuredContent,
        resolveAttachmentBytes,
      );
      const result = await copyComposerContentToClipboard({
        content,
        plainText: text,
      });
      // Image atoms serialize to no plain text, so a rich-write failure that
      // silently degrades to plain text would drop every image while still
      // resolving "copied". Surface that instead of a clean-looking success.
      if (!result.richContentWritten && containsImageAtoms(content)) {
        reportableErrorToast(
          "Images weren't copied",
          {
            description:
              "The text was copied, but this device couldn't place the images on the clipboard.",
          },
          {
            title: "Images were not copied",
            message: null,
            code: null,
            source: "Chat message",
          },
        );
      }
    });
  }, [copy, copyWith, resolveAttachmentBytes, structuredContent, text]);

  return { copied, onCopy };
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
  const { copied, onCopy } = useUserMessageCopy(text, structuredContent);

  return (
    <MessageActionButton
      label={copied ? "Copied" : "Copy message"}
      variant="ghost"
      size="icon-sm"
      tooltip={false}
      disabled={false}
      className={undefined}
      onClick={onCopy}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </MessageActionButton>
  );
}

/**
 * Coarse-pointer replacement for the hover action chip: a single muted "…"
 * trigger straddling the bubble's bottom-right border (the chip's exact spot)
 * opening a menu with Edit / Copy / Delete wired to the same handlers the chip
 * uses. Hidden on fine pointers via `hidden pointer-coarse:flex`, so
 * hover-capable desktops keep today's chip untouched; hover reveals never
 * apply on coarse pointers (Tailwind gates `hover:` behind
 * `@media (hover: hover)`), which is exactly the gap this menu fills.
 *
 * Delete hands off to the existing confirm flow: `onDeleteRequest` sets the
 * chip's `confirmingDelete` state, which force-reveals the inline check/cross
 * confirm on every pointer type - so this trigger unmounts while that confirm
 * occupies the same corner, and no second confirm surface is introduced.
 *
 * Mirrors the chip's gating: Edit/Delete only while `actions` is present and
 * enabled (`canModifyMessages`, not pending); Copy whenever there is text,
 * including mid-stream when `actions` is null.
 */
function UserMessageTouchMenu({
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
  const { onCopy } = useUserMessageCopy(copyText, structuredContent);
  const canModify = actions !== null && actions.enabled;
  const canCopy = copyText.trim().length > 0;
  if (confirmingDelete || (!canModify && !canCopy)) return null;

  return (
    // Tucked onto the bubble's bottom-right corner, straddling the border
    // (`top-full -translate-y-1/2`): the glyph's upper half only ever covers
    // the bubble's bottom padding, so it can't collide with message text on
    // short or multi-line bubbles, and it reads as attached to the bubble
    // edge rather than floating beneath it. The confirming-delete chip takes
    // this same corner region while this trigger is unmounted.
    <div className="absolute right-1 top-full z-10 hidden -translate-y-1/2 pointer-coarse:flex">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Message actions"
            // Resting bg-muted matches ghost's aria-expanded open surface,
            // so the glyph reads as a button before it is tapped. The
            // invisible ::after slop widens the 24px visual control to the
            // 44px touch-target guideline without painting anything (Button
            // renders no ::after of its own, so nothing merges with it).
            // muted-fill-ok: transcript row renders on bg-background/canvas
            className="relative bg-muted text-muted-foreground/70 hover:text-foreground after:absolute after:-inset-2.5 after:content-['']"
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canModify ? (
            <DropdownMenuItem onSelect={actions.onEdit}>
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
          ) : null}
          {canCopy ? (
            <DropdownMenuItem onSelect={onCopy}>
              <Copy className="size-3.5" />
              Copy
            </DropdownMenuItem>
          ) : null}
          {canModify ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={actions.onDeleteRequest}
              >
                <Trash2 className="size-3.5" />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
