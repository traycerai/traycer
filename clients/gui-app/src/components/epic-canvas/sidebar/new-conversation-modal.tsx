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
import { useEpicConversationPlacement } from "@/hooks/host/use-composer-placement";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { resolveLandingPlacement } from "@/lib/composer/landing-placement";
import { toastRepointedStagingReset } from "@/lib/composer/repointed-staging-toast";
import { subscribeFollowingSurfaceReset } from "@/stores/host/surface-host-selection-store";
import { ComposerHostNotice } from "@/components/home/composer/composer-host-notice";
import { useComposerHostNotice } from "@/hooks/composer/use-composer-host-notice";
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
  anyHostHasStagedWorktreeIntent,
  newConversationModalStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
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
      // Names no host: the modal resolves its own per-EPIC placement (this
      // Epic's last created chat's host, else the host the Epic is served
      // from - `useEpicConversationPlacement`), with the picker live. Naming
      // one here would freeze the picker (§55) for a trigger that has no
      // machine in mind.
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
  // and the rest on the pinned one.
  //
  // A request that names no host is a PLACEMENT composer with the same chip
  // and picker as the landing one, resolved for THIS EPIC (user ruling
  // 2026-08-18): `pin(epic) ?? the Epic session's host ?? effective`, where
  // the per-Epic pin is this Epic's "last created chat's host" - written by
  // the picker and RE-RECORDED on every create below (`recordPlacement`), the
  // way the model picker's memory is. So a new agent in this Epic opens on
  // the host the last one was created on, or - before any - on the host the
  // Epic is served from. Resolving the window's landing pin instead (what
  // this used to share) answered "where did the landing chip last point",
  // which is not a fact about this Epic. A request that DOES name a host
  // keeps it, with the picker inert (§55).
  //
  // Same placement UNIT as the landing composer: the READ client for this
  // body's queries, the host-FROZEN client every create below is sent on, and
  // the submit-time refusal all come out of one hook.
  const sessionHostId = useEpicSessionHostId();
  const composerPlacement = useEpicConversationPlacement({
    epicId,
    overrideHostId: hostId,
    sessionHostId,
  });
  const resolvedHostId = composerPlacement.target.resolvedHostId;
  const hostClient = composerPlacement.target.client;
  const submitTarget = composerPlacement.submitTarget;
  const composerFollowsEffective = composerPlacement.followsEffective;
  const hostLabelFor = composerPlacement.hostLabelFor;
  // "Last created chat's host": every create in this modal writes the Epic's
  // placement memory with the host it resolved, at SUBMIT (beside the settings
  // memory) rather than on the create's success - the model picker's memory
  // is written the same way. A caller-named host is recorded too: the rule is
  // the last CREATED chat's host, whoever named it.
  const recordPlacement = composerPlacement.pin.setSelection;
  const latestWorkspaceSeed = useModalWorkspaceSeed({
    epicId,
    parentId,
    resolvedHostId,
    hostClient,
  });
  const seed = useNewConversationModalSeed(
    epicId,
    resolvedHostId,
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
    () => newConversationModalStagingKey(resolvedHostId, epicId, parentId),
    [epicId, resolvedHostId, parentId],
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
      hostId: resolvedHostId,
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
    resolvedHostId,
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

  // Creates bind to the SUBMIT client: host-frozen for the resolved host, so a
  // derivation move between two awaits in the terminal chain cannot re-point
  // later RPCs. Reads above stay on the mutable read client on purpose.
  const createChat = useEpicCreateChatForHostClient(submitTarget.client);
  const terminalAgentCreate = useCreateTuiAgentForClient(
    submitTarget.client,
    resolvedHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const isSubmitting = createChat.isPending || terminalAgentCreate.isPending;
  const resolvedWorkspace = useResolvedWorkspaceFolders(
    draftWorkspace,
    hostClient,
    resolvedHostId,
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
  // The workspace picker browses the host the chat will be CREATED on - the
  // placement's resolved host, whichever tier answered (a caller-named host,
  // the Epic's pin, the session's host, or effective). Keying this on the raw
  // request field would leave every unnamed request on the app-wide host while
  // the create went to the Epic's: the user could pick a folder that does not
  // exist over there, and the latest-workspace seed below would be skipped.
  const workspaceHostScope = useMemo<HostWorkspaceControlsHostScope>(
    () => modalWorkspaceHostScope(resolvedHostId, hostClient),
    [hostClient, resolvedHostId],
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
  // §54 refusal copy, as on the landing composer. The G4 re-point used to
  // share this slot; it narrates as a toast now, and only when it actually
  // reset staged intent.
  const {
    notice: hostNotice,
    raise: raiseHostNotice,
    dismiss: dismissHostNotice,
  } = useComposerHostNotice(resolvedHostId);
  // G4: this modal FOLLOWS the effective host only when nothing else answered
  // its placement - no named host, no per-Epic pin in force, no session host
  // in force - and only then does a derivation move re-point it. Its staged
  // worktree/branch intent names refs on the machine the user picked them on
  // and must not travel; the §51 folder set stays, per the orchestrator's
  // ruling on the landing row. A modal resting on its pin or on the Epic's
  // host is not moved by the derivation and must not narrate a move (D6).
  // A move that reset nothing stays silent: the switch itself is
  // `toastSelectionSwitched`'s to tell.
  useEffect(() => {
    return subscribeFollowingSurfaceReset(({ nextEffectiveHostId }) => {
      if (!composerFollowsEffective) return;
      // Asked at `clearForAllHosts`'s breadth, not the resolved bucket's: this
      // modal's slot can hold an intent staged while it was pinned elsewhere,
      // and the clear below deletes that too. A narrower check would report
      // "nothing staged" for a choice the user just lost.
      const hadStagedIntent = anyHostHasStagedWorktreeIntent(stagingKey);
      clearStagedIntent(stagingKey);
      if (hadStagedIntent) {
        toastRepointedStagingReset(hostLabelFor(nextEffectiveHostId));
      }
    });
  }, [clearStagedIntent, composerFollowsEffective, hostLabelFor, stagingKey]);
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
    // Selection model §54, and the ORDERING is the point: re-validate the
    // placement BEFORE any persistent write, because `cleanupAfterSubmit`
    // below clears the draft and closes the modal synchronously, well before
    // the create can fail. An existence check (`getActiveHostId() !== null`)
    // was not enough - it passes for a pinned host that has gone offline, and
    // for a following client that has moved off the host the chip is
    // rendering. A refusal here leaves the draft, its staged workspace and the
    // modal exactly as the user left them, with the reason inline.
    const placementVerdict = resolveLandingPlacement(submitTarget);
    if (placementVerdict.kind === "refused") {
      raiseHostNotice({ kind: "refused", message: placementVerdict.message });
      return;
    }
    // No render-vs-live drift check needed here (main's #1231 added one for
    // the reactive-active-host shape): the staged key and this create both
    // derive from the SAME captured submitTarget, and the verdict REFUSES
    // rather than migrates when its frozen client no longer addresses it.
    const activeHostId = placementVerdict.hostId;
    recordPlacement(activeHostId);
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
    // `mutateAsync` + a promise chain, NOT `mutate`'s per-call callbacks, for
    // the reason `use-epic-route-synchronization.ts` records for the sidebar's
    // delete: TanStack Query v5 gates `mutateOptions` on the observer still
    // having listeners, and `cleanupAfterSubmit()` below closes this modal
    // SYNCHRONOUSLY - the dialog renders its body behind `props.open`, so the
    // component holding this mutation is gone before any answer arrives. Both
    // callbacks were therefore dead code, and the failure one is what took the
    // eager-opened tab back down: without `markFailed` the handoff stayed
    // non-terminal, `pendingCreateArtifactIds` kept the tile exempt from the
    // record sweep, and a create the host had DEFINITIVELY rejected left an
    // "Untitled agent" tab that spun for 15s and then told the user "that host
    // hasn't answered" - about a host that had answered, with a refusal. Only
    // `useInitialChatHandoff`'s 60s orphan deadline eventually cleared it, a
    // backstop written for a host that says NOTHING.
    //
    // The landing composer already submits this way (`use-landing-composer-
    // actions.ts`), and for the same reason: a surface that closes itself on
    // submit cannot own its own completion through the observer.
    void createChat
      .mutateAsync({
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
      })
      .then((response) => {
        if (response.initialTurnStarted === true) {
          useInitialChatHandoffStore
            .getState()
            .markInitialTurnStarted(
              { hostId: activeHostId, userId, epicId },
              chatId,
            );
        }
      })
      .catch(() => {
        useEpicCanvasStore.getState().clearChatTitlePending(chatId);
        // `markFailedByAction`, not `markFailed`: the handoff key is
        // {user, epic} only, so a SECOND create in this epic replaces the
        // entry while the first is still in flight - and now that this arm
        // actually runs, an unguarded `markFailed` would close the second
        // agent's tab when the first one's rejection landed. The by-action
        // variant fails only the handoff still carrying these exact ids.
        useInitialChatHandoffStore
          .getState()
          .markFailedByAction(
            { hostId: activeHostId, userId, epicId },
            chatId,
            clientActionId,
            "Couldn't create the agent.",
          );
      });
    // The toast (with the host's reason) is the shared create hook's, which
    // is mutation-level and so survives this close.
    cleanupAfterSubmit();
  }, [
    canSubmit,
    cleanupAfterSubmit,
    createChat,
    // The placement this submit re-validates MUST be the current one: a stale
    // closure would check a host the chip stopped showing renders ago.
    submitTarget,
    pickerStore,
    draftWorkspaceFolderCount,
    epicId,
    parentId,
    placement,
    raiseHostNotice,
    recordPlacement,
    rememberEpicIntent,
    setEpicRunSettings,
    setGlobalRunSettings,
    toolbarStore,
    worktreeIntentForSubmit,
  ]);
  const handleStartTerminal = useCallback(
    (launch: TerminalAgentLaunch) => {
      if (!canMutate || !workspaceCanStart) return;
      // Same §54 gate as `handleSubmit`, and for the same ordering reason:
      // `cleanupAfterSubmit` runs before the async create, so a placement that
      // cannot be created on must be refused here or the draft is gone before
      // anything reports the failure.
      const placementVerdict = resolveLandingPlacement(submitTarget);
      if (placementVerdict.kind === "refused") {
        raiseHostNotice({ kind: "refused", message: placementVerdict.message });
        return;
      }
      // The staged key and this create both derive from the same captured
      // submitTarget (see `handleSubmit`), so no render-vs-live drift check.
      const activeHostId = placementVerdict.hostId;
      recordPlacement(activeHostId);
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
      submitTarget,
      draftWorkspaceFolderCount,
      epicId,
      parentId,
      placement,
      raiseHostNotice,
      recordPlacement,
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
      topBanner={
        <ComposerHostNotice notice={hostNotice} onDismiss={dismissHostNotice} />
      }
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
      // The pinned host, else this composer's surface-pin resolution - the
      // same id `hostClient` above resolves, so the toolbar's and terminal
      // launcher's pickers offer this host's harnesses/models/profiles and
      // create profiles on it.
      hostId={resolvedHostId}
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
  // The placement's RESOLVED host - the host `hostClient` actually speaks to
  // and the chat is created on, whichever tier answered. Both seeds below key
  // on it: the parent's pending intent is staged under its CONCRETE host, and
  // the latest-conversation seed is read from (and about) that same host.
  // Neither reads the nullable request field any more - an unnamed request
  // used to skip the latest seed and read the intent slot for the app-wide
  // host while the create went to the Epic's.
  readonly resolvedHostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}): LatestConversationWorkspaceSeed | null {
  const { epicId, parentId, resolvedHostId, hostClient } = args;
  // Only read the latest-conversation seed for a top-level chat; a child must
  // never inherit an unrelated conversation's worktree (see below), so skip the
  // binding read entirely when adding a child. Read from (and about) the
  // resolved host, matching the create and the picker; `null` only while no
  // host has resolved at all.
  const latestConversationSeed = useLatestConversationWorkspaceSeed(
    parentId === null ? epicId : null,
    resolvedHostId === null ? null : { hostId: resolvedHostId, hostClient },
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
