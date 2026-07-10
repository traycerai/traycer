import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import { ArrowLeftRight, Plus, XIcon } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";

import {
  AttachmentStrip,
  NO_SESSION_OBJECT_URL,
} from "@/components/chat/composer/attachments/attachment-strip";
import { useEpicImageFetcher } from "@/lib/attachments/use-attachment-blob-src";
import { DialogOverlayBoundaryContext } from "@/providers/dialog-overlay-boundary-context";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useComposerPickerItems } from "@/components/chat/composer/picker/use-composer-picker-items";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useCreateTuiAgent,
  type TuiAgentPlacement,
} from "@/hooks/agent/use-create-tui-agent";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useLeaderScopeAbsorber } from "@/hooks/keybindings/use-leader-scope-absorber";
import { useComposerPaste } from "@/hooks/composer/use-composer-paste";
import {
  mentionRootsFromWorktreeIntent,
  useWorkspaceMentionRoots,
} from "@/hooks/composer/use-workspace-mention-roots";
import { useEpicCreateChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import {
  latestCreatedConversationOwner,
  useLatestConversationWorkspaceSeed,
  type LatestConversationWorkspaceSeed,
} from "@/hooks/worktree/use-latest-conversation-workspace-seed";
import { useOwnerWorkspaceInheritanceSeed } from "@/hooks/worktree/use-owner-workspace-inheritance-seed";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useHostClient } from "@/lib/host";
import { LEADER_SCOPE_NEW_CONVERSATION_MODAL } from "@/lib/keybindings/leader-scope";
import {
  useEpicConnectionStatus,
  useEpicNodeOwnerKind,
  useEpicNodeWorkspaceFolders,
  useEpicPermissionRole,
} from "@/lib/epic-selectors";
import { displayTitle } from "@/lib/display-title";
import { isEditableRole, mutationDisabledHint } from "@/lib/epic-permissions";
import {
  ARIA_DISABLED_TRIGGER_CLASS,
  resolveDisabledPresentation,
} from "@/lib/disabled-presentation";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import {
  deriveFolderlessAllowedWorkspaceAvailability,
  workspaceComposerCanStart,
} from "@/lib/composer/workspace-composer-availability";
import { buildForkWorkspaceSeedFromWorkspaceFolders } from "@/lib/worktree/fork-workspace-seed";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import { cn } from "@/lib/utils";
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { ComposerBody } from "@/components/home/composer/composer-body";
import { COMPOSER_EDITOR_CLASSNAME } from "@/components/home/composer/composer-editor-classnames";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  nextComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import {
  createEmptyNewConversationContent,
  useNewConversationModalStore,
  type NewConversationModalSeed,
} from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  ACTIVE_TILE_PLACEMENT,
  type ConversationTilePlacement,
} from "@/lib/canvas/conversation-tile-placement";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import {
  newConversationModalStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";

/**
 * Isolated subscriber for the live draft content. The editor rewrites content
 * on every keystroke; keeping that subscription here (rather than in
 * `NewConversationModalBody`) means only the attachment strip re-renders while
 * typing - the toolbar / workspace controls / editor wrapper stay put.
 */
function NewConversationModalAttachmentStrip(props: {
  readonly epicId: string;
  readonly seedContent: JsonContent;
  readonly onRemoveImage: (id: string) => void;
}) {
  const content = useNewConversationModalStore(
    (state) =>
      state.draftPatchesByEpicId[props.epicId]?.content ?? props.seedContent,
  );
  const fetcher = useEpicImageFetcher();
  return (
    <AttachmentStrip
      content={content}
      onRemoveImage={props.onRemoveImage}
      fetcher={fetcher}
      sessionObjectUrl={NO_SESSION_OBJECT_URL}
    />
  );
}

interface NewConversationModalActionProps {
  readonly epicId: string;
  readonly tabId: string;
  // `null` for a top-level conversation (chats-panel `+`, ⌘K); a chat id when
  // adding a CHILD (per-row `+` in the chats tree). Both use this one trigger.
  readonly parentId: string | null;
  readonly size: "icon-xs" | "icon-sm";
  readonly disabled: boolean;
  readonly disabledTooltip: string | null;
  readonly triggerLabel: string;
  readonly triggerTestId: string;
  readonly actionRevealClassName: string;
}

/**
 * The single "+" trigger for the New Conversation modal, shared by the chats
 * panel header (top-level) and each chat row (child). It always opens in chat
 * mode; the modal's own switcher is the one way to flip to a terminal agent, so
 * there are no per-trigger dropdowns. Forcing chat mode here overrides the
 * projection-derived seed default and prevents a previously-dismissed
 * terminal/PaneOpener draft from leaking its mode in.
 */
export function NewConversationModalAction(
  props: NewConversationModalActionProps,
) {
  const openModal = useNewConversationModalOpenStore((state) => state.open);
  const handleOpen = useCallback((): void => {
    if (props.disabled) return;
    useNewConversationModalStore
      .getState()
      .setComposerMode(props.epicId, "chat");
    openModal({
      epicId: props.epicId,
      tabId: props.tabId,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: props.parentId,
    });
  }, [openModal, props.disabled, props.epicId, props.parentId, props.tabId]);
  // Activation while aria-disabled stays blocked via `handleOpen`'s early
  // return; see `disabled-presentation.ts` for why native `disabled` can't
  // carry the tooltip.
  const { ariaDisabled, nativeDisabled } = resolveDisabledPresentation(
    props.disabled,
    props.disabledTooltip,
  );
  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size={props.size}
      aria-label={props.triggerLabel}
      aria-disabled={ariaDisabled ? true : undefined}
      data-testid={props.triggerTestId}
      className={cn(
        "text-muted-foreground hover:text-foreground",
        ARIA_DISABLED_TRIGGER_CLASS,
        props.actionRevealClassName,
      )}
      disabled={nativeDisabled}
      onClick={handleOpen}
    >
      <Plus className={props.size === "icon-xs" ? "size-3" : "size-4"} />
    </Button>
  );

  if (props.disabled) {
    return (
      <TooltipWrapper
        label={props.disabledTooltip}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {trigger}
      </TooltipWrapper>
    );
  }

  return trigger;
}

