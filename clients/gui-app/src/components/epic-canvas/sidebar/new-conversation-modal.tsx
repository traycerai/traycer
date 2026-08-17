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
import { Plus, XIcon } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";

import {
  AttachmentStrip,
  NO_SESSION_OBJECT_URL,
} from "@/components/chat/composer/attachments/attachment-strip";
import {
  useEpicAttachmentBytesPresence,
  useEpicImageFetcher,
} from "@/lib/attachments/use-attachment-blob-src";
import { DialogOverlayBoundaryContext } from "@/providers/dialog-overlay-boundary-context";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import {
  NewConversationTransientContext,
  useNewConversationTransient,
  type NewConversationTransientState,
} from "./new-conversation-transient-context";
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
  useCreateTuiAgentForClient,
  type TuiAgentPlacement,
} from "@/hooks/agent/use-create-tui-agent";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useLeaderScopeAbsorber } from "@/hooks/keybindings/use-leader-scope-absorber";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import {
  isAttachmentIngestPending,
  useComposerPaste,
} from "@/hooks/composer/use-composer-paste";
import {
  mentionRootsFromWorktreeIntent,
  useWorkspaceMentionRoots,
} from "@/hooks/composer/use-workspace-mention-roots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import {
  latestCreatedConversationOwner,
  useLatestConversationWorkspaceSeed,
  type LatestConversationWorkspaceSeed,
} from "@/hooks/worktree/use-latest-conversation-workspace-seed";
import { useOwnerWorkspaceInheritanceSeed } from "@/hooks/worktree/use-owner-workspace-inheritance-seed";
import { useEpicStore } from "@/hooks/use-epic-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { LEADER_SCOPE_NEW_CONVERSATION_MODAL } from "@/lib/keybindings/leader-scope";
import {
  useEpicConnectionStatus,
  useEpicNodeOwnerKind,
  useEpicNodeWorkspaceFolders,
  useEpicPermissionRole,
} from "@/lib/epic-selectors";
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
import { effectiveWorktreeIntent } from "@/lib/worktree/effective-worktree-intent";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import { cn } from "@/lib/utils";
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { modalWorkspaceHostScope } from "./new-conversation-modal-host-scope";
import { ComposerBody } from "@/components/home/composer/composer-body";
import { ComposerModeSwitcher } from "@/components/home/composer/composer-mode-switcher";
import { COMPOSER_EDITOR_CLASSNAME } from "@/components/home/composer/composer-editor-classnames";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  nextComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
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
import {
  selectEpicRunSettingsEntry,
  selectGlobalLastRunSettings,
  useComposerRunSettingsStore,
} from "@/stores/composer/composer-run-settings-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  newConversationModalStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import { PromptStashControl } from "@/components/chat/composer/prompt-stash-control";
import {
  useNewConversationPromptStashDestination,
  useNewConversationPromptStashSource,
} from "./use-new-conversation-prompt-stash-adapters";

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
  readonly onBeforeOpen: (() => void) | undefined;
}

/**
 * The single "+" trigger for the New Conversation modal, shared by the chats
 * panel header (top-level) and each chat row (child). The modal opens with its
 * remembered draft mode, falling back to the latest conversation's interface
 * when there is no draft, so a terminal-agent launch carries forward just like
 * a chat launch. The modal's own switcher remains the one way to change modes.
 */
