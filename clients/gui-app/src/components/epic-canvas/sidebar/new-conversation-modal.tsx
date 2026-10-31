import { useUltracodeCarrierSupported } from "@/components/home/data/model-ultracode";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import {
  transitionPendingSend,
  UNKNOWN_PENDING_SEND_FACTS,
} from "@/lib/sandboxes/pending-sandbox-send-transition";
import {
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  mintNewEpicTerminalTile,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { v4 as uuidv4 } from "uuid";
import { Plus, XIcon } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";

import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
import {
  useEpicAttachmentBytesPresence,
  useEpicImageFetcher,
} from "@/lib/attachments/use-attachment-blob-src";
import { useDraftFirstImageFetcher } from "@/lib/attachments/use-draft-image-fetcher";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import { hasLandingImageBytes } from "@/lib/composer/landing-image-store";
import {
  draftImageInliningNeeded,
  prepareDraftImageInlining,
} from "@/lib/drafts/draft-image-inlining";
import {
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";
import { captureComposerSubmitGeneration } from "@/lib/composer/composer-submit-generation";
import { NO_HOST_HELD_HASHES } from "@/lib/composer/host-held-image-hashes";
import { withHeldComposerContentImageRoots } from "@/lib/composer/composer-content-image-roots";
import { appLogger } from "@/lib/logger";
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
import {
  PortalConcealmentProvider,
  usePortalConcealed,
} from "@/components/ui/portal-concealment-context";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useCreateTuiAgentForClient } from "@/hooks/agent/use-create-tui-agent";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useLeaderScopeAbsorber } from "@/hooks/keybindings/use-leader-scope-absorber";
import {
  KeyboardOwnerContext,
  usePrimaryActionShortcut,
} from "@/hooks/use-primary-action-shortcut";
import {
  isAttachmentIngestPending,
  useComposerHashPaste,
} from "@/hooks/composer/use-composer-paste";
import { useComposerPendingImageIngest } from "@/hooks/composer/use-composer-pending-image-ingest";
import {
  mentionRootsFromWorktreeIntent,
  useWorkspaceMentionRoots,
} from "@/hooks/composer/use-workspace-mention-roots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import {
  isAttachEnvironmentUnsupported,
  toastAttachEnvironmentNeedsOwnHost,
  useEpicAttachmentClient,
  useEpicAttachEnvironment,
} from "@/hooks/epic/use-epic-attach-environment-mutation";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
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
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import {
  bindNewChatDraftHost,
  unbindNewChatDraftHost,
} from "@/lib/drafts/draft-mirror-coordinator";
import { resolveLandingPlacement } from "@/lib/composer/landing-placement";
import { toastRepointedStagingReset } from "@/lib/composer/repointed-staging-toast";
import {
  newConversationSurfaceKey,
  subscribeFollowingSurfaceReset,
} from "@/stores/host/surface-host-selection-store";
import {
  ComposerHostNotice,
  type ComposerHostNoticeState,
} from "@/components/home/composer/composer-host-notice";
import { useComposerHostNotice } from "@/hooks/composer/use-composer-host-notice";
import { composerTopNotice } from "@/components/home/composer/composer-mirror-line-model";
import { useComposerMirrorLine } from "@/hooks/composer/use-composer-mirror-line";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import { LEADER_SCOPE_NEW_CONVERSATION_MODAL } from "@/lib/keybindings/leader-scope";
import {
  useEpicConnectionStatus,
  useEpicNodeOwnerKind,
  useEpicNodeWorkspaceFolders,
  useEpicPermissionRole,
  useEpicTitle,
} from "@/lib/epic-selectors";
import { isEditableRole, mutationDisabledHint } from "@/lib/epic-permissions";
import {
  ARIA_DISABLED_TRIGGER_CLASS,
  resolveDisabledPresentation,
} from "@/lib/disabled-presentation";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import { sessionObjectUrl } from "@/lib/composer/landing-image-store";
import { appendImageAttachmentAtoms } from "@/lib/composer/image-atoms";
import {
  sessionAnnotationImageAtoms,
  type AnnotationImageAtom,
} from "@/lib/composer/annotation-image-atoms";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { BrowserAnnotationCard } from "@/components/chat/composer/browser-annotation-card";
import { useLandingImageFetcher } from "@/hooks/composer/use-landing-image-fetcher";
import {
  readNewConversationAnnotations,
  useNewConversationAnnotationStore,
} from "@/stores/epics/new-conversation-annotation-store";
import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import {
  confirmAttachmentsByHash,
  createAttachmentsByHashSupported,
  exceedsCreateAttachmentHashCap,
  planAttachmentsByHash,
  reportCreateAttachmentHashCapExceeded,
  type AttachmentsByHashPlan,
} from "@/lib/composer/attachments-by-hash";
import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import { deriveFolderlessAllowedWorkspaceAvailability } from "@/lib/composer/workspace-composer-availability";
import { effectiveWorktreeIntent } from "@/lib/worktree/effective-worktree-intent";
import { shouldDeferWorktreeProvisioning } from "@/lib/worktree/defer-worktree-provisioning";
import { markEpicCreateSeedPending } from "@/lib/worktree/pending-epic-create-seeds";
import { hostQueryKeys } from "@/lib/query-keys";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import { cn } from "@/lib/utils";
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import {
  stagingSurfaceKey,
  useInTaskSandboxStagingSurface,
} from "@/components/composer/use-sandbox-staging";
import {
  useStagedSandboxHandoff,
  useStagedSandboxSend,
  type StagedResubmit,
} from "@/components/composer/use-staged-sandbox-send";
import { useStagedWorkspaceGate } from "@/components/composer/use-staged-workspace-gate";
import {
  ownerGoneOnUnmount,
  readStagedSandbox,
  useStagedSandboxStore,
  useStagedTerminalLaunch,
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";
import {
  handPendingSandboxSend,
  pickedRunSettings,
} from "@/lib/sandboxes/pending-sandbox-send";
import {
  stagedResubmitReady,
  stagedTerminalLaunchOnHost,
} from "@/components/composer/staged-terminal-launch";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProviderPackGateForClient } from "@/hooks/providers/use-provider-pack-gate";
import { ComposerStagedSurfaceKeyProvider } from "@/components/composer/composer-staged-sandbox-context";
import { useSandboxAgentGate } from "@/hooks/sandboxes/use-sandbox-agent-gate";
import {
  useStagedSendSignInCheck,
  type StagedSendSignInCheck,
} from "@/hooks/sandboxes/use-staged-send-sign-in-check";
import { composerDisplayPlainText } from "@/lib/composer/composer-clipboard";
import { isHostSwitcherListInteraction } from "@/components/settings/host-scope/host-switcher-portal";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { modalWorkspaceHostScope } from "./new-conversation-modal-host-scope";
import { ComposerBody } from "@/components/home/composer/composer-body";
import { VisibleDraftImagePrefetch } from "@/components/home/visible-draft-image-prefetch";
import { ComposerModeSwitcher } from "@/components/home/composer/composer-mode-switcher";
import { COMPOSER_EDITOR_CLASSNAME } from "@/components/home/composer/composer-editor-classnames";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import {
  nextComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { catalogSettledFor } from "@/stores/composer/composer-toolbar-store";
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
  openActiveModelPickerForHarness,
  subscribeActiveModelPicker,
} from "@/lib/commands/active-model-picker-registry";
import {
  tileIntent,
  type ExplicitTilePlacement,
} from "@/lib/canvas/tile-open/intent";
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
import { useTeamSandboxHarnessGate } from "@/hooks/sandboxes/use-team-sandbox-harness-blocked";
import { useNewConversationReturnedSandbox } from "@/hooks/sandboxes/use-returned-sandbox-stage";
import { TEAM_SANDBOX_HARNESS_UNAVAILABLE } from "@/lib/sandboxes/team-sandbox-harness";

/** Nothing confirmed: below `epic.createChat@1.2`, or an upload that failed. */
const NO_CONFIRMED_HASHES: ReadonlySet<string> = new Set<string>();

/**
 * Put this window's image bytes into the target host's draft-blob tier and
 * answer which digests the host CONFIRMED holding.
 *
 * ## Why this is not a second submit arm
 *
 * The confirmed set is handed to `draftImageInliningNeeded` as its host-held
 * set, and the preparation below then does the rest unchanged: a node whose
 * digest the host confirmed is subtracted, so it stays hash-only and travels
 * once as a blob; every other node is inlined by the path that has always
 * inlined it. There is no by-hash branch to keep in step with the inlining
 * branch, because there is only one branch - `epic.createChat@1.2` is expressed
 * entirely as a wider host-held set. Same shape as the inline-edit surface,
 * deliberately: one idea at both surfaces rather than two that can disagree.
 *
 * ## Why a failed upload is not a refusal
 *
 * An unconfirmed digest is simply not host-held, so it is inlined - which is
 * exactly what this surface did before `@1.2` existed. That is what makes it
 * safe to run this unconditionally whenever the host supports it: the worst
 * outcome is the status quo, never a create the user cannot complete.
 *
 * ## What this does NOT decide
 *
 * `attachmentsByHash`. That is read off the document actually dispatched, in
 * `commit` below, so the flag and the document cannot disagree - a flag set
 * from the confirmed set would claim hash-only nodes for a document that,
 * after a late paste and its inlining, no longer has any.
 */
async function confirmCreateAttachmentHashes(input: {
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry>;
  readonly plan: AttachmentsByHashPlan;
  /**
   * The account the confirmations are recorded and read under. `null` confirms
   * NOTHING, which is correct signed out and is why it is threaded rather than
   * defaulted: a wrong or absent owner here does not fail, it silently returns
   * an empty set and the whole surface falls back to inlining.
   */
  readonly ownerUserId: string | null;
}): Promise<ReadonlySet<string>> {
  // No progress surface here: the modal disables its own Send and shows the
  // attachment strip, and a create from it carries far fewer images than a
  // landing submit does.
  const confirmed = await confirmAttachmentsByHash({
    ...input,
    onProgress: null,
  });
  return confirmed.byHash;
}