/**
 * Per-tab host for the shared New Conversation modal. Mounted inside the epic
 * route (so the modal's permission/connection gating and per-epic draft store
 * resolve to this epic). Renders the modal whenever the open-request store
 * targets this epic + tab; every creation trigger - sidebar `+`, in-pane
 * PaneOpener, ⌘K palette - funnels through that one request.
 */
export function NewConversationModalHost(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const request = useNewConversationModalOpenStore((state) => state.request);
  const closeModal = useNewConversationModalOpenStore((state) => state.close);
  const isOpen =
    request !== null &&
    request.epicId === props.epicId &&
    request.tabId === props.tabId;
  // This host only mounts for the active tab. If it unmounts (the user switches
  // to another epic tab) while it still owns the open request, clear it -
  // otherwise the global request lingers with no live host to dismiss it and
  // the modal re-pops when the user returns to this tab.
  useEffect(() => {
    return () => {
      const current = useNewConversationModalOpenStore.getState().request;
      if (
        current !== null &&
        current.epicId === props.epicId &&
        current.tabId === props.tabId
      ) {
        useNewConversationModalOpenStore.getState().close();
      }
    };
  }, [props.epicId, props.tabId]);
  return (
    <NewConversationModalDialog
      epicId={props.epicId}
      tabId={props.tabId}
      placement={isOpen ? request.placement : ACTIVE_TILE_PLACEMENT}
      parentId={isOpen ? request.parentId : null}
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) closeModal();
      }}
    />
  );
}

