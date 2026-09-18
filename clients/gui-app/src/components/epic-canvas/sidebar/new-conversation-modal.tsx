import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { v4 as uuidv4 } from "uuid";
import { Plus, XIcon } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";

import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
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
import { NO_LOCAL_SLASH_COMMANDS } from "@/hooks/composer/use-slash-commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useCreateTuiAgentForClient } from "@/hooks/agent/use-create-tui-agent";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useLeaderScopeAbsorber } from "@/hooks/keybindings/use-leader-scope-absorber";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import { isAttachmentIngestPending } from "@/hooks/composer/use-composer-paste";
import { useComposerHashFirstPaste } from "@/hooks/composer/use-composer-hash-first-paste";
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
import {
  bindNewChatDraftHost,
  unbindNewChatDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
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
import {
  getImageBytes,
  hasComposerImageBytes,
  sessionObjectUrl,
} from "@/lib/composer/composer-image-store";
import {
  imageHashesFromContent,
  inlineImageHashesFromSession,
  inlineLocalImageHashes,
} from "@/lib/composer/composer-image-inlining";
import { captureComposerSubmitGeneration } from "@/lib/composer/composer-submit-generation";
import {
  createAttachmentsByHashSupported,
  exceedsCreateAttachmentHashCap,
  planAttachmentsByHash,
  reportCreateAttachmentHashCapExceeded,
  resolveSendContentByHash,
  type AttachmentsByHashPlan,
} from "@/lib/composer/attachments-by-hash";
import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import {
  deriveFolderlessAllowedWorkspaceAvailability,
  workspaceComposerCanStart,
} from "@/lib/composer/workspace-composer-availability";
import { effectiveWorktreeIntent } from "@/lib/worktree/effective-worktree-intent";
import { shouldDeferWorktreeProvisioning } from "@/lib/worktree/defer-worktree-provisioning";
import { markEpicCreateSeedPending } from "@/lib/worktree/pending-epic-create-seeds";
import { hostQueryKeys } from "@/lib/query-keys";
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
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
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
 * The submit's two documents, carried across the one await this composer can
 * need. `content` is what the user's editor holds - hash-only image nodes - and
 * is what the initial-chat handoff registers. `sendContent` is the same document
 * with this window's image bytes inlined as base64, which is what the host
 * ingests today.
 *
 * They are passed together, rather than re-deriving `content` on re-entry,
 * because the two MUST describe the same message: re-reading the editor after
 * the await could pick up a keystroke that landed while the bytes were being
 * read, and the handoff would then hold a document the send never used.
 */
interface ResolvedSubmitContent {
  readonly content: JsonContent;
  readonly sendContent: JsonContent;
  /**
   * The host this content was prepared FOR, or `null` when it was not prepared
   * against any host's staging tier - every arm that ends in
   * `attachmentsByHash: false`, whose document either carries its bytes or
   * carries hashes the host was never asked to resolve out of staging. Those
   * are destination-independent and re-preparing them would buy nothing.
   *
   * A by-hash preparation is a statement about one host's staging tier, and the
   * host picker is deliberately live while the upload runs. Sending these
   * hashes anywhere else means sending a reference the destination never
   * received, which is why the re-entry below compares this against the
   * destination it is about to dispatch on rather than assuming they match.
   *
   * The CLIENT is deliberately not part of the identity: `confirmedBlobsByHost`
   * and the host's staging tier are both keyed by host, so a fresh client
   * object addressing the same host resolves the same hashes. What must not
   * change is the machine.
   */
  readonly hostId: string | null;
  /**
   * Whether `sendContent` still carries hash-only image nodes for the host to
   * resolve out of this account's draft blob tier - `epic.createChat@1.2`'s
   * `attachmentsByHash`. Decided with the content and carried with it, because
   * the flag and the document are one answer: a flag that disagreed with what
   * the document holds is either a resolution pass over nothing or a dangling
   * reference the host was never asked to resolve.
   */
  readonly attachmentsByHash: boolean;
}

/** Placeholder until the first commit publishes the real submit. */
const NOOP_SUBMIT = (): void => undefined;

/**
 * The by-hash half of this modal's submit, which is ALWAYS async: whether the
 * host already holds an image's bytes is not a question this window can answer
 * from memory, and `confirmAttachmentsByHash` may have to upload.
 *
 * BEST EFFORT on the inline remainder, which is this surface's rule and not the
 * landing composer's. A chat document routinely holds hashes whose bytes were
 * never in the LOCAL store at all - an image copied out of a rendered message,
 * a quote seed - and those address the epic's own attachment store, which the
 * host resolves first, before it ever looks at the staging tier. Refusing them
 * would break creates that work today.
 *
 * `null` means REFUSED and already narrated: the message references more
 * distinct hashes than the host will accept, and the caller must not submit.
 */
async function resolveModalSubmitContentByHash(input: {
  readonly content: JsonContent;
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry>;
  readonly plan: AttachmentsByHashPlan;
}): Promise<ResolvedSubmitContent | null> {
  // BEFORE the upload: an eligible set that is already over the cap can never
  // come back under it, so refusing here saves uploading blobs for a create
  // that cannot succeed. This is the fast path and NOT the decision - it sees
  // only the eligible half of what the host will count.
  if (exceedsCreateAttachmentHashCap(input.plan.eligible)) {
    reportCreateAttachmentHashCapExceeded();
    return null;
  }
  const sendContent = await resolveSendContentByHash(input);
  // AFTER inlining, on what the request will actually carry - which on this
  // best-effort surface is not the eligible set. The hashes this window could
  // not produce bytes for stay hash-only by design (they usually live in the
  // epic's own attachment store), and the host counts them exactly like the
  // uploaded ones. Without this, one eligible image beside thirty-two
  // epic-copied ones clears the check above and is refused by the host with an
  // `InvalidArgumentError` no surface renders - after the modal has closed and
  // cleared the draft.
  const wireHashes = imageHashesFromContent(sendContent);
  if (exceedsCreateAttachmentHashCap(wireHashes)) {
    reportCreateAttachmentHashCapExceeded();
    return null;
  }
  return {
    content: input.content,
    sendContent,
    // The host this was resolved against. The picker stays live through the
    // upload, and a create that reused these hashes on a host that never
    // received the bytes is the failure this identity exists to prevent.
    hostId: input.hostId,
    // Read off the DOCUMENT rather than off the confirmed set: an ineligible
    // node whose bytes this window could not produce is still hash-only on the
    // wire, and the host resolving it (from the epic store, where it very
    // likely lives) is strictly better than leaving it for the dangling-hash
    // guard to refuse at the first turn.
    attachmentsByHash: wireHashes.length > 0,
  };
}

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
      // This composer is hash-first now, so a just-pasted chip has no epic
      // attachment to fetch - its bytes are in this window's composer store,
      // and the session object-URL is what paints it without a placeholder
      // frame. It also covers a restored draft, because pulling the blobs back
      // off the host (`readDraftBlobsIntoLocalStore`) seeds the same session
      // entry. The epic fetcher still answers for hashes that came from a quote
      // seed, which address the epic store and were never local.
      sessionObjectUrl={sessionObjectUrl}
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
      placement: null,
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
      placement={isOpen ? request.placement : null}
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
  readonly placement: ExplicitTilePlacement | null;
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
        // Capped to the band `top-safe-center-y` centres it in - that token and
        // `--spacing-safe-dvh` measure the same region, so the two agree by
        // construction - less a 1rem gutter at each end. Without a cap the card
        // grew with the draft and, being `-translate-y-1/2`, spilled off BOTH
        // edges of the screen with nothing to scroll: on a phone the first
        // typed lines simply left the box. The scroll lives on the body
        // wrapper below rather than here, because the workspace controls'
        // popovers portal into THIS node (see `DialogOverlayBoundaryContext`)
        // and an overflow container that is also their containing block - this
        // one is, it carries a transform - would clip them.
        className="flex max-h-[calc(var(--spacing-safe-dvh)-2rem)] w-[min(92vw,48rem)] max-w-[min(92vw,48rem)] flex-col gap-3 p-4 sm:max-w-[min(92vw,48rem)]"
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
          <div
            className="min-h-0 flex-1 overflow-y-auto"
            data-testid="epic-sidebar-new-conversation-modal-body"
          >
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
          </div>
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
  readonly placement: ExplicitTilePlacement | null;
  readonly parentId: string | null;
  /** Caller-named host to create on; `null` lets this Epic own placement. */
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
  const isMobile = useIsMobileViewport();
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
  useEffect(() => {
    if (sessionHostId === null) return;
    bindNewChatDraftHost(epicId, sessionHostId);
    return () => {
      unbindNewChatDraftHost(epicId, sessionHostId);
    };
  }, [epicId, sessionHostId]);
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
    // No chat exists yet, so there is nothing a `/btw` could fork.
    localSlashCommands: NO_LOCAL_SLASH_COMMANDS,
  });

  // Creates bind to the SUBMIT client: host-frozen for the resolved host, so a
  // derivation move between two awaits in the terminal chain cannot re-point
  // later RPCs. Reads above stay on the mutable read client on purpose.
  const createChat = useEpicCreateChatForHostClient(submitTarget.client);
  // Only for the deferred create's seed-hold release closure - this surface has
  // no query of its own. Captured here rather than inside the submit so the
  // closure the marker holds outlives this modal, which closes synchronously on
  // submit while the create is still in flight.
  const queryClient = useQueryClient();
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
  const paste = useComposerHashFirstPaste({
    editorRef,
    // The epic this modal creates into. Purely the budget's OWNER key (a
    // per-surface reservation bucket), not a claim about where the bytes live -
    // they go to this window's composer store like every other surface's.
    budgetOwnerId: epicId,
    disabled: isSubmitting,
    fileDrops: runnerHost.fileDrops,
    mentionRoots,
  });
  const { ingestPastedComposerImages, notePossiblePendingImages } = paste;
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
  const epicImagePresence = useEpicAttachmentBytesPresence();
  // A hash in this composer now has TWO possible homes, and the chip must paint
  // for either: this window's composer store (anything pasted here, which is
  // every image this surface produces now that it is hash-first) or the epic's
  // attachment map (a quote seed, whose hashes were never local). The union is
  // what the attachment strip asks before it decides an image is unavailable.
  const hasPastedImageBytes = useCallback(
    (hash: string) => {
      if (hasComposerImageBytes(hash)) return true;
      if (epicImagePresence === null) return true;
      return epicImagePresence(hash);
    },
    [epicImagePresence],
  );
  const fetchEpicImage = useEpicImageFetcher();
  const readPromptStashImage = useCallback(
    async (hash: string) => {
      // Local tier first. A stash saved right after a paste is the common case
      // now, and those bytes exist only in this window's store - the epic has
      // no attachment for them until the create's message is actually sent.
      const local = await getImageBytes(hash);
      if (local !== undefined) return local;
      if (epicImagePresence?.(hash) !== true) return null;
      // Capture deliberately survives composer unmount, so this read is not
      // coupled to component-lifecycle cancellation. `.fetch` directly: this
      // one-shot read bypasses `imageBlobCache`, so it wants the byte source
      // rather than the cache subject bundled with it.
      const read = await fetchEpicImage.fetch(
        hash,
        new AbortController().signal,
      );
      return new Uint8Array(read.bytes);
    },
    [epicImagePresence, fetchEpicImage],
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
    hostId: resolvedHostId,
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
  // Only a CALLER-NAMED host is fixed. An ordinary new-chat request owns its
  // placement, so the selected scope keeps the picker live and records a pick
  // in this Epic's last-created-host memory rather than moving the window.
  const workspaceHostScope: HostWorkspaceControlsHostScope =
    modalWorkspaceHostScope({
      resolvedHostId,
      hostClient,
      callerNamedHost: hostId !== null,
      onSelect: recordPlacement,
    });
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
  // Re-entry for the submit below when its images had to be read back out of
  // IndexedDB. A `useCallback` cannot name itself, and the async arm has to
  // re-run the WHOLE submit (every other fact it reads is read fresh), so the
  // latest callback is reached through a ref rather than closed over.
  const submitRef =
    useRef<
      (
        resolved: ResolvedSubmitContent | null,
        resolutionAttempt: number,
      ) => void
    >(NOOP_SUBMIT);
  // One read at a time. The submit button is not disabled during it (the read is
  // an IndexedDB hit, not a round-trip), so a second click while it is in flight
  // must not start a second create.
  const imageResolutionInFlight = useRef(false);
  const submitWithResolvedContent = useCallback(
    (resolved: ResolvedSubmitContent | null, resolutionAttempt: number) => {
      if (!canSubmit) return;
      const editor = editorRef.current;
      if (editor === null) return;
      // AHEAD OF EVERY DISPATCH PATH, the synchronous one included. A read is
      // in flight for a document already captured; letting a second click run
      // the synchronous create would put two chats on the wire for one prompt,
      // and the first one to finish would clear the draft out from under the
      // other. The async arms below release this latch through
      // `settleResolvedSubmit` BEFORE re-entering, which is why the re-entry
      // gets past this line.
      if (imageResolutionInFlight.current) return;
      // THE DESTINATION MAY HAVE MOVED WHILE THE UPLOAD RAN. The picker is
      // live through the wait (it is rendered `disabled={false}` on purpose),
      // and switching hosts does not touch the draft's `revision` - so the
      // generation guard below, which only asks whether the DOCUMENT changed,
      // waves this through. What arrives here is content whose hashes were
      // confirmed on the host that was selected when send was pressed, about to
      // be dispatched on whichever host is selected now.
      //
      // Re-resolve rather than reuse: re-entering with `null` re-plans against
      // the new destination, re-asks its negotiated minor, and uploads to it or
      // inlines for it. Reusing would hand the new host a reference it has
      // never seen, which it answers with a refusal the user reads as a failed
      // create.
      if (
        resolved !== null &&
        resolved.hostId !== null &&
        resolved.hostId !== submitTarget.resolvedHostId
      ) {
        // Same budget as the edited-during-the-read arm, and for the same
        // reason: one re-resolution is a correction, an unbounded chain is a
        // user holding the picker hostage to a create that never leaves.
        if (resolutionAttempt === 0) {
          submitRef.current(null, resolutionAttempt + 1);
        }
        return;
      }
      // THE HASH-FIRST SEAM, and it is resolved FIRST - before this function
      // writes anything - so that the async re-entry below repeats no side
      // effect. What the user's document holds is hash-only image nodes; the
      // host still ingests inline base64, so `sendContent` is the same document
      // with this window's bytes put back. The handoff keeps `content`
      // (hash-only): that is what keeps base64 out of `localStorage` under the
      // handoff key, and what lets the handoff ROOT those bytes against the
      // image GC until the resend inlines them itself.
      //
      // `null` from the fast path means at least one hash is session-cold - a
      // draft this window restored off the host mirror rather than pasted - so
      // the bytes are read back and this submit is re-entered with them.
      const content =
        resolved?.content ??
        buildSubmittedChatJSONContent(
          editor.getJSON(),
          pickerStore.getState().knownSlashCommands,
        );
      // The draft this submit is for. `content` above was captured off the
      // editor, but the editor stays EDITABLE across the reads below, and the
      // create ends in `cleanupAfterSubmit` - which clears the draft store and
      // the editor. Without this the sentence typed during the read was wiped
      // by a create that sent the document from before it. The modal's draft
      // `revision` bumps on `setContent` alone (document mutations), which is
      // the whole of the work here: there is no annotation sidecar, and a
      // caret move is not work worth cancelling a send over.
      const generation = captureComposerSubmitGeneration(
        () =>
          useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
            ?.revision ?? 0,
      );
      /**
       * The single exit for both async arms below. It owns the latch release
       * (so the re-entry clears the hoisted guard at the top) and the decision
       * about whether the captured document may still be sent.
       *
       * `null` means the read produced nothing to send - today that is the
       * by-hash count-cap refusal, which has already toasted. Nothing is sent
       * and, just as importantly, nothing is cleared.
       */
      const settleResolvedSubmit = (
        prepared: ResolvedSubmitContent | null,
      ): void => {
        imageResolutionInFlight.current = false;
        if (prepared === null) return;
        if (generation.stillCurrent()) {
          submitRef.current(prepared, resolutionAttempt);
          return;
        }
        // The user edited the prompt during the read, so `prepared` describes a
        // document that is no longer on screen. Re-enter from scratch and
        // resolve the CURRENT one rather than sending the stale capture.
        if (resolutionAttempt === 0) {
          submitRef.current(null, resolutionAttempt + 1);
          return;
        }
        // Edited again during the retry. Send nothing and clear nothing - the
        // draft is intact and the user can press send again.
      };
      // THE BY-HASH GATE, asked before the inline one because it decides
      // whether inlining is needed at all. Four conditions, and any failure
      // falls through to the inline paths that have always worked: a client to
      // upload on, no node carrying both base64 and a hash (the host would try
      // to resolve that hash too - see `hasInlineHashedNode`), something the
      // preparer marked eligible, and the negotiated minor of the method this
      // create actually dispatches on.
      const plan = resolved === null ? planAttachmentsByHash(content) : null;
      const byHashClient = submitTarget.client;
      const byHashHostId = submitTarget.resolvedHostId;
      if (
        plan !== null &&
        byHashClient !== null &&
        byHashHostId !== null &&
        !plan.hasInlineHashedNode &&
        plan.eligible.length > 0 &&
        createAttachmentsByHashSupported(byHashHostId, "epic.createChat")
      ) {
        imageResolutionInFlight.current = true;
        void resolveModalSubmitContentByHash({
          content,
          hostId: byHashHostId,
          client: byHashClient,
          plan,
        }).then(
          // `null` is the count-cap refusal, already toasted. Submitting anyway
          // would put a request on the wire the host will certainly reject with
          // an error no surface renders.
          settleResolvedSubmit,
          // The upload or the byte read failed outright. Fall back to the
          // document as it stands rather than swallowing the create: an
          // unresolvable hash comes back as the existing missing-bytes
          // failure, which is visible, and `attachmentsByHash` stays off so
          // this host is not asked to resolve what it was never given.
          () =>
            settleResolvedSubmit({
              content,
              sendContent: content,
              hostId: null,
              attachmentsByHash: false,
            }),
        );
        return;
      }
      const sendContent =
        resolved?.sendContent ?? inlineImageHashesFromSession(content);
      if (sendContent === null) {
        imageResolutionInFlight.current = true;
        void inlineLocalImageHashes(content).then(
          (inlined) =>
            settleResolvedSubmit({
              content,
              sendContent: inlined,
              hostId: null,
              attachmentsByHash: false,
            }),
          // The store could not be read at all. Submit the hash-only document
          // rather than swallowing the create: a hash the host cannot resolve
          // comes back as the existing missing-bytes rejection, which fails
          // the send visibly and restores the prompt.
          () =>
            settleResolvedSubmit({
              content,
              sendContent: content,
              hostId: null,
              attachmentsByHash: false,
            }),
        );
        return;
      }
      const attachmentsByHash = resolved?.attachmentsByHash ?? false;
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
              // What goes ON THE WIRE, unlike the handoff's hash-only copy
              // above: inline base64 for every image this host cannot take by
              // hash, and hash-only nodes for the ones it can.
              content: sendContent,
              sender: { type: "user" as const, userId },
              settings,
              accountContext,
              // Spread rather than a `false` literal, like the opt-in below:
              // absent and `false` read identically on the host, and a request
              // that names the key only when it is asking for something keeps
              // the wire honest about which creates carry hashes.
              ...(attachmentsByHash
                ? { attachmentsByHash: true as const }
                : {}),
            };
      if (initialMessage !== null) {
        useEpicCanvasStore.getState().markChatTitlePending(chatId, "");
      }
      // The opt-in, on the same four facts as the landing composer (shared
      // predicate, so the two surfaces cannot drift).
      const deferWorktreeProvisioning = shouldDeferWorktreeProvisioning({
        hostId: activeHostId,
        method: "epic.createChat",
        hasInitialMessage: initialMessage !== null,
        workspaceMode,
        worktreeIntent,
      });
      // THE MODAL SEEDS NOTHING AND HOLDS NOTHING - it registers a RELEASE entry.
      //
      // It cannot seed the one row this window lacks (the new chat's worktree
      // row): the host mints both the possibly-suffixed branch and the path, a
      // selector row carries no owner, and rows dedupe on (hostId, runningDir),
      // so an appended row would only duplicate. What it can do is give the
      // epic's binding listing something to refetch on, because no publisher
      // fires on a managed create - `writeBinding` publishes nothing and the
      // freshness watcher is best-effort - so without this entry the worktree row
      // would appear only at the next unrelated invalidation.
      //
      // ONLY when it deferred: a synchronous create has its row on the host at
      // the response and the ordinary `onSuccess` refetch already lands it.
      // Registered here, after the four facts exist and before `mutateAsync` (and
      // before the handoff's eager tab open), in this same synchronous block, so
      // the entry always precedes the tile that drives it.
      if (deferWorktreeProvisioning) {
        markEpicCreateSeedPending(epicId, chatId, {
          hostId: activeHostId,
          seededMessageId: messageId,
          seedRows: false,
          heldForDeferredCreate: false,
          release: () => {
            void queryClient.invalidateQueries({
              queryKey: hostQueryKeys.method<
                HostRpcRegistry,
                "worktree.listBindingsForEpic"
              >(activeHostId, "worktree.listBindingsForEpic", { epicId }),
            });
          },
        });
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
          // Spread rather than a `false` literal - see the landing composer's
          // copy: absent and `false` read identically on the host, and a request
          // that names the key only when it is asking for something keeps the
          // wire honest about which creates opted in.
          ...(deferWorktreeProvisioning
            ? { deferWorktreeProvisioning: true }
            : {}),
        })
        .then((response) => {
          // A REFUSAL RESOLVES. `epic.createChat@1.2` answers it as an optional
          // key on the ordinary response, so this arm runs for a create that
          // did not happen - and its `chatId` names a chat the host never made.
          // The teardown is the rejection arm's, and for the same reason: this
          // modal opened a tab eagerly off the handoff and closed itself
          // synchronously, so without it the tile spins on a chat that will
          // never project and only the handoff's 60s orphan deadline - written
          // for a host that says NOTHING - would clear it. The toast is the
          // mutation's, which reads the host's own two sentences.
          if (response.refusal !== undefined) {
            useEpicCanvasStore.getState().clearChatTitlePending(chatId);
            useInitialChatHandoffStore
              .getState()
              .markFailedByAction(
                { hostId: activeHostId, userId, epicId },
                chatId,
                clientActionId,
                "Couldn't create the agent.",
              );
            return;
          }
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
    },
    [
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
      queryClient,
      raiseHostNotice,
      recordPlacement,
      rememberEpicIntent,
      setEpicRunSettings,
      setGlobalRunSettings,
      toolbarStore,
      worktreeIntentForSubmit,
    ],
  );
  // Published for the async re-entry above. In an effect, not in render, so the
  // ref is written on commit like any other external sync.
  useEffect(() => {
    submitRef.current = submitWithResolvedContent;
  }, [submitWithResolvedContent]);
  const handleSubmit = useCallback(
    () => submitWithResolvedContent(null, 0),
    [submitWithResolvedContent],
  );
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
          placement,
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
      // Catch-all for an inline-b64 node this hook did not insert itself - a
      // cross-host browser-tab preview screenshot, a restored draft that still
      // carries one. Cheap and short-circuiting when there is nothing pending.
      notePossiblePendingImages(content);
    },
    [epicId, notePossiblePendingImages, setContent, setSelection],
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
      editorReadOnly={false}
      attachmentPending={attachmentPending}
      workspaceDisabledHint={composerDisabledHint}
      header={header}
      topBanner={
        <ComposerHostNotice notice={hostNotice} onDismiss={dismissHostNotice} />
      }
      // Same rule as the landing composer's row (`landing-composer.tsx`): six
      // pills do not fit a phone-width row, so below `md` the agent-mode pill
      // moves into the options sheet behind the permission pill. This modal
      // used to opt out and render the desktop row at any width, which made
      // one composer look like two depending on where it was opened from.
      toolbarLayout={isMobile ? "collapsed" : "full"}
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
      ingestPastedComposerImages={ingestPastedComposerImages}
      // A draft restored into this modal can already carry a pending b64 node
      // (the editor is created with `initialContent` and fires no document
      // change for it), so the sweep runs once the handle exists as well.
      onEditorReady={paste.reingestPendingImages}
      // No terminal surface: a sign-in terminal tile is bound to the TAB's
      // host, while this composer creates on a placement-resolved host that
      // may be another machine, and this modal sits above the canvas the tile
      // would open on. The picker's setup CTA shows its steps and names the
      // chat picker instead.
      terminalLoginSurface={null}
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
    if (agent.harnessId === null) {
      // Nothing to seed FROM. A cross-host replica whose cloud row predates
      // `runSettingsSummary` cannot say what it runs, and a composer seeded
      // with a guessed harness would create the next agent under it. Fall back
      // to the same "no memory yet" answer an epic with no prior agent gives.
      return { settings: null, composerMode: fallbackComposerMode };
    }
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