export function NewConversationModalAction(
  props: NewConversationModalActionProps,
) {
  const { disabled, epicId, onBeforeOpen, parentId, tabId } = props;
  const openModal = useNewConversationModalOpenStore((state) => state.open);
  const handleOpen = useCallback((): void => {
    if (disabled) return;
    onBeforeOpen?.();
    openModal({
      epicId,
      tabId,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId,
      // App-wide trigger: the sidebar sits outside every `TabHostProvider`, so
      // the conversation belongs on whichever host is active.
      hostId: null,
    });
  }, [disabled, epicId, onBeforeOpen, openModal, parentId, tabId]);
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
      hostId={isOpen ? request.hostId : null}
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
  readonly hostId: string | null;
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
  // The composer picker store outlives the body's focus-driven unmount. A fresh
  // store is minted each time the modal opens, so a reopened modal starts clean,
  // while it survives focus toggles within one open session (this dialog stays
  // mounted throughout).
  const [transientSession, setTransientSession] = useState<
    NewConversationTransientState & { readonly open: boolean }
  >(() => ({
    open: props.open,
    pickerStore: createComposerPickerStore(),
  }));
  if (props.open !== transientSession.open) {
    setTransientSession((prev) =>
      props.open
        ? { open: true, pickerStore: createComposerPickerStore() }
        : { ...prev, open: false },
    );
  }
  const transient = useMemo<NewConversationTransientState>(
    () => ({ pickerStore: transientSession.pickerStore }),
    [transientSession.pickerStore],
  );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        ref={setOverlayBoundaryEl}
        className="w-[min(92vw,48rem)] max-w-[min(92vw,48rem)] gap-3 p-4 sm:max-w-[min(92vw,48rem)]"
        data-testid="epic-sidebar-new-conversation-modal"
        data-leader-scope={LEADER_SCOPE_NEW_CONVERSATION_MODAL}
        // Same portal rule as the worktree pickers: the host switcher's list
        // mounts outside this dialog, so a click in it reads as an interaction
        // from outside. Dismissing on that would throw away the form someone is
        // in the middle of filling, for the crime of choosing a host in it.
        onInteractOutside={(event) => {
          if (isHostSwitcherListInteraction(event.target)) {
            event.preventDefault();
          }
        }}
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
        <DialogTitle className="sr-only">New agent</DialogTitle>
        {props.open ? (
          <DialogOverlayBoundaryContext.Provider value={overlayBoundaryEl}>
            <SurfaceActivityProvider active>
              <NewConversationTransientContext.Provider value={transient}>
                <NewConversationModalBody
                  epicId={props.epicId}
                  tabId={props.tabId}
                  placement={props.placement}
                  parentId={props.parentId}
                  hostId={props.hostId}
                  dismissPickerRef={dismissPickerRef}
                  onSubmitted={() => props.onOpenChange(false)}
                />
              </NewConversationTransientContext.Provider>
            </SurfaceActivityProvider>
          </DialogOverlayBoundaryContext.Provider>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function NewConversationModalHeader(props: {
  readonly switcher: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <span className="text-sm font-medium text-foreground">
        Start a new agent
      </span>
      {props.switcher}
    </div>
  );
}

/**
 * Stand-in host id for the terminal-agent create, used only until the
 * projection carries the real binding - see `useCreateTuiAgent`.
 */
function placeholderHostIdFor(
  client: HostClient<HostRpcRegistry> | null,
): string {
  return client?.getActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
}

export function NewConversationModalBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly placement: ConversationTilePlacement;
  readonly parentId: string | null;
  /** Host to create on; `null` follows the app-wide active host. */
  readonly hostId: string | null;
  readonly dismissPickerRef: RefObject<(() => boolean) | null>;
  readonly onSubmitted: () => void;
}) {
  const {
    epicId,
    tabId,
    placement,
    parentId,
    hostId,
    dismissPickerRef,
    onSubmitted,
  } = props;
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const isDisconnected = connectionStatus === "closed";
  const canMutate = isEditableRole(permissionRole) && !isDisconnected;
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  // The picker store is lifted onto the always-mounted dialog so it survives
  // this body's focus-driven unmount (see the transient context); the hook falls
  // back to a local store when rendered outside the dialog.
  const { pickerStore } = useNewConversationTransient();
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
  // Every host-derived surface below - workspace seed and controls, profile
  // validation, picker items, and both create paths - hangs off this one
  // client, so a pinned request cannot leave some of them on the active host
  // and the rest on the pinned one. `null` resolves to the app-wide default.
  const hostClient = useHostClientForHostId(hostId);
  // The host whose per-host memory (last-run settings) this modal reads and
  // writes: the pinned host when one was passed, else the app-wide active
  // host. The reactive read is only CONSUMED in the null-prop case - the
  // modal opened from the app-wide sidebar, which sits outside every
  // `TabHostProvider` - so a pinned modal never follows an active-host swap.
  const reactiveActiveHostId = useReactiveActiveHostId();
  const memoryHostId = hostId ?? reactiveActiveHostId;
  const latestWorkspaceSeed = useModalWorkspaceSeed({
    epicId,
    parentId,
    hostId,
    resolvedHostId: memoryHostId,
    hostClient,
  });
  const seed = useNewConversationModalSeed(
    epicId,
    memoryHostId,
    latestWorkspaceSeed,
  );
  // Subscribe to the NON-content draft fields only. `content` is rewritten on
  // every keystroke (see `handleDocumentChange`); subscribing to the whole
  // patch here would re-render the entire modal body per character. Live
  // content is routed to an isolated subscriber
  // (`NewConversationModalAttachmentStrip`) plus a boolean submit gate,
  // mirroring the landing composer's isolation.
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
  // Reseed the caret from the draft store on every (re)mount, so a focus
  // round-trip that unmounts this body restores the selection, not just bytes.
  const [initialSelection] = useState<{ from: number; to: number } | null>(
    () =>
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
        ?.selection ?? null,
  );
  const stagingKey = useMemo(
    () => newConversationModalStagingKey(memoryHostId, epicId, parentId),
    [epicId, memoryHostId, parentId],
  );
  const stagingKeyId = worktreeStagingKeyString(stagingKey);
  const stagedIntent = useWorktreeIntentStagingStore(
    (state) => state.intentByKey[stagingKeyId] ?? null,
  );
  const setContent = useNewConversationModalStore((state) => state.setContent);
  const setSelection = useNewConversationModalStore(
    (state) => state.setSelection,
  );
  const setSettings = useNewConversationModalStore(
    (state) => state.setSettings,
  );
  const setComposerMode = useNewConversationModalStore(
    (state) => state.setComposerMode,
  );
  const clearDraft = useNewConversationModalStore((state) => state.clearDraft);
  // The modal's host can change under an open session, so a SUBMIT consumes
  // every host's copy of the slot - not just the one selected at submit.
  const clearStagedIntent = useWorktreeIntentStagingStore(
    (state) => state.clearForAllHosts,
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
  // `draftSettings` can fall back to `runSettingsSeed`/`latestSettingsSeed`
  // (see `useNewConversationModalSeed`), neither of which is host-scoped or
  // kept in sync with live profile removals - validated against the host this
  // modal creates on (`hostClient`: the pinned host, else the active one) via
  // the same machinery `useComposerToolbarStore` runs for every composer
  // surface. Never authoritative: this modal has no reauth gate of its own,
  // so a genuinely-removed profile must be corrected to ambient here rather
  // than silently submitted as the new chat/agent's initial settings. The
  // catalog reads through that same client, so a pinned modal offers the
  // pinned host's harnesses/models, not the active host's.
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(draftSettings, hostClient),
    handleToolbarSettingsChange,
    {
      hostClient,
      hostId: memoryHostId,
      tuiOnly: draftComposerMode === "terminal",
    },
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
  const mentionRoots = useWorkspaceMentionRoots(
    rawMentionRoots,
    false,
    memoryHostId,
  );
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

  const createChat = useEpicCreateChatForHostClient(hostClient);
  const terminalAgentCreate = useCreateTuiAgentForClient(
    hostClient,
    placeholderHostIdFor(hostClient),
  );
  const isSubmitting = createChat.isPending || terminalAgentCreate.isPending;
  const resolvedWorkspace = useResolvedWorkspaceFolders(
    draftWorkspace,
    hostClient,
    memoryHostId,
  );
  const workspaceAvailability = useMemo(
    () =>
      deriveFolderlessAllowedWorkspaceAvailability(
        resolvedWorkspace.folders,
        resolvedWorkspace.isLoading,
        resolvedWorkspace.isError,
      ),
    [
      resolvedWorkspace.folders,
      resolvedWorkspace.isLoading,
      resolvedWorkspace.isError,
    ],
  );
  const workspaceCanStart = workspaceComposerCanStart(workspaceAvailability);
  const draftWorkspaceFolderCount = draftWorkspace.folders.length;
  const runnerHost = useRunnerHost();
  const paste = useComposerPaste(editorRef, runnerHost.fileDrops, mentionRoots);
  const attachmentPending = isAttachmentIngestPending(paste);
  const canSubmit =
    canMutate &&
    !isSubmitting &&
    !attachmentPending &&
    workspaceCanStart &&
    hasSubmittableContent;
  const composerDisabledHint =
    mutationDisabledHint(permissionRole, isDisconnected, "make changes") ??
    workspaceAvailability.disabledHint;
  const hasPastedImageBytes = useEpicAttachmentBytesPresence();
  const fetchEpicImage = useEpicImageFetcher();
  const readPromptStashImage = useCallback(
    async (hash: string) => {
      if (hasPastedImageBytes?.(hash) !== true) return null;
      // Capture deliberately survives composer unmount, so this read is not
      // coupled to component-lifecycle cancellation.
      const read = await fetchEpicImage(hash, new AbortController().signal);
      return new Uint8Array(read.bytes);
    },
    [fetchEpicImage, hasPastedImageBytes],
  );
  const promptStashSource = useNewConversationPromptStashSource({
    epicId,
    seedContent: seed.content,
    editorRef,
  });
  const promptStashDestination = useNewConversationPromptStashDestination({
    epicId,
    seedContent: seed.content,
    editorRef,
  });
  const promptStash = usePromptStash({
    // Registered for the modal's whole open lifetime, not just chat mode:
    // unregistering on every chat<->terminal toggle would hand the top of
    // the stack back to whatever composer sits beneath this modal (see
    // `active-prompt-stash-registry.ts`), letting Cmd+S mutate a hidden
    // draft. `disabled` below suppresses the action itself while the modal
    // owns no stashable content, without giving up ownership of the slot.
    active: true,
    disabled: promptStashDisabled({
      isSubmitting,
      attachmentPending,
      chatComposerActive,
    }),
    editorRef,
    readHashImage: readPromptStashImage,
    source: promptStashSource,
    destination: promptStashDestination,
  });
  const { dictationControl, dictationPreparing } = useComposerDictation({
    editorRef,
    isActive: chatComposerActive,
  });
  // A pinned request keeps the workspace picker on the same host the chat will
  // be created on; without it the user could pick a folder that does not exist
  // over there.
  const workspaceHostScope = useMemo<HostWorkspaceControlsHostScope>(
    () => modalWorkspaceHostScope(hostId, hostClient),
    [hostClient, hostId],
  );
  const workspaceControls = (
    <ActiveHostWorkspaceControls
      disabled={false}
      stagingKey={stagingKey}
      layout="inline"
      workspaceSeed={draftWorkspace}
      seedIntent={latestWorkspaceSeed?.intent ?? null}
      seedIntentOverride={null}
      hostScope={workspaceHostScope}
    />
  );
  const switcher = (
    <ComposerModeSwitcher
      composerMode={draftComposerMode}
      disabled={false}
      onSwitch={() => {
        setComposerMode(epicId, nextComposerMode(draftComposerMode));
      }}
    />
  );
  const header = <NewConversationModalHeader switcher={switcher} />;
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
    const activeHostId = hostClient?.getActiveHostId() ?? null;
    if (activeHostId === null) {
      reportableErrorToast(
        "Couldn't start the agent.",
        {
          description: "No active device. Reconnect and try again.",
        },
        {
          title: "Could not start agent",
          message: "No active device was available.",
          code: null,
          source: "Chat",
        },
      );
      return;
    }
    // The staged intent this submit is about to read is keyed by
    // `memoryHostId`, resolved at RENDER time; `activeHostId` above comes off
    // the live client. For an unpinned modal those diverge in the window
    // between the app-wide host changing and this component re-rendering, and
    // a click landing there would read host A's staged pick and then create,
    // key its run settings and remember its intent on host B. Fail closed, as
    // the landing composer does: the modal stays open with its draft and
    // staged pick intact, so a retry lands on the settled host.
    //
    // Inert in two cases that are NOT drift: a pinned modal, whose client
    // reports its own pinned host, and a render-time host of `null` - the
    // binding has not published one yet, so the staged slot is the
    // unresolved-host bucket and the memory writes already no-op. Nothing
    // host-specific was captured there to mis-file.
    if (memoryHostId !== null && activeHostId !== memoryHostId) {
      reportableErrorToast(
        "Couldn't create the conversation.",
        {
          description:
            "The active device changed while this was being prepared. Try again.",
        },
        {
          title: "Could not create conversation",
          message: "Active device changed mid-submission.",
          code: null,
          source: "Chat",
        },
      );
      return;
    }
    const content = buildSubmittedChatJSONContent(
      editor.getJSON(),
      pickerStore.getState().knownSlashCommands,
    );
    const chatId = uuidv4();
    const messageId = uuidv4();
    const clientActionId = uuidv4();
    const now = Date.now();
    // Remember these settings as the epic's (and global) last-run so the next
    // new-chat carries them forward, mirroring the chat-tile composer's
    // on-send write. Keyed by the host the chat is actually created on
    // (`activeHostId`: the pinned host, else the active one resolved above).
    setGlobalRunSettings(activeHostId, settings, now);
    setEpicRunSettings(epicId, activeHostId, settings, now);
    const profile = useAuthStore.getState().profile;
    const userId = profile?.userId ?? null;
    const worktreeIntent = worktreeIntentForSubmit();
    const workspaceMode = deriveWorkspaceMode(
      draftWorkspaceFolderCount,
      worktreeIntent,
    );
    if (worktreeIntent !== null) {
      rememberEpicIntent(epicId, activeHostId, worktreeIntent, now);
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
        // The host the modal resolved its own client for, checked non-null
        // just above - the machine the user picked, not the app-wide active
        // one (they diverge for a row-scoped child create).
        hostId: activeHostId,
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
              "Couldn't create the agent.",
            );
        },
      },
    );
    cleanupAfterSubmit();
  }, [
    canSubmit,
    cleanupAfterSubmit,
    createChat,
    memoryHostId,
    pickerStore,
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
      // Same host-first gate as `handleSubmit`: with no resolved client (a
      // pinned host still connecting, or no active device) the create below
      // can only reject - and the draft would already be gone, because
      // `cleanupAfterSubmit` runs before the async create. Keep the modal
      // open and the draft intact instead.
      const activeHostId = hostClient?.getActiveHostId() ?? null;
      if (activeHostId === null) {
        reportableErrorToast(
          "Couldn't start the agent.",
          {
            description: "No active device. Reconnect and try again.",
          },
          {
            title: "Could not start agent",
            message: "No active device was available.",
            code: null,
            source: "Chat",
          },
        );
        return;
      }
      // Same render-time vs live host drift as `handleSubmit` - see there.
      if (memoryHostId !== null && activeHostId !== memoryHostId) {
        reportableErrorToast(
          "Couldn't start the agent.",
          {
            description:
              "The active device changed while this was being prepared. Try again.",
          },
          {
            title: "Could not start agent",
            message: "Active device changed mid-submission.",
            code: null,
            source: "Chat",
          },
        );
        return;
      }
      const worktreeIntent = worktreeIntentForSubmit();
      const workspaceMode = deriveWorkspaceMode(
        draftWorkspaceFolderCount,
        worktreeIntent,
      );
      if (worktreeIntent !== null) {
        rememberEpicIntent(epicId, activeHostId, worktreeIntent, Date.now());
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
          forkSourceHarnessSessionId: null,
          sourceTuiAgentId: null,
          sourceProfileId: null,
          onStatusChange: null,
          worktreeIntent,
          workspaceMode,
          terminalAgentArgs: launch.terminalAgentArgs,
          profileId: launch.profileId,
        })
        .catch(() => undefined);
    },
    [
      canMutate,
      cleanupAfterSubmit,
      memoryHostId,
      draftWorkspaceFolderCount,
      epicId,
      hostClient,
      parentId,
      placement,
      rememberEpicIntent,
      tabId,
      terminalAgentCreate,
      worktreeIntentForSubmit,
      workspaceCanStart,
    ],
  );
  usePrimaryActionShortcut(chatComposerActive, handleSubmit);
  const handleDocumentChange = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      setContent(epicId, content);
      // Persist the caret alongside the bytes so a focus round-trip that
      // unmounts + remounts the editor restores it (see `initialSelection`).
      setSelection(epicId, selection);
    },
    [epicId, setContent, setSelection],
  );

  const handleSelectionChange = useCallback(
    (selection: { from: number; to: number }) => {
      setSelection(epicId, selection);
    },
    [epicId, setSelection],
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
      initialSelection={initialSelection}
      canSubmit={canSubmit}
      isSubmitting={isSubmitting}
      attachmentPending={attachmentPending}
      workspaceDisabledHint={composerDisabledHint}
      header={header}
      topBanner={null}
      stashControl={
        <PromptStashControl
          controller={promptStash}
          pickerStore={pickerStore}
        />
      }
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
      hasPastedImageBytes={hasPastedImageBytes}
      ingestPastedComposerImages={null}
      onEditorReady={null}
      // The pinned host (or `null` = active), the same id `hostClient` above
      // resolves - so the toolbar's and terminal launcher's pickers offer this
      // host's harnesses/models/profiles and create profiles on it.
      hostId={hostId}
      onSubmit={handleSubmit}
      onStartTerminal={handleStartTerminal}
      onDocumentChange={handleDocumentChange}
      onSelectionChange={handleSelectionChange}
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
function useModalWorkspaceSeed(args: {
  readonly epicId: string;
  readonly parentId: string | null;
  // The REQUEST's host: `null` means "follow the app-wide active host". The
  // latest-conversation seed reads it directly, because an unpinned modal
  // deliberately skips that seed entirely.
  readonly hostId: string | null;
  // `hostId` resolved against the active host - the host `hostClient` actually
  // speaks to. The parent's pending intent is staged under its CONCRETE host,
  // so reading that slot with the nullable request field would land in the
  // unresolved-host bucket and silently seed the child from the older binding.
  readonly resolvedHostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}): LatestConversationWorkspaceSeed | null {
  const { epicId, parentId, hostId, resolvedHostId, hostClient } = args;
  // Only read the latest-conversation seed for a top-level chat; a child must
  // never inherit an unrelated conversation's worktree (see below), so skip the
  // binding read entirely when adding a child. A pinned request reads the seed
  // from (and about) the pinned host, matching the create/picker below.
  const latestConversationSeed = useLatestConversationWorkspaceSeed(
    parentId === null ? epicId : null,
    hostId === null ? null : { hostId, hostClient },
  );
  // The parent can be a chat or a terminal agent; read its real kind so the
  // binding lookup matches. Defaulting to "chat" would miss a terminal-agent
  // parent's binding and seed the child from the wrong/empty workspace.
  const parentOwnerKind = useEpicNodeOwnerKind(parentId ?? "");
  const parentWorkspaceFolders = useEpicNodeWorkspaceFolders(parentId ?? "");
  const parentInheritance = useOwnerWorkspaceInheritanceSeed({
    client: hostClient,
    hostId: resolvedHostId,
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
  hostId: string | null,
  latestWorkspaceSeed: LatestConversationWorkspaceSeed | null,
): NewConversationModalSeed {
  const latestSettingsSeed = useLatestConversationSettingsSeed();
  const globalWorkspace = useGlobalWorkspaceSnapshot(hostId);
  // Carry forward the last settings used on this epic ON THIS HOST (the
  // chat-tile composer writes `setEpicRunSettings` on send), then the same
  // host's cross-epic last-run, then the projected latest-conversation
  // settings as a final fallback.
  const runSettingsSeed = useComposerRunSettingsStore(
    useShallow((state) => ({
      epicRunSettings:
        selectEpicRunSettingsEntry(state, epicId, hostId)?.settings ?? null,
      globalLastRunSettings: selectGlobalLastRunSettings(state, hostId),
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
        // Epic Mode was removed: seed the one remaining mode rather than
        // carrying a legacy value off the source agent.
        agentMode: "regular",
        profileId: agent.profileId,
        // TUI agents carry no billing context; seed Personal (the store
        // default). The composer lets the user switch before sending.
        accountContext: { type: "PERSONAL" },
      },
      composerMode: "terminal",
    };
  }, [defaults, fallbackComposerMode, projection]);
}

function useGlobalWorkspaceSnapshot(
  hostId: string | null,
): LandingDraftWorkspaceSnapshot {
  return useWorkspaceFoldersStore(
    useShallow((state) => {
      const bucket = selectWorkspaceFoldersBucket(state, hostId);
      return {
        folders: bucket.folders,
        folderInfoByPath: bucket.folderInfoByPath,
        primaryPath: bucket.primaryPath,
      };
    }),
  );
}

/**
 * `usePromptStash`'s `disabled` flag stays true for the modal's whole
 * terminal-mode span, not just while a save/paste is in flight - see the
 * call site's comment on why `active` no longer tracks `chatComposerActive`.
 * Extracted (rather than inlined at the call site) to keep
 * `NewConversationModalBody` under the complexity lint threshold.
 */
function promptStashDisabled(args: {
  readonly isSubmitting: boolean;
  readonly attachmentPending: boolean;
  readonly chatComposerActive: boolean;
}): boolean {
  return (
    args.isSubmitting || args.attachmentPending || !args.chatComposerActive
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