function NewConversationModalDialog(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly placement: ConversationTilePlacement;
  readonly parentId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  // Opt this modal out of the keybinding provider's dialog block so the nested
  // model picker's ⌘/⌥ leader-digit shortcuts and hints fire while it's open
  // (see `isAnyDialogOpen` in keybinding-provider.tsx). The modal owns no leader
  // shortcuts itself, so an absorber scope claims both leaders while open -
  // closed-picker leader digits are swallowed here instead of switching the
  // tabs behind the modal, and the picker's own scope layers on top when open.
  useLeaderScopeAbsorber(props.open, LEADER_SCOPE_NEW_CONVERSATION_MODAL);
  // The composer's @/slash picker (see `ComposerMenu`) is a plain portalled
  // floating menu, not a Radix dismissable layer, so Radix can't coordinate
  // Escape with it. Radix's escape listener runs first (document, capture) and
  // dismisses the dialog; preventing that needs `preventDefault`, but that also
  // suppresses ProseMirror's keydown (it ignores defaultPrevented events), so
  // the picker's own Escape-close never fires. The body publishes an imperative
  // dismiss here: while a picker is open we close it ourselves and preventDefault
  // (first Escape closes only the picker); once it's closed the call returns
  // false and Escape falls through to dismiss the dialog (second Escape).
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  // The workspace controls' nested Branch/Location popovers portal to
  // `document.body` by default, landing as a DOM sibling of this dialog - the
  // dialog's scroll-lock then swallows wheel input over their scrollable
  // lists even though the lists themselves scroll fine (see
  // `DialogOverlayBoundaryContext`). Publishing this dialog's own content node
  // lets those nested overlays portal inside it instead, so the lock
  // recognizes their content as its own.
  const [overlayBoundaryEl, setOverlayBoundaryEl] =
    useState<HTMLElement | null>(null);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        ref={setOverlayBoundaryEl}
        className="w-[min(92vw,48rem)] max-w-[min(92vw,48rem)] gap-3 p-4 sm:max-w-[min(92vw,48rem)]"
        data-testid="epic-sidebar-new-conversation-modal"
        data-leader-scope={LEADER_SCOPE_NEW_CONVERSATION_MODAL}
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (dismissPickerRef.current?.() === true) {
            event.preventDefault();
          }
        }}
      >
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="absolute right-0 top-0 z-10 size-6 -translate-y-1/2 translate-x-1/2 rounded-full border border-border/70 bg-popover text-muted-foreground opacity-70 shadow-sm transition-opacity hover:opacity-100 focus-visible:opacity-100"
          >
            <XIcon className="size-3.5" />
          </Button>
        </DialogClose>
        <DialogTitle className="sr-only">
          New chat or terminal agent
        </DialogTitle>
        {props.open ? (
          <DialogOverlayBoundaryContext.Provider value={overlayBoundaryEl}>
            <SurfaceActivityProvider active>
              <NewConversationModalBody
                epicId={props.epicId}
                tabId={props.tabId}
                placement={props.placement}
                parentId={props.parentId}
                dismissPickerRef={dismissPickerRef}
                onSubmitted={() => props.onOpenChange(false)}
              />
            </SurfaceActivityProvider>
          </DialogOverlayBoundaryContext.Provider>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Modal title row. The chat/terminal switcher is always shown (it is the single
 * way to flip between a chat and a terminal agent, for both top-level and child
 * creation). When adding a child (`parentId !== null`) a muted subtext names the
 * parent (chat or terminal agent), and tracks the current mode ("child chat" vs
 * "child terminal agent") so it stays accurate as the user switches.
 */
function NewConversationModalHeader(props: {
  readonly composerMode: ComposerMode;
  readonly parentId: string | null;
  readonly switcher: ReactNode;
}) {
  const { composerMode, parentId, switcher } = props;
  const isChildChat = parentId !== null;
  // The parent can be a chat or a terminal agent (both live in the chats tree);
  // resolve its display title from the right projection slice.
  const parentTitle = useEpicStore((state) => {
    if (parentId === null) return null;
    if (Object.hasOwn(state.chats.byId, parentId)) {
      return displayTitle(state.chats.byId[parentId].title, "chat");
    }
    if (Object.hasOwn(state.tuiAgents.byId, parentId)) {
      return displayTitle(
        state.tuiAgents.byId[parentId].title,
        "terminal-agent",
      );
    }
    return null;
  });
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          {composerMode === "chat"
            ? "Start a new chat"
            : "Start a new terminal agent"}
        </span>
        {switcher}
      </div>
      {isChildChat ? (
        <span className="truncate text-ui-xs text-muted-foreground">
          Creating a child {composerMode === "chat" ? "chat" : "terminal agent"}{" "}
          from {parentTitle ?? displayTitle("", "chat")}
        </span>
      ) : null}
    </div>
  );
}

function NewConversationModalBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly placement: ConversationTilePlacement;
  readonly parentId: string | null;
  readonly dismissPickerRef: RefObject<(() => boolean) | null>;
  readonly onSubmitted: () => void;
}) {
  const { epicId, tabId, placement, parentId, dismissPickerRef, onSubmitted } =
    props;
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const isDisconnected = connectionStatus === "closed";
  const canMutate = isEditableRole(permissionRole) && !isDisconnected;
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [pickerStore] = useState(() => createComposerPickerStore());
  // Bridge the editor's imperative picker dismiss up to the dialog's Escape
  // handler (see `NewConversationModalDialog`). Returns true when a picker was
  // open and got closed, so the dialog keeps itself open for that Escape.
  // Cleared on unmount so a stale closure can never block dismissing the dialog.
  useEffect(() => {
    dismissPickerRef.current = () =>
      editorRef.current?.dismissActiveSuggestion() ?? false;
    return () => {
      dismissPickerRef.current = null;
    };
  }, [dismissPickerRef]);
  const hostClient = useHostClient();
  const latestWorkspaceSeed = useModalWorkspaceSeed(epicId, parentId);
  const seed = useNewConversationModalSeed(epicId, latestWorkspaceSeed);
  // Subscribe to the NON-content draft fields only. `content` is rewritten on
  // every keystroke (see `handleSnapshot`); subscribing to the whole patch here
  // would re-render the entire modal body per character. Live content is routed
  // to an isolated subscriber (`NewConversationModalAttachmentStrip`) plus a
  // boolean submit gate, mirroring the landing composer's isolation.
  const draftFields = useNewConversationModalStore(
    useShallow((state) => {
      const patch = state.draftPatchesByEpicId[epicId];
      return {
        settings: patch?.settings ?? null,
        composerMode: patch?.composerMode ?? null,
        workspace: patch?.workspace ?? null,
      };
    }),
  );
  const draftSettings = draftFields.settings ?? seed.settings;
  const draftComposerMode = draftFields.composerMode ?? seed.composerMode;
  const draftWorkspace = draftFields.workspace ?? seed.workspace;
  const hasSubmittableContent = useNewConversationModalStore((state) =>
    contentIsSubmittable(
      state.draftPatchesByEpicId[epicId]?.content ?? seed.content,
    ),
  );
  const [initialContent] = useState<JsonContent>(
    () =>
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
        ?.content ?? seed.content,
  );
  const stagingKey = useMemo(
    () => newConversationModalStagingKey(epicId, parentId),
    [epicId, parentId],
  );
  const stagingKeyId = worktreeStagingKeyString(stagingKey);
  const stagedIntent = useWorktreeIntentStagingStore(
    (state) => state.intentByKey[stagingKeyId] ?? null,
  );
  const setContent = useNewConversationModalStore((state) => state.setContent);
  const setSettings = useNewConversationModalStore(
    (state) => state.setSettings,
  );
  const setComposerMode = useNewConversationModalStore(
    (state) => state.setComposerMode,
  );
  const clearDraft = useNewConversationModalStore((state) => state.clearDraft);
  const clearStagedIntent = useWorktreeIntentStagingStore(
    (state) => state.clear,
  );
  const rememberEpicIntent = useWorktreeIntentMemoryStore(
    (state) => state.setEpicIntent,
  );
  const setGlobalRunSettings = useComposerRunSettingsStore(
    (state) => state.setGlobalRunSettings,
  );
  const setEpicRunSettings = useComposerRunSettingsStore(
    (state) => state.setEpicRunSettings,
  );
  const handleToolbarSettingsChange = useCallback(
    (settings: ChatRunSettings): void => {
      setSettings(epicId, settings);
    },
    [epicId, setSettings],
  );
  const toolbarStore = useComposerToolbarStore(
    null,
    draftSettings,
    handleToolbarSettingsChange,
    draftComposerMode === "terminal",
  );
  const harnessId = useStore(
    toolbarStore,
    (state) => state.selection.harnessId,
  );
  const mentionIntent = useMemo(
    () =>
      effectiveWorktreeIntent({
        workspace: draftWorkspace,
        seedIntent: latestWorkspaceSeed?.intent ?? null,
        stagedIntent,
      }),
    [draftWorkspace, latestWorkspaceSeed, stagedIntent],
  );
  const rawMentionRoots = useMemo(
    () => mentionRootsFromWorktreeIntent(draftWorkspace.folders, mentionIntent),
    [draftWorkspace.folders, mentionIntent],
  );
  const mentionRoots = useWorkspaceMentionRoots(rawMentionRoots, false);
  const chatComposerActive = draftComposerMode === "chat";
  useComposerPickerItems({
    pickerStore,
    hostClient,
    harnessId,
    mentionRoots,
    currentEpicId: epicId,
    // Skip the eager catalog fetch when the modal is in Terminal mode: the chat
    // editor is hidden and cannot be pasted into. Mirrors `chatEditorIsActive`.
    isActive: chatComposerActive,
  });

  const createChat = useEpicCreateChat();
  const terminalAgentCreate = useCreateTuiAgent();
  const isSubmitting = createChat.isPending || terminalAgentCreate.isPending;
  const resolvedWorkspace = useResolvedWorkspaceFolders(
    draftWorkspace,
    hostClient,
  );
  const workspaceAvailability = useMemo(
    () =>
      deriveFolderlessAllowedWorkspaceAvailability(
        resolvedWorkspace.folders,
        resolvedWorkspace.isLoading,
      ),
    [resolvedWorkspace.folders, resolvedWorkspace.isLoading],
  );
  const workspaceCanStart = workspaceComposerCanStart(workspaceAvailability);
  const draftWorkspaceFolderCount = draftWorkspace.folders.length;
  const canSubmit =
    canMutate && !isSubmitting && workspaceCanStart && hasSubmittableContent;
  const composerDisabledHint =
    mutationDisabledHint(permissionRole, isDisconnected, "make changes") ??
    workspaceAvailability.disabledHint;
  const paste = useComposerPaste(editorRef);
  const { dictationControl, dictationPreparing } = useComposerDictation({
    editorRef,
    isActive: chatComposerActive,
  });
  const workspaceControls = (
    <ActiveHostWorkspaceControls
      stagingKey={stagingKey}
      layout="inline"
      workspaceSeed={draftWorkspace}
      seedIntent={latestWorkspaceSeed?.intent ?? null}
      seedIntentOverride={null}
      hostScope={{ kind: "active" }}
    />
  );
  const switcher = (
    <button
      type="button"
      aria-label={
        draftComposerMode === "chat"
          ? "Switch to terminal mode"
          : "Switch to chat mode"
      }
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        setComposerMode(epicId, nextComposerMode(draftComposerMode));
      }}
    >
      <ArrowLeftRight className="size-3 shrink-0" />
      {draftComposerMode === "chat" ? "Switch to Terminal" : "Switch to Chat"}
    </button>
  );
  const header = (
    <NewConversationModalHeader
      composerMode={draftComposerMode}
      parentId={parentId}
      switcher={switcher}
    />
  );
  const cleanupAfterSubmit = useCallback((): void => {
    clearDraft(epicId);
    clearStagedIntent(stagingKey);
    editorRef.current?.clear();
    onSubmitted();
  }, [clearDraft, clearStagedIntent, epicId, onSubmitted, stagingKey]);
  const worktreeIntentForSubmit = useCallback(
    (): WorktreeIntent | null =>
      effectiveWorktreeIntent({
        workspace: draftWorkspace,
        seedIntent: latestWorkspaceSeed?.intent ?? null,
        stagedIntent: readStagedWorktreeIntent(stagingKey),
      }),
    [draftWorkspace, latestWorkspaceSeed, stagingKey],
  );
  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const editor = editorRef.current;
    if (editor === null) return;
    const toolbar = toolbarStore.getState();
    if (toolbar.selection.modelSlug.length === 0) return;
    const settings = buildChatRunSettings({
      selection: toolbar.selection,
      permission: toolbar.permission,
      reasoning: toolbar.reasoning,
      serviceTier: toolbar.serviceTier,
      agentMode: toolbar.agentMode,
    });
    if (settings.model.length === 0) return;
    // Global, single-selection billing context captured at create time; it
    // rides as a sibling of the per-chat settings on the initial message.
    const accountContext = useAccountContextStore.getState().accountContext;
    // Resolve the host BEFORE any persistent write: canSubmit gates on the
    // permission role + workspace, not the active host, so the host can be null
    // here (dropped after the modal opened). Bailing after writing last-run
    // would pollute it for a chat that is never created and strand the modal
    // open with no feedback - mirror the landing flow's host-first toast.
    const activeHostId = hostClient.getActiveHostId();
    if (activeHostId === null) {
      toast.error("Couldn't start the chat.", {
        description: "No active device. Reconnect and try again.",
      });
      return;
    }
    const content = buildSubmittedChatJSONContent(editor.getJSON());
    const chatId = uuidv4();
    const messageId = uuidv4();
    const clientActionId = uuidv4();
    const now = Date.now();
    // Remember these settings as the epic's (and global) last-run so the next
    // new-chat carries them forward, mirroring the chat-tile composer's
    // on-send write.
    setGlobalRunSettings(settings, now);
    setEpicRunSettings(epicId, settings, now);
    const profile = useAuthStore.getState().profile;
    const userId = profile?.userId ?? null;
    const worktreeIntent = worktreeIntentForSubmit();
    const workspaceMode = deriveWorkspaceMode(
      draftWorkspaceFolderCount,
      worktreeIntent,
    );
    if (worktreeIntent !== null) {
      rememberEpicIntent(epicId, worktreeIntent, now);
    }
    useInitialChatHandoffStore.getState().register({
      hostId: activeHostId,
      userId,
      epicId,
      chatId,
      content,
      settings,
      worktreeIntent,
      placement,
      messageId,
      clientActionId,
      createdAt: now,
    });
    const initialMessage =
      userId === null
        ? null
        : {
            messageId,
            clientActionId,
            content,
            sender: { type: "user" as const, userId },
            settings,
            accountContext,
          };
    if (initialMessage !== null) {
      useEpicCanvasStore.getState().markChatTitlePending(chatId, "");
    }
    createChat.mutate(
      {
        epicId,
        parentId,
        title: "",
        chatId,
        settings,
        workspaceMode,
        worktreeIntent,
        initialMessage,
      },
      {
        onSuccess: (response) => {
          if (response.initialTurnStarted === true) {
            useInitialChatHandoffStore
              .getState()
              .markInitialTurnStarted(
                { hostId: activeHostId, userId, epicId },
                chatId,
              );
          }
        },
        onError: () => {
          useEpicCanvasStore.getState().clearChatTitlePending(chatId);
          useInitialChatHandoffStore
            .getState()
            .markFailed(
              { hostId: activeHostId, userId, epicId },
              "Couldn't create the chat.",
            );
        },
      },
    );
    cleanupAfterSubmit();
  }, [
    canSubmit,
    cleanupAfterSubmit,
    createChat,
    draftWorkspaceFolderCount,
    epicId,
    hostClient,
    parentId,
    placement,
    rememberEpicIntent,
    setEpicRunSettings,
    setGlobalRunSettings,
    toolbarStore,
    worktreeIntentForSubmit,
  ]);
  const handleStartTerminal = useCallback(
    (launch: TerminalAgentLaunch) => {
      if (!canMutate || !workspaceCanStart) return;
      const worktreeIntent = worktreeIntentForSubmit();
      const workspaceMode = deriveWorkspaceMode(
        draftWorkspaceFolderCount,
        worktreeIntent,
      );
      if (worktreeIntent !== null) {
        rememberEpicIntent(epicId, worktreeIntent, Date.now());
      }
      cleanupAfterSubmit();
      void terminalAgentCreate
        .create({
          epicId,
          tabId,
          parentId,
          title: "",
          placement: toTuiPlacement(placement),
          harnessId: launch.harnessId,
          model: launch.model,
          reasoningEffort: launch.reasoningEffort,
          agentMode: launch.agentMode,
          forkSourceHarnessSessionId: null,
          onStatusChange: null,
          worktreeIntent,
          workspaceMode,
          terminalAgentArgs: launch.terminalAgentArgs,
        })
        .catch(() => undefined);
    },
    [
      canMutate,
      cleanupAfterSubmit,
      draftWorkspaceFolderCount,
      epicId,
      parentId,
      placement,
      rememberEpicIntent,
      tabId,
      terminalAgentCreate,
      worktreeIntentForSubmit,
      workspaceCanStart,
    ],
  );
  const handleSnapshot = useCallback(
    (content: JsonContent, _selection: { from: number; to: number }) => {
      setContent(epicId, content);
    },
    [epicId, setContent],
  );
  const handleRemoveImage = useCallback((id: string) => {
    editorRef.current?.removeImageAttachmentById(id);
  }, []);
  return (
    <ComposerBody
      pickerStore={pickerStore}
      editorRef={editorRef}
      toolbarStore={toolbarStore}
      composerMode={draftComposerMode}
      chatEditorIsActive={chatComposerActive}
      editorClassName={COMPOSER_EDITOR_CLASSNAME}
      initialContent={initialContent}
      initialSelection={null}
      canSubmit={canSubmit}
      isSubmitting={isSubmitting}
      workspaceDisabledHint={composerDisabledHint}
      header={header}
      attachmentsStrip={
        <NewConversationModalAttachmentStrip
          epicId={epicId}
          seedContent={seed.content}
          onRemoveImage={handleRemoveImage}
        />
      }
      workspaceControls={workspaceControls}
      dictationControl={dictationControl}
      dictationPreparing={dictationPreparing}
      paste={paste}
      onSubmit={handleSubmit}
      onStartTerminal={handleStartTerminal}
      onSnapshot={handleSnapshot}
    />
  );
}