/**
 * Isolated subscriber for the live draft content. The editor rewrites content
 * on every keystroke; keeping that subscription here (rather than in
 * `NewConversationModalBody`) means only the attachment strip re-renders while
 * typing - the toolbar / workspace controls / editor wrapper stay put.
 */
const NO_ANNOTATIONS: readonly never[] = [];

/** `epic.createChat@1.5`: the first message carries the annotation sidecar. */
function hostCreatesChatWithAnnotations(hostId: string): boolean {
  const version = readNegotiatedMethodVersion(hostId, "epic.createChat");
  return (
    version !== null &&
    version !== false &&
    version.major === 1 &&
    version.minor >= 5
  );
}

/**
 * The browser-annotation sidecar a create carries, or why it cannot. The
 * records need `epic.createChat@1.5` on the host the chat is created on -
 * below it they would be stripped on the wire and the message would arrive
 * without its cards - and each crop must still be in this window's image
 * store, since it rides as an inline image atom the record's hash names.
 */
function annotationSidecarForCreate(
  epicId: string,
  hostId: string,
):
  | {
      readonly kind: "ready";
      readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
      readonly atoms: ReadonlyArray<AnnotationImageAtom>;
    }
  | { readonly kind: "refused"; readonly message: string } {
  const browserAnnotations = readNewConversationAnnotations(epicId);
  if (
    browserAnnotations.length > 0 &&
    !hostCreatesChatWithAnnotations(hostId)
  )
    return {
      kind: "refused",
      message: "Update the host to start a chat with this capture.",
    };
  const atoms = sessionAnnotationImageAtoms(browserAnnotations);
  if (atoms === null)
    return {
      kind: "refused",
      message:
        "The capture's image is missing. Send it from the artifact again.",
    };
  return { kind: "ready", browserAnnotations, atoms };
}

/** A card alone is a message, as it is in a chat composer. */
function useHasSubmittableContent(
  epicId: string,
  seed: NewConversationModalSeed,
): boolean {
  const hasText = useNewConversationModalStore((state) =>
    contentIsSubmittable(
      state.draftPatchesByEpicId[epicId]?.content ?? seed.content,
    ),
  );
  const hasCards = useNewConversationAnnotationStore(
    (state) => (state.byEpicId[epicId]?.length ?? 0) > 0,
  );
  return hasText || hasCards;
}

function NewConversationModalAttachmentStrip(props: {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly seedContent: JsonContent;
  readonly onRemoveImage: (id: string) => void;
}) {
  const content = useNewConversationModalStore(
    (state) =>
      state.draftPatchesByEpicId[props.epicId]?.content ?? props.seedContent,
  );
  // Draft custody FIRST, the epic replica behind it. Everything in this strip
  // is a draft the user has not sent yet, and `useEpicImageFetcher` has no
  // local-store leg - so a hash-only chip whose bytes are sitting in this very
  // window's image partition renders blank through it. The epic leg stays
  // because a draft opened here can carry a hash this epic genuinely holds.
  const fetcher = useDraftFirstImageFetcher(
    useEpicImageFetcher(),
    props.hostId,
  );
  // The cards a selection sent to "New chat" brought along, beside the images.
  const annotations = useNewConversationAnnotationStore(
    (state) => state.byEpicId[props.epicId] ?? NO_ANNOTATIONS,
  );
  const annotationImageFetcher = useLandingImageFetcher();
  return (
    <>
      <VisibleDraftImagePrefetch content={content} active />
      <AttachmentStrip
        content={content}
        onRemoveImage={props.onRemoveImage}
        fetcher={fetcher}
        leadingAttachments={
          annotations.length > 0 ? (
            <div data-testid="browser-annotation-cards" className="contents">
              {annotations.map((record) => (
                <BrowserAnnotationCard
                  key={record.annotationId}
                  record={record}
                  targetControl={undefined}
                  onRemove={(annotationId) =>
                    useNewConversationAnnotationStore
                      .getState()
                      .remove(props.epicId, annotationId)
                  }
                  imageFetcher={annotationImageFetcher}
                  sessionObjectUrl={sessionObjectUrl}
                />
              ))}
            </div>
          ) : undefined
        }
        // This composer is hash-first now, so a just-pasted chip has no epic
        // attachment to fetch - its bytes are in this window's composer store,
        // and the session object-URL is what paints it without a placeholder
        // frame. It also covers a restored draft, because pulling the blobs back
        // off the host (`readDraftBlobsIntoLocalStore`) seeds the same session
        // entry. The epic fetcher still answers for hashes that came from a quote
        // seed, which address the epic store and were never local.
        sessionObjectUrl={sessionObjectUrl}
      />
    </>
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
 * panel header (top-level) and each chat row (child). The modal opens with its
 * remembered draft mode, falling back to the latest conversation's interface
 * when there is no draft, so a terminal-agent launch carries forward just like
 * a chat launch. The modal's own switcher remains the one way to change modes.
 */
export function NewConversationModalAction(
  props: NewConversationModalActionProps,
) {
  const { disabled, epicId, parentId, tabId } = props;
  const openModal = useNewConversationModalOpenStore((state) => state.open);
  const handleOpen = useCallback((): void => {
    if (disabled) return;
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
  }, [disabled, epicId, openModal, parentId, tabId]);
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
      variant="muted"
      size={props.size}
      aria-label={props.triggerLabel}
      aria-disabled={ariaDisabled ? true : undefined}
      data-testid={props.triggerTestId}
      className={cn(ARIA_DISABLED_TRIGGER_CLASS, props.actionRevealClassName)}
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

function closeRequestOwnedBy(epicId: string, tabId: string): void {
  const current = useNewConversationModalOpenStore.getState().request;
  if (
    current !== null &&
    current.epicId === epicId &&
    current.tabId === tabId
  ) {
    useNewConversationModalOpenStore.getState().close();
  }
}

/**
 * Whether this tab's modal handed a terminal agent's Start to a staged
 * sandbox that has not settled yet. Phase 2 launches it from the body, so the
 * body is kept while this holds; a failure, a cancel or a clear ends it.
 */
function modalHandoffPending(
  stage: StagedSandbox | undefined,
  tabId: string,
): boolean {
  return (
    stage !== undefined &&
    stage.sendTaken &&
    stage.ownerId === tabId &&
    stage.phase !== "staged" &&
    stage.failure === null
  );
}

/**
 * Per-tab host for the shared New Conversation modal. Mounted inside the epic
 * surface (so the modal's permission/connection gating and per-epic draft
 * store resolve to this epic) for as long as the tab is retained, and shows
 * the modal whenever the open-request store targets this epic + tab while
 * the tab is in front; every creation trigger - sidebar `+`, in-pane
 * PaneOpener, ⌘K palette - funnels through that one request.
 *
 * The body is one instance for its whole life: rendered here, through a
 * portal into a container this host owns, which the dialog attaches while it
 * is open and detaches when it closes. A send handed to a staged sandbox keeps
 * that instance mounted, detached and owning no keyboard, until the stage
 * settles, so the send happens though the modal closed or the tab went to
 * the background; reopening attaches the same instance again.
 */
export function NewConversationModalHost(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly active: boolean;
}) {
  const { epicId, tabId, active } = props;
  const request = useNewConversationModalOpenStore((state) => state.request);
  const ownedRequest =
    request !== null && request.epicId === epicId && request.tabId === tabId
      ? request
      : null;
  const isOpen = active && ownedRequest !== null;
  // The modal belongs to the tab in front. A tab that goes to the background,
  // or unmounts, while it owns the open request clears it - otherwise the
  // global request lingers with no live dialog to dismiss it and the modal
  // re-pops when the user returns to this tab. Only on leaving the front: a
  // request filed for a tab before it comes to the front is shown once it does.
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (wasActive && !active) closeRequestOwnedBy(epicId, tabId);
  }, [active, epicId, tabId]);
  useEffect(() => () => closeRequestOwnedBy(epicId, tabId), [epicId, tabId]);
  const handingOff = useStagedSandboxStore((state) =>
    modalHandoffPending(
      state.bySurface[newConversationSurfaceKey(epicId)],
      tabId,
    ),
  );
  // The request the body was opened with, kept while its send is handed off,
  // hidden or reopened from another trigger: the send still lands where it
  // was asked to. A request filed meanwhile is held, and becomes the body's
  // once the handoff settles.
  const [bodyRequest, setBodyRequest] = useState(isOpen ? ownedRequest : null);
  if (isOpen && !handingOff && ownedRequest !== bodyRequest) {
    setBodyRequest(ownedRequest);
  }
  const mountBody = (isOpen || handingOff) && bodyRequest !== null;
  const [bodyContainer] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const attachBody = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot === null) bodyContainer.remove();
      else slot.appendChild(bodyContainer);
    },
    [bodyContainer],
  );
  // See `NewConversationModalDialog`: published by the open dialog's content.
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  // The body is a React SIBLING of the dialog (the portal below), so Radix's
  // own "was this pointer-down inside my React tree" check on the dialog never
  // sees the body's events. React still routes events from the body's DOM
  // (nested inside the dialog's node) through the dialog's React capture, so
  // plain clicks in the body are fine - but an overlay the body opens that
  // portals to `document.body`, such as the model picker, is neither in the
  // dialog's DOM nor in its React tree, and the dialog dismissed itself on
  // every click in it. The body's React capture sees those (React capture
  // follows portals), so it records the pointer-down here and the dialog
  // declines to treat that same event as an outside interaction.
  const bodyPointerDownRef = useRef<Event | null>(null);
  const [overlayBoundaryEl, setOverlayBoundaryEl] =
    useState<HTMLElement | null>(null);
  // The composer picker store outlives the body's focus-driven unmount. A fresh
  // store is minted each time the modal opens, so a reopened modal starts
  // clean, while it survives focus toggles within one open session.
  const [transientSession, setTransientSession] = useState<
    NewConversationTransientState & { readonly open: boolean }
  >(() => ({ open: isOpen, pickerStore: createComposerPickerStore() }));
  if (isOpen !== transientSession.open) {
    setTransientSession((prev) =>
      isOpen
        ? { open: true, pickerStore: createComposerPickerStore() }
        : { ...prev, open: false },
    );
  }
  const transient = useMemo<NewConversationTransientState>(
    () => ({ pickerStore: transientSession.pickerStore }),
    [transientSession.pickerStore],
  );
  // Hidden, the body's own overlays (a toolbar popover left open, a menu)
  // un-present with it, and re-present intact when it is shown again: a tab
  // can be activated from outside the page, with no input that would have
  // dismissed them.
  const concealed = usePortalConcealed() || !isOpen;
  // Closes the request the send was made from, never one filed after it was
  // handed off.
  const onSubmitted = useCallback(() => {
    const store = useNewConversationModalOpenStore.getState();
    if (bodyRequest !== null && store.request === bodyRequest) store.close();
  }, [bodyRequest]);
  return (
    <>
      <NewConversationModalDialog
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) closeRequestOwnedBy(epicId, tabId);
        }}
        dismissPickerRef={dismissPickerRef}
        bodyPointerDownRef={bodyPointerDownRef}
        onOverlayBoundary={setOverlayBoundaryEl}
        attachBody={attachBody}
      />
      {mountBody
        ? createPortal(
            <div
              className="contents"
              onPointerDownCapture={(event) => {
                bodyPointerDownRef.current = event.nativeEvent;
              }}
            >
              <DialogOverlayBoundaryContext.Provider value={overlayBoundaryEl}>
                <PortalConcealmentProvider value={concealed}>
                  <SurfaceActivityProvider active>
                    <KeyboardOwnerContext value={isOpen}>
                      <NewConversationTransientContext.Provider
                        value={transient}
                      >
                        <NewConversationModalBody
                          epicId={epicId}
                          tabId={tabId}
                          placement={bodyRequest.placement}
                          parentId={bodyRequest.parentId}
                          hostId={bodyRequest.hostId}
                          modelPickerHarnessId={
                            bodyRequest.modelPickerHarnessId
                          }
                          dismissPickerRef={dismissPickerRef}
                          onSubmitted={onSubmitted}
                        />
                      </NewConversationTransientContext.Provider>
                    </KeyboardOwnerContext>
                  </SurfaceActivityProvider>
                </PortalConcealmentProvider>
              </DialogOverlayBoundaryContext.Provider>
            </div>,
            bodyContainer,
          )
        : null}
    </>
  );
}

function NewConversationModalDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly dismissPickerRef: RefObject<(() => boolean) | null>;
  /** The last pointer-down inside the body's React tree; see the host. */
  readonly bodyPointerDownRef: RefObject<Event | null>;
  readonly onOverlayBoundary: (element: HTMLElement | null) => void;
  /** Attaches the host's body container to the open dialog's body slot. */
  readonly attachBody: (slot: HTMLDivElement | null) => void;
}) {
  const {
    open,
    onOpenChange,
    dismissPickerRef,
    bodyPointerDownRef,
    onOverlayBoundary,
    attachBody,
  } = props;
  // Opt this modal out of the keybinding provider's dialog block so the nested
  // model picker's ⌘/⌥ leader-digit shortcuts and hints fire while it's open
  // (see `isAnyDialogOpen` in keybinding-provider.tsx). The modal owns no leader
  // shortcuts itself, so an absorber scope claims both leaders while open -
  // closed-picker leader digits are swallowed here instead of switching the
  // tabs behind the modal, and the picker's own scope layers on top when open.
  useLeaderScopeAbsorber(open, LEADER_SCOPE_NEW_CONVERSATION_MODAL);
  // The composer's @/slash picker (see `ComposerMenu`) is a plain portalled
  // floating menu, not a Radix dismissable layer, so Radix can't coordinate
  // Escape with it. Radix's escape listener runs first (document, capture) and
  // dismisses the dialog; preventing that needs `preventDefault`, but that also
  // suppresses ProseMirror's keydown (it ignores defaultPrevented events), so
  // the picker's own Escape-close never fires. The body publishes an imperative
  // dismiss here: while a picker is open we close it ourselves and preventDefault
  // (first Escape closes only the picker); once it's closed the call returns
  // false and Escape falls through to dismiss the dialog (second Escape).
  //
  // The workspace controls' nested Branch/Location popovers portal to
  // `document.body` by default, landing as a DOM sibling of this dialog - the
  // dialog's scroll-lock then swallows wheel input over their scrollable
  // lists even though the lists themselves scroll fine (see
  // `DialogOverlayBoundaryContext`). Publishing this dialog's own content node
  // lets those nested overlays portal inside it instead, so the lock
  // recognizes their content as its own.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={onOverlayBoundary}
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
        className="flex max-h-[calc(var(--spacing-safe-dvh)-2rem)] w-[min(92vw,48rem)] max-w-[min(92vw,48rem)] flex-col sm:max-w-[min(92vw,48rem)]"
        data-testid="epic-sidebar-new-conversation-modal"
        data-leader-scope={LEADER_SCOPE_NEW_CONVERSATION_MODAL}
        // A pointer-down the body's React tree already saw is the body's own
        // (the model picker's rows and effort slider portal to `document.body`
        // and would otherwise read as outside; see `bodyPointerDownRef`). The
        // host switcher's list mounts outside the body's tree as well as this
        // dialog, so it keeps its own check. Dismissing on either would throw
        // away the form someone is in the middle of filling, for the crime of
        // choosing a model or a host in it.
        onInteractOutside={(event) => {
          if (
            event.detail.originalEvent === bodyPointerDownRef.current ||
            isHostSwitcherListInteraction(event.target)
          ) {
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
            variant="muted"
            size="icon-sm"
            aria-label="Close"
            className="absolute right-0 top-0 z-10 size-6 -translate-y-1/2 translate-x-1/2 rounded-full border-border/70 bg-popover opacity-70 shadow-sm transition-opacity hover:opacity-100 focus-visible:opacity-100"
          >
            <XIcon className="size-3.5" />
          </Button>
        </DialogClose>
        <DialogTitle className="sr-only">New agent</DialogTitle>
        {open ? (
          <div
            ref={attachBody}
            className="min-h-0 flex-1 overflow-y-auto"
            data-testid="epic-sidebar-new-conversation-modal-body"
          />
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
  readonly modelPickerHarnessId?: GuiHarnessId;
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
  useEffect(() => {
    const harnessId = props.modelPickerHarnessId;
    if (harnessId === undefined) return;
    let opened = false;
    const open = (): void => {
      if (!opened)
        opened = openActiveModelPickerForHarness(
          harnessId,
          newConversationSurfaceKey(epicId),
          null,
        );
    };
    open();
    return subscribeActiveModelPicker(open);
  }, [epicId, props.modelPickerHarnessId]);
  const permissionRole = useEpicPermissionRole();
  const connectionStatus = useEpicConnectionStatus();
  const isDisconnected = connectionStatus === "closed";
  const canMutate = isEditableRole(permissionRole) && !isDisconnected;
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  // Shown again after finishing a staged send hidden (`NewConversationModalHost`):
  // the editor took focus once, when it mounted, so it takes it back here.
  // Hidden, it closes its @/slash menu, which portals to the page and holds a
  // scroll lock rather than leaving with the dialog.
  const ownsKeyboard = use(KeyboardOwnerContext);
  const ownedKeyboardRef = useRef(ownsKeyboard);
  useEffect(() => {
    const owned = ownedKeyboardRef.current;
    ownedKeyboardRef.current = ownsKeyboard;
    if (ownsKeyboard && !owned) editorRef.current?.focusAtEnd("reveal-caret");
    if (!ownsKeyboard && owned) editorRef.current?.dismissActiveSuggestion();
  }, [ownsKeyboard]);
  // A ref, not state: a re-render would change the send button's disabled look
  // for a wait that no document produces today, and the guard only has to stop
  // a second Enter from starting a second create for the same draft.
  const draftImagePrepFlight = useRef(false);
  /**
   * The re-entry half of the submit generation guard.
   *
   * `requested` is set by the commit below when the draft moved under an
   * in-flight preparation; `attempt` bounds the re-entry to ONE, so a user
   * typing through both passes sends nothing and clears nothing rather than
   * looping. Both are read and reset by the latch owner, which is the single
   * exit for every async arm here - the same shape the pre-merge modal had, on
   * upstream's structure.
   */
  const submitReentryRequested = useRef(false);
  const submitReentryAttempt = useRef(0);
  /**
   * Whether the invocation about to run IS the re-entry, rather than a fresh
   * press of Send. Only that distinction can reset `attempt` correctly, because
   * a re-entry must inherit the count and a new submit must not.
   */
  const submitReentryInProgress = useRef(false);
  /**
   * The re-entry's trigger, as STATE rather than a ref holding `handleSubmit`.
   *
   * The latch owner cannot call `handleSubmit` directly - it lives inside it -
   * and the obvious way round, a ref refreshed to the latest `handleSubmit`, is
   * refused by `react-hooks/immutability`: `handleSubmit` captures that ref, so
   * the write can never precede the capture, and hoisting the write above the
   * `useCallback` only trades the error for a forward reference the compiler
   * also refuses. Both were tried.
   *
   * So the latch owner raises this flag and the layout effect below performs
   * the call. That keeps exactly what the ref was for - the re-entry runs the
   * CURRENT `handleSubmit`, with the host the chip is showing now, not the one
   * that started the flight - which is the same staleness rule
   * `submitPreparedDraftRef` exists for. LAYOUT-timed, so the re-entry still
   * lands before paint and no press of Send can interleave with it.
   *
   * A COUNTER consumed by a ref rather than a boolean cleared in the effect:
   * clearing it there would be a `setState` inside an effect body, which is its
   * own rule. The ref records the tick already acted on, so the effect writes
   * no state and a `handleSubmit` identity change on a later render re-runs it
   * to a no-op.
   */
  const [submitReentryTick, setSubmitReentryTick] = useState(0);
  const handledSubmitReentryTick = useRef(0);
  /**
   * Whether a re-entry is queued but has not run - raised with the tick and
   * lowered by the effect before it calls. The composer's equivalent is
   * `submitReentrySource !== null`, which carries a payload; this surface's
   * re-entry takes no argument, so the marker is the whole of it.
   */
  const submitReentryQueued = useRef(false);
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
  const sessionHostClient = useEpicSessionHostClient();
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
  // A harness a team sandbox does not offer is refused at Send and at a
  // terminal launch.
  const teamSandboxHarnessBlocked = useTeamSandboxHarnessGate({
    hostId: resolvedHostId,
    client: hostClient,
  });
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
  const {
    settings: draftSettings,
    composerMode: draftComposerMode,
    workspace: draftWorkspace,
  } = useNewConversationDraftFields(epicId, seed);
  const hasSubmittableContent = useHasSubmittableContent(epicId, seed);
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
  // Record this epic's name on the draft patch so the drafts list can name
  // the row once no modal for this epic is mounted (the title comes from the
  // open-epic projector, which only exists while the epic is open). Keyed on
  // `draftId` as well as the title: the setter is a no-op until the patch
  // exists, which is the first keystroke, not this mount.
  const liveEpicTitle = useEpicTitle();
  const epicTitle = liveEpicTitle.length > 0 ? liveEpicTitle : null;
  const setNewChatEpicTitle = useNewConversationModalStore(
    (state) => state.setNewChatEpicTitle,
  );
  const draftId = useNewConversationModalStore(
    (state) => state.draftPatchesByEpicId[epicId]?.draftId ?? null,
  );
  useEffect(() => {
    if (draftId === null) return;
    setNewChatEpicTitle(epicId, epicTitle);
  }, [draftId, epicId, epicTitle, setNewChatEpicTitle]);
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
  const ultracodeCarried = useUltracodeCarrierSupported(
    resolvedHostId,
    "epic.createChat",
  );
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(draftSettings, hostClient),
    handleToolbarSettingsChange,
    {
      hostClient,
      hostId: resolvedHostId,
      tuiOnly: draftComposerMode === "terminal",
      chatLineCarriesAutoMode: null,
      ultracodeCarried,
      // The key `useInTaskSandboxStagingSurface` stages under below; a named
      // host stages nothing.
      stagedSurfaceKey:
        hostId === null ? newConversationSurfaceKey(epicId) : null,
      sendsToRestingSandbox: false,
    },
  );
  const harnessId = useStore(
    toolbarStore,
    (state) => state.selection.harnessId,
  );
  const profileId = useStore(
    toolbarStore,
    (state) => state.selection.profileId,
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
    profileId,
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
  const { isSubmitting, handStagedSandbox } = useStagedTaskAttachment({
    epicId,
    sessionHostId,
    placementHostId: resolvedHostId,
    sessionClient: sessionHostClient,
    placementClient: submitTarget.client,
    otherCreatePending: createChat.isPending || terminalAgentCreate.isPending,
  });
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
  // A request that names its host stages nothing: naming the machine IS the
  // request. Otherwise the picker offers New sandbox rows keyed by this Epic's
  // placement pin.
  // `Open terminal instead`: the staged sandbox opens a terminal in this
  // task in place of an agent, and the modal closes with the draft kept.
  const openTerminalInstead = useCallback((): void => {
    const surfaceKey = newConversationSurfaceKey(epicId);
    const staged = readStagedSandbox(surfaceKey);
    if (staged === null) return;
    const settings = pickedRunSettings(toolbarStore.getState());
    handStagedSandbox(surfaceKey, staged, () => {
      const handed = handPendingSandboxSend({
        fromSurfaceKey: surfaceKey,
        epicId,
        request: { kind: "terminal" },
        content: createEmptyNewConversationContent(),
        text: "",
        settings,
        epicConfirmed: true,
        now: Date.now(),
      });
      if (handed !== null) onSubmitted();
    });
  }, [epicId, handStagedSandbox, onSubmitted, toolbarStore]);
  const sandboxStaging = useInTaskSandboxStagingSurface(
    epicId,
    newConversationSurfaceKey(epicId),
    hostId,
    openTerminalInstead,
  );
  useNewConversationReturnedSandbox(epicId, hostId);
  const workspaceGate = useStagedWorkspaceGate(
    stagingSurfaceKey(sandboxStaging),
    workspaceAvailability,
  );
  const workspaceCanStart = workspaceGate.canStart;
  const draftWorkspaceFolderCount = draftWorkspace.folders.length;
  const runnerHost = useRunnerHost();
  const paste = useComposerHashPaste(
    editorRef,
    runnerHost.fileDrops,
    mentionRoots,
  );
  const {
    ingestPastedComposerImages,
    reingestPendingImages,
    noteContentImages,
  } = useComposerPendingImageIngest({
    editorRef,
    runPendingImageJob: paste.runPendingImageJob,
    draftId: null,
  });
  const attachmentPending = isAttachmentIngestPending(paste);
  const pickedHarnessId = useStore(
    toolbarStore,
    (state) => state.values.selection.harnessId,
  );
  const {
    hint: agentHint,
    blocked: agentBlocked,
    refusal: sandboxAgentRefusal,
    sendRefusal,
    stagedSignInCheck,
    checking: stagedCatalogueNotice,
  } = usePlacementAgentGates({
    client: hostClient,
    hostId: resolvedHostId,
    harnessId,
    pickedHarnessId,
    active: chatComposerActive,
    stagedAhead: workspaceGate.stagedAhead,
    stagedSurfaceKey: stagingSurfaceKey(sandboxStaging),
    onOpenTerminalInstead: openTerminalInstead,
    onChooseAnotherHost: () => {
      useStagedSandboxStore.getState().clear(newConversationSurfaceKey(epicId));
      dismissHostNotice();
    },
  });
  const canSubmit =
    canMutate &&
    !isSubmitting &&
    !attachmentPending &&
    workspaceCanStart &&
    !agentBlocked &&
    hasSubmittableContent;
  // The staged sandbox's send (sandboxes plan D1). Its phase 2 resubmits from
  // this body, which `NewConversationModalHost` keeps mounted until the stage
  // settles, though the modal closes. `handleSubmit` is declared below and
  // reads this hook, hence the ref.
  const { openTile } = useEpicTileNavigation();
  const stagedTerminal = useMemo(
    () => ({
      epicId,
      open: (target: TerminalLaunchTarget) => {
        openTile(
          tileIntent(
            mintNewEpicTerminalTile({ ...target, epicId }),
            { tabId },
            "explicit",
            "direct_ui",
          ),
        );
      },
    }),
    [epicId, openTile, tabId],
  );
  // The latest resubmit, set below once `handleSubmit` and the terminal
  // dispatch are declared.
  const stagedSubmitRef = useRef<() => StagedResubmit>(() => false);
  // A terminal agent's Start that a staged sandbox took: launched on the new
  // host in phase 2, as the chat send resubmits there. The stage keeps it, and
  // the host keeps this body, so closing the modal while the sandbox boots
  // does not drop it.
  const stagedTerminalLaunch = useStagedTerminalLaunch(
    stagingSurfaceKey(sandboxStaging),
  );
  const stagedProviders = useProvidersListForClient(hostClient, {
    enabled: stagedTerminalLaunch !== null,
    subscribed: stagedTerminalLaunch !== null,
  });
  // Phase 2 resubmits once the new host's catalog has answered, so the
  // selection holds its default model, or none when it offers no agent: that
  // resubmit is refused, and the line says the sandbox is awake but cannot
  // run one. A Start also waits for its providers, which say whether the
  // profile is offered there.
  const catalogSettled = useStore(toolbarStore, (s) =>
    catalogSettledFor(s, resolvedHostId),
  );
  const submitOnSandbox = useCallback(
    (): StagedResubmit => stagedSubmitRef.current(),
    [],
  );
  // Folders picked on the old host are not the new one's: the draft takes the
  // new host's workspace, which starts empty, before the resubmit.
  const prepareSandboxHandoff = useCallback((): void => {
    useNewConversationModalStore.getState().clearWorkspace(epicId);
  }, [epicId]);
  useStagedSandboxHandoff({
    surfaceKey: stagingSurfaceKey(sandboxStaging),
    resolvedHostId,
    canSubmit: stagedResubmitReady({
      catalogSettled,
      launch: stagedTerminalLaunch,
      canSubmit,
      canStart: [canMutate, workspaceCanStart, !isSubmitting],
      providers: stagedProviders,
    }),
    submit: submitOnSandbox,
    prepareHandoff: prepareSandboxHandoff,
    // The epic's tabs share its stage; the handoff is the sending tab's,
    // gone with its host (the tab closed).
    ownerId: tabId,
    watchOwner: ownerGoneOnUnmount,
  });
  const stagedSend = useStagedSandboxSend({
    surfaceKey: stagingSurfaceKey(sandboxStaging),
    terminal: stagedTerminal,
    taskId: epicId,
    ownerId: tabId,
    // The draft is the epic's, so any tab's body holds the one that sent.
    claimsSend: true,
  });
  const composerDisabledHint =
    mutationDisabledHint(permissionRole, isDisconnected, "make changes") ??
    workspaceGate.disabledHint ??
    agentHint;
  const epicImagePresence = useEpicAttachmentBytesPresence();
  // Local partition OR epic replica, for the PASTE filter. On its own the epic
  // map strips a pasted hash-only node whose bytes are in this window's image
  // store, because it only ever answers for a SENT image.
  //
  // THIS SURFACE HAS NO "no predicate" STATE. The prop stays nullable because
  // `chat-paste-handler` reads `null` as "do not filter" and other surfaces
  // still send it, but answering `true` while the snapshot loads says the same
  // thing as a predicate rather than as an absence - and a predicate is the
  // thing every consumer can use. Pre-readiness is the only moment the two
  // spellings could differ; once the snapshot lands both are this same union.
  const hasPastedImageBytes = useCallback(
    (hash: string) => {
      if (hasLandingImageBytes(hash)) return true;
      // Not loaded yet. Withholding judgement means admitting the hash: this
      // filter exists to drop nodes whose bytes are nowhere, and "I cannot tell
      // yet" is not that.
      if (epicImagePresence === null) return true;
      return epicImagePresence(hash);
    },
    [epicImagePresence],
  );
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
      sandboxStaging={sandboxStaging}
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
    raiseSendRefusal,
    dismiss: dismissHostNotice,
  } = useComposerHostNotice(resolvedHostId, sendRefusal);
  // The mirror line, once per task: the start host has another owner than a
  // host already working here. A refusal outranks it in the one slot; it is
  // marked seen when dismissed or when the agent starts.
  const mirrorLine = useComposerMirrorLine(epicId, resolvedHostId);
  const topNotice = composerTopNotice(
    hostNotice,
    dismissHostNotice,
    mirrorLine,
  );
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
  const mirrorLineShown = mirrorLine.notice !== null;
  const markMirrorLineSeen = mirrorLine.markSeen;
  const cleanupAfterSubmit = useCallback((): void => {
    if (mirrorLineShown) markMirrorLineSeen();
    clearDraft(epicId);
    useNewConversationAnnotationStore.getState().clear(epicId);
    clearStagedIntent(stagingKey);
    editorRef.current?.clear();
    onSubmitted();
  }, [
    clearDraft,
    clearStagedIntent,
    epicId,
    markMirrorLineSeen,
    mirrorLineShown,
    onSubmitted,
    stagingKey,
  ]);
  const worktreeIntentForSubmit = useCallback(
    (): WorktreeIntent | null =>
      effectiveWorktreeIntent({
        workspace: draftWorkspace,
        seedIntent: latestWorkspaceSeed?.intent ?? null,
        stagedIntent: readStagedWorktreeIntent(stagingKey),
      }),
    [draftWorkspace, latestWorkspaceSeed, stagingKey],
  );
  /**
   * The create itself, over the document that is actually going to be sent.
   *
   * `liveContent` is a parameter rather than a read off `editorRef` because
   * the byte-resolution branch below re-reads the live document AFTER its
   * await and hands that re-read in - so every guard from here down, the
   * §54 placement re-validation included, runs against the same document the
   * create carries, and a keystroke typed during resolution rides along
   * instead of being cleared unsent.
   */
  const submitPreparedDraft = useCallback(
    (
      liveContent: JsonContent,
      /**
       * Whether `liveContent` still carries hash-only image nodes for the host
       * to materialize out of this account's draft-blob tier -
       * `epic.createChat@1.2`'s `attachmentsByHash`.
       *
       * A parameter rather than something re-derived here, because it is a fact
       * about the document its caller prepared: only that caller knows the
       * remaining hash-only nodes are host-CONFIRMED rather than simply
       * unresolved, and the two look identical from inside this function.
       */
      attachmentsByHash: boolean,
    ) => {
      if (!canSubmit) return;
      // The document arrives as an argument now, but a surface with no editor
      // still has nothing to create from - and `cleanupAfterSubmit` below
      // reaches for the handle to clear it.
      if (editorRef.current === null) return;
      const toolbar = toolbarStore.getState();
      if (toolbar.selection.modelSlug.length === 0) return;
      const settings = buildChatRunSettings({
        selection: toolbar.selection,
        permission: toolbar.permission,
        reasoning: toolbar.reasoning,
        serviceTier: toolbar.serviceTier,
        ultracode: toolbar.ultracode,
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
        raiseHostNotice({
          kind: "refused",
          message: placementVerdict.message,
          action: null,
        });
        return;
      }
      // No render-vs-live drift check needed here (main's #1231 added one for
      // the reactive-active-host shape): the staged key and this create both
      // derive from the SAME captured submitTarget, and the verdict REFUSES
      // rather than migrates when its frozen client no longer addresses it.
      const activeHostId = placementVerdict.hostId;
      // Before any write, like the placement check above: a refusal leaves the
      // draft and its cards exactly as the user left them.
      const sidecar = annotationSidecarForCreate(epicId, activeHostId);
      if (sidecar.kind === "refused") {
        raiseHostNotice({ kind: "refused", message: sidecar.message, action: null });
        return;
      }
      const { browserAnnotations } = sidecar;
      recordPlacement(activeHostId);
      const content = buildSubmittedChatJSONContent(
        appendImageAttachmentAtoms(liveContent, sidecar.atoms),
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
              // The SAME document the handoff registered above, not a second
              // one. `handleSubmit` prepares exactly one: inline base64 for
              // every image this host could not take by hash, bare hashes for
              // the ones it confirmed. The handoff's copy is kept free of
              // base64 by `initial-chat-handoff-store`'s persist `partialize`,
              // which is where that concern belongs - two documents here could
              // describe two different messages.
              content,
              sender: { type: "user" as const, userId },
              settings,
              accountContext,
              // The machine this modal runs on, NOT `activeHostId` (where the
              // chat is created): read at submit exactly as a send frame reads
              // it, so the first turn's browser is placed by the same fact as
              // every later one.
              sentFromHostId: readLocalHostIdSnapshot(),
              // Spread rather than a `false` literal, like the opt-in below:
              // absent and `false` read identically on the host, and a request
              // that names the key only when it is asking for something keeps
              // the wire honest about which creates carry hashes.
              ...(attachmentsByHash
                ? { attachmentsByHash: true as const }
                : {}),
              ...(browserAnnotations.length > 0 ? { browserAnnotations } : {}),
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
      // Read by the deferred create's binding-seed release closure.
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
  // The LATEST submit, for the continuation below to call. Its closure carries
  // `canSubmit` and the placement it re-validates, and both can move while the
  // byte read is in flight - a verdict captured before the await is stale by
  // construction. Same shape the composer editor uses for its presence getter.
  //
  // LAYOUT-timed: a passive effect can run after the byte read resumes in the
  // post-commit microtask, so the continuation would call the submit from the
  // render BEFORE the change - carrying the stale `canSubmit` and placement
  // this ref exists to refresh.
  const submitPreparedDraftRef = useRef(submitPreparedDraft);
  useLayoutEffect(() => {
    submitPreparedDraftRef.current = submitPreparedDraft;
  }, [submitPreparedDraft]);
  /**
   * The LIVE destination, for the in-flight preparation to re-check.
   *
   * The picker stays usable while an upload runs, and a confirmation is a fact
   * about ONE machine's draft-blob tier - so the flight has to be able to ask
   * "is this still the host I confirmed against", which a value captured when
   * the flight started cannot answer. LAYOUT-timed for the same reason the
   * submit ref above is: the preparation resumes in a post-commit microtask,
   * and a passive effect can still be pending then.
   */
  const submitTargetRef = useRef(submitTarget);
  useLayoutEffect(() => {
    submitTargetRef.current = submitTarget;
  }, [submitTarget]);
  const stagedSubmitAttempt = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      stagedSubmitAttempt.current = null;
    },
    [],
  );

  const submitStagedSandbox = useCallback(
    (
      stagedKey: string,
      staged: StagedSandbox,
      captured: JsonContent,
    ): Promise<void> => {
      if (stagedSubmitAttempt.current !== null) return Promise.resolve();
      const attempt = Symbol();
      stagedSubmitAttempt.current = attempt;
      const account = signedInUserId();
      const settings = pickedRunSettings(toolbarStore.getState());
      const settingsKey = JSON.stringify(settings);
      const revision =
        useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
          ?.revision ?? 0;

      // An agent the sandbox does not offer is refused here,
      // before anything is created or woken; the draft and the chip stay.
      return stagedSignInCheck
        .beforeSend(staged)
        .then((signedOut) => {
          if (
            stagedSubmitAttempt.current !== attempt ||
            readStagedSandbox(stagedKey) !== staged ||
            signedInUserId() !== account ||
            JSON.stringify(pickedRunSettings(toolbarStore.getState())) !==
              settingsKey ||
            (useNewConversationModalStore.getState().draftPatchesByEpicId[
              epicId
            ]?.revision ?? 0) !== revision
          )
            return;
          if (signedOut !== null) {
            raiseSendRefusal();
            return;
          }
          const content = buildSubmittedChatJSONContent(
            captured,
            pickerStore.getState().knownSlashCommands,
          );
          handStagedSandbox(stagedKey, staged, () => {
            const handed = handPendingSandboxSend({
              fromSurfaceKey: stagedKey,
              epicId,
              // The pane this modal was opened for, as the ordinary create takes it.
              request: { kind: "chat", parentId, placement },
              content,
              text: composerDisplayPlainText(content),
              settings,
              epicConfirmed: true,
              now: Date.now(),
            });
            if (handed !== null) cleanupAfterSubmit();
          });
          return;
        })
        .finally(() => {
          stagedSubmitAttempt.current = null;
        });
    },
    [
      cleanupAfterSubmit,
      epicId,
      handStagedSandbox,
      parentId,
      pickerStore,
      placement,
      raiseSendRefusal,
      stagedSignInCheck,
      toolbarStore,
    ],
  );

  /**
   * Submit, with the byte-resolution step in front of it.
   *
   * THE CREATE LINE NEGOTIATES ITS OWN MINOR, and that is the distinction this
   * comment exists to keep. `epic.createChat` is UNARY and precedes any chat
   * stream, so there is no negotiated SESSION here and `chat.subscribe`'s
   * `draftBlobBridgeSupported()` is not a question this surface may ask - a
   * sibling tab's stream proves nothing about this call. What the absence of a
   * stream rules out is the STREAM's gate; it never ruled out a gate. The unary
   * method carries its own `{major, minor}`, so `epic.createChat@1.2` answers
   * for exactly this call, and `createAttachmentsByHashSupported` is the only
   * capability read on this path.
   *
   * So the prompt does NOT always travel inline any more. At `@1.2` the block
   * below uploads this window's eligible bytes to the target host's draft-blob
   * tier first; whatever that host CONFIRMS holding is subtracted from the set
   * still owed bytes, stays hash-only, and `attachmentsByHash` is read off the
   * document actually dispatched. Below `@1.2`, and for anything the host does
   * not confirm, the inline path is unchanged - a failed upload is not a
   * refusal, it is simply not host-held.
   *
   * A document with nothing to resolve still takes the synchronous path
   * verbatim. The await below exists only for a hash-only node, and everything
   * it changes about ordering is confined to the branch that has one.
   */
  const handleSubmit = useCallback((): void => {
    // THE ATTEMPT COUNT BELONGS TO ONE PRESS OF SEND, so it is reset here
    // rather than on the way out.
    //
    // `attempt` is decremented by nothing and cleared only by the latch owner,
    // which runs exclusively when the async arm ran. Every other way out of
    // this function - `canSubmit` false, no editor, and the synchronous fast
    // path below - leaves it standing. A re-entry that lands on any of those
    // therefore left `attempt` at 1 for the life of this component, and the
    // NEXT submit that genuinely needed a re-entry was refused one and
    // abandoned: no create, no toast, nothing to see.
    //
    // Reset at the single ENTRY instead of at each of those three exits: the
    // exits are a set that grows, and a guard placed on today's members is one
    // the next early return is added beside rather than into. ("The modal
    // unmounts between uses" would also bound it, but that is a fact about a
    // Dialog someone can make persistent without ever reading this file.)
    const isReentry = submitReentryInProgress.current;
    submitReentryInProgress.current = false;
    if (!isReentry) submitReentryAttempt.current = 0;
    // The ENTRY gate, restored. `submitPreparedDraft` re-checks `canSubmit`
    // live at the end, which is the check that matters for a condition that
    // arrives DURING the read - but without one here, a Cmd/Ctrl+Enter pressed
    // while the host is disconnected or ingestion is pending still started the
    // flight (`usePrimaryActionShortcut` invokes the callback so it can claim
    // the shortcut, unlike a disabled button). If the condition then cleared
    // before resolution finished, the live check passed and the chat was
    // created from a keystroke the user had every reason to read as a no-op.
    if (!canSubmit) return;
    if (sandboxAgentRefusal !== null) {
      raiseSendRefusal();
      return;
    }
    const editor = editorRef.current;
    if (editor === null) return;
    // Planned over the document the create will carry: with the sidecar's
    // crops appended, a node holds bytes beside its hash, which is the case
    // the by-hash upload below declines, so a create with cards stays on the
    // inline path and the host never probes a crop's hash in its staging tier.
    const captured = appendImageAttachmentAtoms(
      editor.getJSON(),
      sessionAnnotationImageAtoms(readNewConversationAnnotations(epicId)) ??
        [],
    );
    // A staged sandbox takes the send (sandboxes redesign Flow 1): the
    // message waits in this task, behind the setup line, until the agent the
    // person picked is ready on the sandbox, and the modal closes at once. It
    // runs on that agent and model, never one this host would swap in.
    const stagedKey = stagingSurfaceKey(sandboxStaging);
    const staged = stagedKey === null ? null : readStagedSandbox(stagedKey);
    if (stagedKey !== null && staged !== null && staged.phase !== "handoff") {
      void submitStagedSandbox(stagedKey, staged, captured);
      return;
    }

    // This host's own gate, after the stage's: a staged sandbox is not this
    // host, and the send runs on it under its own.
    if (
      teamSandboxHarnessBlocked(toolbarStore.getState().selection.harnessId)
    ) {
      raiseHostNotice({
        kind: "refused",
        message: TEAM_SANDBOX_HARNESS_UNAVAILABLE,
        action: null,
      });
      return;
    }
    // The draft this submit is FOR. The editor stays editable across the reads
    // below and the create ends in `cleanupAfterSubmit`, which clears the draft
    // store and the editor - so without this, a sentence typed during the read
    // is wiped by a create that sent the document from before it. The modal's
    // `revision` bumps on `setContent` alone: there is no annotation sidecar
    // here, and a caret move is not work worth cancelling a send over.
    const generation = captureComposerSubmitGeneration(
      () =>
        useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
          ?.revision ?? 0,
    );
    // Nothing this surface INHERITS from the host, so the host-held set starts
    // empty: a new chat has no sent message and no queued prompt to re-open.
    // `epic.createChat@1.2` is what can WIDEN it - see the upload below - and
    // the widened set is read live at every call rather than captured, because
    // it grows when the upload confirms, mid-flight and after this line.
    const hostHeldRef = { current: NO_CONFIRMED_HASHES };
    // The machine those confirmations are ABOUT. A digest confirmed on host A
    // is NOT host-held on host B, and the picker stays live through the upload,
    // so a switch has to retract the whole set rather than carry it across.
    //
    // Retracting is enough to make the switch land correctly, and the
    // reconcile loop is why: `readRequiredHashes` is consulted after every
    // pass, so digests that stop being host-held come back as REQUIRED, are
    // resolved on the next pass, and are inlined at commit. The create then
    // goes to the new host carrying bytes instead of references that host never
    // received - one create, on the new host, inline.
    const flightHostId = resolvedHostId;
    const liveHostHeld = (): ReadonlySet<string> =>
      submitTargetRef.current.resolvedHostId === flightHostId
        ? hostHeldRef.current
        : NO_CONFIRMED_HASHES;
    const pending = draftImageInliningNeeded(captured, NO_HOST_HELD_HASHES);
    const readRequiredHashes = (): ReadonlyArray<string> => {
      const live = editorRef.current;
      if (live === null) return [];
      return draftImageInliningNeeded(live.getJSON(), liveHostHeld());
    };
    if (pending.length === 0) {
      submitPreparedDraft(captured, false);
      return;
    }
    // One preparation at a time. A second Enter during resolution would
    // otherwise start a second create for the same draft.
    if (draftImagePrepFlight.current) return;
    draftImagePrepFlight.current = true;
    const incarnation = editor.getEditorIncarnation();
    const holderId = `new-conversation-submit:${epicId}`;
    // The captured document is the only thing that still names these bytes if
    // the draft row is replaced while the read is in flight, so it is a GC root
    // for exactly as long as the preparation runs.
    // Resolved inside the continuation, not captured here: a draft mirror is
    // acquired and released as tiles mount, and the live session is the one
    // that can answer. The hold/release try/finally lives in the helper: a
    // `try` without a `catch` in a hook body defeats the React Compiler's
    // memoization.
    void withHeldComposerContentImageRoots(
      holderId,
      captured,
      async () => {
        // `epic.createChat@1.2` MATERIALIZES from the host's own draft-blob
        // tier, so a digest this host confirms need not be inlined at all.
        // Uploaded first, before `prepareDraftImageInlining`, because the
        // preparation's contract is that the caller has finished all its other
        // awaiting - an await left running beside it is another window for an
        // image to arrive unattended.
        //
        // Best effort by construction: what the host does not confirm is simply
        // not host-held, and is inlined by the pass below exactly as it was
        // before `@1.2` existed.
        const byHashClient = submitTarget.client;
        // NARROWED here rather than asserted. A modal with no resolved host has
        // no machine to confirm against, and the honest answer is the one this
        // surface gave before `@1.2` existed: leave the set empty and let the
        // pass below inline everything.
        //
        // `flightHostId` and not `resolvedHostId`, though they hold the same
        // value: it is the id `liveHostHeld` compares against, and recording
        // confirmations under one id while validating them under another is the
        // one way this arm could hand the host a digest it never received.
        const byHashHostId = flightHostId;
        const plan = planAttachmentsByHash(captured);
        // THE SAME FOUR CONDITIONS THE LANDING COMPOSER GATES ON, and they are
        // spelled out here rather than inherited because the two create
        // surfaces must not drift: any failure lands on the inline path below,
        // the one that has always worked.
        //  - a client to upload on, and a host to upload to;
        //  - no node carrying BOTH base64 and a hash. A crop atom is the case:
        //    the host's `collectAttachmentHashes` would probe that hash while
        //    the bytes ride inline beside it, and refuse the whole create with
        //    `missing-attachment-bytes` - after the modal has closed and
        //    cleared the draft, so the user loses the prompt. No create surface
        //    mints crops today, which is what makes this inert rather than a
        //    live bug; it is kept because "inert" is a fact about the SURFACES
        //    that feed this one, not about this code, and the surface that
        //    changes it will not be this file.
        //  - at least one node the preparer marked eligible, so there is
        //    something to gain from a round trip at all;
        //  - the negotiated minor of the method this create actually
        //    dispatches on, read at dispatch and failing closed.
        if (
          byHashClient !== null &&
          byHashHostId !== null &&
          !plan.hasInlineHashedNode &&
          plan.eligible.length > 0 &&
          createAttachmentsByHashSupported(byHashHostId, "epic.createChat")
        ) {
          // BEFORE the upload: an eligible set already over the cap can never
          // come back under it, so uploading its blobs would be work for a
          // create that cannot succeed. A REFUSAL and not a silent empty set -
          // narrating it here is the only chance the user gets, because the
          // post-inlining check below counts a different population (it also
          // counts hashes this window never owned bytes for) and an eligible
          // set of 33 that all inline cleanly would reach it as zero.
          if (exceedsCreateAttachmentHashCap(plan.eligible)) {
            reportCreateAttachmentHashCapExceeded();
            return;
          }
          hostHeldRef.current = await confirmCreateAttachmentHashes({
            hostId: byHashHostId,
            client: byHashClient,
            plan,
            // Read at the upload, not captured when the flight started: the
            // identity can change in between, and a confirmation recorded under
            // one account is invisible to a gate asking under another.
            ownerUserId: currentDraftBlobOwnerId(),
          });
        }
        await prepareDraftImageInlining({
          // Recomputed against the widened set: a digest the host just
          // confirmed is no longer owed bytes by this client.
          initialHashes: draftImageInliningNeeded(captured, liveHostHeld()),
          target: draftImageByteTargetForHost(resolvedHostId),
          // An image pasted while the read ran would otherwise be sent bare
          // with its bytes sitting right here, and an initial create's epic has
          // never seen it - so a send this could have completed is refused.
          readRequiredHashes,
          // Synchronous with the final required-set read above it: nothing can
          // arrive between that check and this send.
          commit: (base64ByHash) => {
            const live = editorRef.current;
            // No editor at all: there is nothing to send and nothing to
            // re-enter for. The only plain abort here.
            if (live === null) return;
            // THE DRAFT MOVED UNDER THIS FLIGHT, by either of its two carriers.
            //
            // A different editor incarnation is a different document, and so is
            // a bumped draft revision; both mean the same thing for this
            // decision, so they are asked together rather than as two guards
            // that could disagree. Sending the captured document would send
            // something the user can no longer see, and `cleanupAfterSubmit`
            // would then clear a surface that never asked.
            //
            // The answer is to RE-ENTER, not to abort. Re-reading the live
            // editor below keeps the user's newer text, but it does not re-plan
            // - which digests are eligible, whether the cap is blown, and which
            // host they were confirmed against were all decided from the
            // pre-await capture. Aborting instead would leave a user who
            // pressed Enter with nothing sent and no notice; re-entry derives
            // the whole plan from the document actually on screen.
            if (
              live.getEditorIncarnation() !== incarnation ||
              !generation.stillCurrent()
            ) {
              // Bounded to ONE: typing through both passes sends nothing and
              // clears nothing, leaving the draft intact to send again.
              if (submitReentryAttempt.current === 0) {
                submitReentryRequested.current = true;
              }
              return;
            }
            // Re-read, exactly as the chat composer's annotation read does: the
            // revision moves on every keystroke, so comparing it would drop a
            // send for one typed character, and the pre-flight capture is not
            // what the user is looking at by the time the modal closes.
            const inlined = inlineHashOnlyImageBytes(
              live.getJSON(),
              base64ByHash,
            );
            // NO refusal for a node this window could not resolve, and that is
            // a deliberate difference from the landing composer rather than an
            // omission.
            //
            // The pre-merge upstream arm refused here, on the premise that "a
            // leg that missed leaves its node hash-only with nothing able to
            // resolve it". That premise does not hold on THIS surface: the epic
            // already exists, and a chat document routinely carries hashes whose
            // bytes were never in this window's store at all - an image copied
            // out of a rendered message, a quote seed - which address the epic's
            // own attachment store and are resolved there first, before the host
            // looks at the staging tier. Refusing them breaks creates that work
            // today, and the client cannot tell that population apart from a
            // genuinely lost byte. `epic.create` (landing) is the surface where
            // refusing IS right, because no epic exists yet to resolve against.
            //
            // It is also the rule `draft-image-inlining.ts` states for every
            // caller: a node whose bytes resolve nowhere is left hash-only and
            // the host's dangling-hash guard decides. The client never refuses a
            // send because its own replica came up empty.
            //
            // What the request will actually carry as bare hashes - host-held,
            // epic-store and unresolved alike, because the host's cap counts
            // them all the same way.
            const wireHashes = hashOnlyImageHashes(inlined);
            // The cap is the HOST's, counted over the whole request, so it is
            // decided here rather than on the eligible set: a single uploaded
            // image beside thirty-two copied out of the epic clears the
            // pre-upload check and is still refused by the host - with an
            // `InvalidArgumentError` no surface renders, after the modal has
            // closed and cleared the draft.
            if (exceedsCreateAttachmentHashCap(wireHashes)) {
              reportCreateAttachmentHashCapExceeded();
              return;
            }
            // Derived from the document, never decided beside it: the flag
            // means "this request carries hash-only nodes the host must
            // resolve", and reading it off `inlined` makes it impossible to
            // claim that of a document a late paste left fully inline.
            submitPreparedDraftRef.current(inlined, wireHashes.length > 0);
          },
        });
      },
      () => {
        // The single exit. The latch is released FIRST so the re-entry below is
        // not turned away by its own predecessor's flight, and the re-entry runs
        // from here rather than from `commit` for exactly that reason: `commit`
        // is still inside the preparation, and the helper's own release would
        // land after a nested flight had claimed the latch.
        draftImagePrepFlight.current = false;
        if (!submitReentryRequested.current) {
          // Only when nothing is QUEUED. The tick below is delivered on a
          // macrotask, so between it and the layout effect a second chain can
          // start and settle here - and resetting the count then would wipe the
          // bound belonging to a re-entry that has not run yet. Unreachable
          // today (a second chain with images cannot settle first, and one
          // without sends and empties the draft, so the queued re-entry dies on
          // the empty-draft guard), which is exactly why it is written down: it
          // holds by ARGUMENT about today's control flow, not by construction,
          // and the argument dies the day someone adds an await to the fast
          // path.
          if (!submitReentryQueued.current) submitReentryAttempt.current = 0;
          return;
        }
        submitReentryRequested.current = false;
        submitReentryAttempt.current += 1;
        submitReentryInProgress.current = true;
        // THE GAP IS A MACROTASK, NOT A COMMIT. This runs in a promise
        // continuation, so React schedules the render through the Scheduler's
        // MessageChannel instead of flushing inline, and the browser can
        // dispatch queued input before the layout effect runs. The latch was
        // released four lines up, so a keystroke landing in that window starts
        // its OWN flight and the queued re-entry is then turned away by
        // `draftImagePrepFlight` and silently dropped.
        //
        // That costs nothing: the user's own submit re-reads the live document
        // and sends it, which is the same outcome the re-entry existed to
        // produce - one send, current text. Recorded because the direct call
        // this replaced could not be dropped, so the property is new.
        submitReentryQueued.current = true;
        setSubmitReentryTick((tick) => tick + 1);
      },
    ).catch((error: unknown) => {
      // The third call site of this helper, and the same rule as the other
      // two: it propagates deliberately rather than swallowing, so `void`
      // alone left a rejection unhandled. The flight flag is cleared by the
      // helper's `finally` either way, and the draft is untouched.
      //
      // But untouched is not the same as EXPLAINED. This modal has a visible
      // notice channel and the two refusals beside it already use it, so a
      // failure that only reached the log left the user pressing Send and
      // watching nothing happen.
      appLogger.error(
        "[new-conversation] submit image preparation failed",
        { epicId },
        error,
      );
      raiseHostNotice({
        kind: "refused",
        message:
          "The images in this prompt could not be prepared. The draft has been kept - try again.",
        action: null,
      });
    });
  }, [
    canSubmit,
    epicId,
    raiseHostNotice,
    raiseSendRefusal,
    resolvedHostId,
    sandboxAgentRefusal,
    sandboxStaging,
    // The client the by-hash upload dispatches on, and it must be the CURRENT
    // one: the host picker stays live while the upload runs, and bytes put on
    // the machine the chip stopped showing are bytes the create's host never
    // received.
    submitTarget,
    setSubmitReentryTick,
    submitStagedSandbox,
    submitPreparedDraft,
    teamSandboxHarnessBlocked,
    toolbarStore,
  ]);
  // The re-entry itself. Declared AFTER `handleSubmit` so it can name it
  // directly - that is the whole point of routing through state instead of a
  // ref.
  //
  // RECORDING THE TICK BEFORE CALLING IS WHAT MAKES THIS STRICTMODE-SAFE, and
  // it is not a stylistic ordering. Dev double-invokes effects on the same
  // component instance, and refs survive that simulated remount - so the second
  // invoke reads its own write and early-returns. The naive
  // `useLayoutEffect(() => handleSubmit(), [tick])` would submit TWICE in dev
  // and once in prod, which is the worst shape that bug can take.
  //
  // LAYOUT-timed so the re-entry lands before paint, ahead of any input the
  // macrotask window queued. Unlike the composer's copy there is no
  // intermediate visible frame to suppress here: this surface's flight flag is
  // a ref (`draftImagePrepFlight`), so clearing it commits nothing, and
  // `isSubmitting` tracks the create mutation rather than the preparation.
  useLayoutEffect(() => {
    if (submitReentryTick === handledSubmitReentryTick.current) return;
    handledSubmitReentryTick.current = submitReentryTick;
    submitReentryQueued.current = false;
    handleSubmit();
  }, [submitReentryTick, handleSubmit]);
  // Whether the create was sent: false on a refusal, which says why inline.
  const dispatchStartTerminal = useCallback(
    (launch: TerminalAgentLaunch): boolean => {
      if (!canMutate || !workspaceCanStart) return false;
      if (teamSandboxHarnessBlocked(launch.harnessId)) {
        raiseHostNotice({
          kind: "refused",
          message: TEAM_SANDBOX_HARNESS_UNAVAILABLE,
          action: null,
        });
        return false;
      }
      // Same §54 gate as `handleSubmit`, and for the same ordering reason:
      // `cleanupAfterSubmit` runs before the async create, so a placement that
      // cannot be created on must be refused here or the draft is gone before
      // anything reports the failure.
      const placementVerdict = resolveLandingPlacement(submitTarget);
      if (placementVerdict.kind === "refused") {
        raiseHostNotice({
          kind: "refused",
          message: placementVerdict.message,
          action: null,
        });
        return false;
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
      return true;
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
      teamSandboxHarnessBlocked,
      terminalAgentCreate,
      worktreeIntentForSubmit,
      workspaceCanStart,
    ],
  );
  const handleStartTerminal = useCallback(
    (launch: TerminalAgentLaunch) => {
      if (!canMutate || !workspaceCanStart) return;
      // A staged sandbox takes the Start as it takes a send.
      if (stagedSend.intercept("terminal", launch)) return;
      dispatchStartTerminal(launch);
    },
    [canMutate, dispatchStartTerminal, stagedSend, workspaceCanStart],
  );
  // A layout effect, so the staged handoff's effect (a passive one, declared
  // earlier) reads this render's resubmit, not the last one's. Only a terminal
  // agent's Start is resubmitted on the sandbox, assembled again for it: a
  // send hands its message to the task instead. No launch on the new host is
  // no agent there.
  useLayoutEffect(() => {
    const providers = stagedProviders.data?.providers;
    stagedSubmitRef.current =
      stagedTerminalLaunch === null
        ? () => false
        : () => {
            const launch = stagedTerminalLaunchOnHost(
              stagedTerminalLaunch,
              toolbarStore.getState(),
              providers,
            );
            if (launch === null) return false;
            return dispatchStartTerminal(launch)
              ? true
              : Promise.resolve(false);
          };
  }, [
    dispatchStartTerminal,
    stagedProviders.data,
    stagedTerminalLaunch,
    toolbarStore,
  ]);
  usePrimaryActionShortcut(chatComposerActive, handleSubmit);
  const handleDocumentChange = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      setContent(epicId, content);
      // Persist the caret alongside the bytes so a focus round-trip that
      // unmounts + remounts the editor restores it (see `initialSelection`).
      setSelection(epicId, selection);
      // See `chat-composer.tsx` for why an on-change caller is needed at all:
      // a b64 node can enter long after mount without going through a paste.
      noteContentImages(content);
    },
    [epicId, noteContentImages, setContent, setSelection],
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
    <ComposerStagedSurfaceKeyProvider
      surfaceKey={stagingSurfaceKey(sandboxStaging)}
    >
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
        stagedAhead={workspaceGate.stagedAhead}
        header={header}
        topBanner={
          <>
            {stagedSend.line}
            <ComposerHostNotice
              notice={topNotice.notice}
              pendingNotice={stagedCatalogueNotice}
              onDismiss={topNotice.dismiss}
            />
          </>
        }
        // Same rule as the landing composer's row (`landing-composer.tsx`): six
        // pills do not fit a phone-width row, so below `md` the agent-mode pill
        // moves into the options sheet behind the permission pill. This modal
        // used to opt out and render the desktop row at any width, which made
        // one composer look like two depending on where it was opened from.
        toolbarLayout={isMobile ? "collapsed" : "full"}
        // Already a sheet of its own; a second one over it would fight the
        // dialog for the screen.
        expansion={null}
        draftsControl={null}
        attachmentsStrip={
          <NewConversationModalAttachmentStrip
            epicId={epicId}
            hostId={resolvedHostId}
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
        onEditorReady={reingestPendingImages}
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
    </ComposerStagedSurfaceKeyProvider>
  );
}

/** Attaches a staged task before handing its current draft to the sandbox. */
function useStagedTaskAttachment(input: {
  readonly epicId: string;
  readonly sessionHostId: string | null;
  readonly placementHostId: string | null;
  readonly sessionClient: HostClient<HostRpcRegistry> | null;
  readonly placementClient: HostClient<HostRpcRegistry> | null;
  readonly otherCreatePending: boolean;
}): {
  readonly isSubmitting: boolean;
  readonly handStagedSandbox: (
    surfaceKey: string,
    staged: StagedSandbox,
    hand: () => void,
  ) => void;
} {
  const { epicId } = input;
  const taskHostTeamId = useHostOwnerTeamId(
    input.sessionHostId ?? input.placementHostId,
  );
  const attachClient = useEpicAttachmentClient(
    input.sessionClient ?? input.placementClient,
  );
  const attachEnvironment = useEpicAttachEnvironment(attachClient);
  const attachEnvironmentAsync = attachEnvironment.mutateAsync;
  const stageAttachmentRef = useRef<StagedSandbox | null>(null);
  // A team's sandbox can serve this task only after the person's own host
  // attached it. Keep the stage and draft until that step succeeds.
  const handStagedSandbox = useCallback(
    (surfaceKey: string, staged: StagedSandbox, hand: () => void): void => {
      if (stageAttachmentRef.current !== null) return;
      const configuration = staged.target.configuration;
      if (
        configuration.kind !== "team" ||
        configuration.teamId === taskHostTeamId
      ) {
        hand();
        return;
      }
      if (attachClient === null) {
        toastAttachEnvironmentNeedsOwnHost();
        return;
      }
      const userId = useAuthStore.getState().profile?.userId ?? null;
      const generation = captureComposerSubmitGeneration(
        () =>
          useNewConversationModalStore.getState().draftPatchesByEpicId[epicId]
            ?.revision ?? 0,
      );
      const stillCurrent = (): boolean =>
        transitionPendingSend(
          { kind: "chat", phase: "staged", blocker: "none" },
          "handoff",
          {
            ...UNKNOWN_PENDING_SEND_FACTS,
            current: generation.stillCurrent(),
            owns: true,
            epicConfirmed: true,
            accountActive:
              (useAuthStore.getState().profile?.userId ?? null) === userId,
            stageCurrent: readStagedSandbox(surfaceKey) === staged,
          },
        ).effects.includes("handoff");
      stageAttachmentRef.current = staged;
      void attachEnvironmentAsync({ epicId, teamId: configuration.teamId })
        .then(() => {
          if (stillCurrent()) hand();
        })
        .catch((error: unknown) => {
          if (isAttachEnvironmentUnsupported(error) && stillCurrent()) hand();
        })
        .finally(() => {
          if (stageAttachmentRef.current === staged) {
            stageAttachmentRef.current = null;
          }
        });
    },
    [attachClient, attachEnvironmentAsync, epicId, taskHostTeamId],
  );
  return {
    isSubmitting: input.otherCreatePending || attachEnvironment.isPending,
    handStagedSandbox,
  };
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

/**
 * The draft's NON-content fields, over the seed. `content` is rewritten on
 * every keystroke (see `handleDocumentChange`); subscribing to the whole
 * patch here would re-render the entire modal body per character. Live
 * content is routed to an isolated subscriber
 * (`NewConversationModalAttachmentStrip`) plus a boolean submit gate,
 * mirroring the landing composer's isolation.
 */
function useNewConversationDraftFields(
  epicId: string,
  seed: NewConversationModalSeed,
): Pick<NewConversationModalSeed, "settings" | "composerMode" | "workspace"> {
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
  return {
    settings: draftFields.settings ?? seed.settings,
    composerMode: draftFields.composerMode ?? seed.composerMode,
    workspace: draftFields.workspace ?? seed.workspace,
  };
}

/**
 * The placement host's own gates for an agent's first message, as the
 * landing composer's: a managed pack still installing holds the send with
 * its hint, and on a sandbox an agent that cannot run there is refused at
 * Send, with the configuration's Providers, never swapped or held behind a
 * disabled button. A staged sandbox's send (`stagedAhead`) waits for its own
 * agent on the sandbox instead, checked by `stagedSignInCheck`. `sendRefusal`
 * is what Send would be refused for now, by whichever of the two applies.
 */
function usePlacementAgentGates(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly harnessId: GuiHarnessId | null;
  readonly pickedHarnessId: GuiHarnessId | null;
  readonly active: boolean;
  readonly stagedAhead: boolean;
  readonly stagedSurfaceKey: string | null;
  readonly onOpenTerminalInstead: () => void;
  readonly onChooseAnotherHost: () => void;
}): {
  readonly hint: string | null;
  readonly blocked: boolean;
  readonly refusal: ComposerHostNoticeState | null;
  readonly sendRefusal: ComposerHostNoticeState | null;
  readonly checking: ComposerHostNoticeState | null;
  readonly stagedSignInCheck: StagedSendSignInCheck;
} {
  const { client, hostId, harnessId, active, stagedAhead } = input;
  const packGate = useProviderPackGateForClient(client, harnessId, active);
  const sandboxAgentGate = useSandboxAgentGate({
    hostId,
    client,
    harnessId,
    active,
  });
  const stagedSignInCheck = useStagedSendSignInCheck({
    harnessId: input.pickedHarnessId,
    active: active && stagedAhead,
    onOpenTerminalInstead: input.onOpenTerminalInstead,
    onChooseAnotherHost: input.onChooseAnotherHost,
  });
  const stage =
    input.stagedSurfaceKey === null
      ? null
      : readStagedSandbox(input.stagedSurfaceKey);
  const stagedCheck = stage === null ? null : stagedSignInCheck.check(stage);
  const checking = stagedCheck?.pending === true ? stagedCheck : null;
  if (!active || stagedAhead) {
    return {
      hint: checking?.message ?? null,
      blocked: checking !== null,
      refusal: null,
      sendRefusal: stagedCheck,
      stagedSignInCheck,
      checking,
    };
  }
  return {
    hint: packGate.hint,
    blocked: packGate.blocked,
    refusal: sandboxAgentGate.notice,
    sendRefusal: sandboxAgentGate.notice,
    stagedSignInCheck,
    checking,
  };
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
      const settings = projection.chats.byId[latest.id].settings ?? null;
      return {
        settings: settings === null ? null : { ...settings, ultracode: false },
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
        ultracode: false,
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