/**
 * Workspace seed that drives the modal's workspace controls + submit intent.
 * For a child (per-row `+`, `parentId !== null`) it inherits the PARENT's
 * binding so the child lands in the parent's worktree. The parent may be a chat
 * OR a terminal agent (both live in the chats tree), so its real owner kind
 * drives the binding lookup. Read on the active host (the modal always creates
 * there); an unbound/remote parent falls back to an empty workspace the user can
 * adjust via the controls. For a top-level chat it uses the latest-conversation
 * seed.
 */
function useModalWorkspaceSeed(
  epicId: string,
  parentId: string | null,
): LatestConversationWorkspaceSeed | null {
  const hostClient = useHostClient();
  // Only read the latest-conversation seed for a top-level chat; a child must
  // never inherit an unrelated conversation's worktree (see below), so skip the
  // binding read entirely when adding a child.
  const latestConversationSeed = useLatestConversationWorkspaceSeed(
    parentId === null ? epicId : null,
  );
  // The parent can be a chat or a terminal agent; read its real kind so the
  // binding lookup matches. Defaulting to "chat" would miss a terminal-agent
  // parent's binding and seed the child from the wrong/empty workspace.
  const parentOwnerKind = useEpicNodeOwnerKind(parentId ?? "");
  const parentWorkspaceFolders = useEpicNodeWorkspaceFolders(parentId ?? "");
  const parentInheritance = useOwnerWorkspaceInheritanceSeed({
    client: hostClient,
    epicId,
    ownerId: parentId ?? "",
    ownerKind: parentOwnerKind,
    enabled: parentId !== null,
    fallbackWorkspaceFolders: parentWorkspaceFolders,
  });
  return useMemo<LatestConversationWorkspaceSeed | null>(() => {
    // Top-level: seed from the latest conversation.
    if (parentId === null) return latestConversationSeed;
    // Child: inherit ONLY from the parent's binding. When that resolves empty
    // (an unbound parent) return null so the modal falls back to the
    // empty/global workspace the user can adjust - never the latest-conversation
    // seed, which would drop the child into an unrelated worktree.
    if (parentInheritance.seed === null) return null;
    return {
      ...parentInheritance.seed,
      sourceOwnerId: parentId,
      sourceOwnerKind: parentOwnerKind ?? "chat",
    };
  }, [
    latestConversationSeed,
    parentId,
    parentInheritance.seed,
    parentOwnerKind,
  ]);
}

function useNewConversationModalSeed(
  epicId: string,
  latestWorkspaceSeed: LatestConversationWorkspaceSeed | null,
): NewConversationModalSeed {
  const latestSettingsSeed = useLatestConversationSettingsSeed();
  const globalWorkspace = useGlobalWorkspaceSnapshot();
  // Carry forward the last settings used on this epic (the chat-tile composer
  // writes `setEpicRunSettings` on send), then the cross-epic last-run, then
  // the projected latest-conversation settings as a final fallback.
  const runSettingsSeed = useComposerRunSettingsStore(
    useShallow((state) => ({
      epicRunSettings: Object.hasOwn(state.epicRunSettingsByEpicId, epicId)
        ? state.epicRunSettingsByEpicId[epicId].settings
        : null,
      globalLastRunSettings: state.globalLastRunSettings,
    })),
  );
  return useMemo(
    () => ({
      content: createEmptyNewConversationContent(),
      settings:
        runSettingsSeed.epicRunSettings ??
        runSettingsSeed.globalLastRunSettings ??
        latestSettingsSeed.settings,
      composerMode: latestSettingsSeed.composerMode,
      workspace: latestWorkspaceSeed?.workspace ?? globalWorkspace,
    }),
    [globalWorkspace, latestSettingsSeed, latestWorkspaceSeed, runSettingsSeed],
  );
}

function useLatestConversationSettingsSeed(): {
  readonly settings: ChatRunSettings | null;
  readonly composerMode: ComposerMode;
} {
  const projection = useEpicStore(
    useShallow((state) => ({
      chats: state.chats,
      tuiAgents: state.tuiAgents,
    })),
  );
  const fallbackComposerMode = useSettingsStore((state) => state.composerMode);
  const defaults = useSettingsStore(
    useShallow((state) => ({
      defaultPermission: state.defaultPermission,
      defaultServiceTier: state.defaultServiceTier,
    })),
  );
  return useMemo(() => {
    const latest = latestCreatedConversationOwner(projection);
    if (latest === null) {
      return {
        settings: null,
        composerMode: fallbackComposerMode,
      };
    }
    if (latest.ownerKind === "chat") {
      return {
        settings: projection.chats.byId[latest.id].settings ?? null,
        composerMode: "chat",
      };
    }
    const agent = projection.tuiAgents.byId[latest.id];
    return {
      settings: {
        harnessId: agent.harnessId,
        model: agent.model ?? "",
        permissionMode: defaults.defaultPermission,
        reasoningEffort: agent.reasoningEffort,
        serviceTier:
          defaults.defaultServiceTier.trim().length === 0
            ? null
            : defaults.defaultServiceTier,
        agentMode: agent.agentMode,
        // TUI agents carry no billing context; seed Personal (the store
        // default). The composer lets the user switch before sending.
        accountContext: { type: "PERSONAL" },
      },
      composerMode: "terminal",
    };
  }, [defaults, fallbackComposerMode, projection]);
}

function useGlobalWorkspaceSnapshot(): LandingDraftWorkspaceSnapshot {
  return useWorkspaceFoldersStore(
    useShallow((state) => ({
      folders: state.folders,
      folderInfoByPath: state.folderInfoByPath,
    })),
  );
}

function toTuiPlacement(
  placement: ConversationTilePlacement,
): TuiAgentPlacement {
  if (placement.kind === "target-group") {
    return { kind: "target-group", groupId: placement.groupId };
  }
  if (placement.kind === "split") {
    // Terminal agents can't occupy a split. Open into the group the split was
    // anchored on (a valid TUI placement) rather than discarding the location
    // and falling all the way back to the active tile.
    return { kind: "target-group", groupId: placement.groupId };
  }
  return { kind: "active-tile" };
}

function effectiveWorktreeIntent(input: {
  readonly workspace: LandingDraftWorkspaceSnapshot;
  readonly seedIntent: WorktreeIntent | null;
  readonly stagedIntent: WorktreeIntent | null;
}): WorktreeIntent | null {
  const fallback =
    input.seedIntent ??
    buildForkWorkspaceSeedFromWorkspaceFolders(input.workspace.folders).intent;
  if (input.stagedIntent === null) {
    return trimIntentToWorkspace(input.workspace, fallback);
  }
  const fallbackByPath = intentEntriesByWorkspacePath(fallback);
  const stagedByPath = intentEntriesByWorkspacePath(input.stagedIntent);
  const entries = input.workspace.folders.flatMap((workspacePath, index) => {
    const entry =
      stagedByPath.get(workspacePath) ?? fallbackByPath.get(workspacePath);
    if (entry === undefined) {
      return localIntentEntry(input.workspace, workspacePath, index);
    }
    return [{ ...entry, isPrimary: index === 0 }];
  });
  return entries.length === 0 ? null : { entries };
}

function trimIntentToWorkspace(
  workspace: LandingDraftWorkspaceSnapshot,
  intent: WorktreeIntent | null,
): WorktreeIntent | null {
  const intentByPath = intentEntriesByWorkspacePath(intent);
  const entries = workspace.folders.flatMap((workspacePath, index) => {
    const entry = intentByPath.get(workspacePath);
    if (entry === undefined) {
      return localIntentEntry(workspace, workspacePath, index);
    }
    return [{ ...entry, isPrimary: index === 0 }];
  });
  return entries.length === 0 ? null : { entries };
}

function localIntentEntry(
  workspace: LandingDraftWorkspaceSnapshot,
  workspacePath: string,
  index: number,
): WorktreeFolderIntent[] {
  if (!Object.hasOwn(workspace.folderInfoByPath, workspacePath)) return [];
  const folder = workspace.folderInfoByPath[workspacePath];
  return [
    {
      kind: "local",
      workspacePath,
      repoIdentifier: folder.repoIdentifier,
      isPrimary: index === 0,
    },
  ];
}

function intentEntriesByWorkspacePath(
  intent: WorktreeIntent | null,
): ReadonlyMap<string, WorktreeFolderIntent> {
  return new Map(
    intent?.entries.map((entry) => [entry.workspacePath, entry]) ?? [],
  );
}
