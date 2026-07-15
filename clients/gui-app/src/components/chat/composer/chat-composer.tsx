import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { AlertTriangle } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

import { useComposerPaste } from "@/hooks/composer/use-composer-paste";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useWorkspaceMentionRoots } from "@/hooks/composer/use-workspace-mention-roots";
import { ComposerShell } from "@/components/home/composer/composer-shell";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import type { ModelOption } from "@/components/home/data/landing-options";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { selectedModelRejectsImageAttachments } from "@/lib/composer/chat-run-settings";
import { authoritativeOrFallbackSeedSource } from "@/lib/composer/composer-seed-source";
import {
  workspaceComposerCanStart,
  type WorkspaceComposerAvailability,
} from "@/lib/composer/workspace-composer-availability";
import type { ChatLowerSurfaceTopSpacing } from "@/components/chat/chat-pinned-stack";
import { resolveComposerTopBannerKind } from "./chat-composer-top-banner";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import type { Attachment } from "@/lib/composer/types";
import { cn } from "@/lib/utils";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { redactEmail } from "@/lib/providers/redact-email";

import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { ChatComposerAttachmentsStrip } from "./chat-composer-attachments-strip";
import { ChatComposerEditorSlot } from "./chat-composer-editor-slot";
import { ChatComposerToolbarSlot } from "./chat-composer-toolbar-slot";
import { createComposerPickerStore } from "./picker/composer-picker-store";
import { ProviderReauthBanner } from "./provider-reauth-banner";
import { ProfileRateLimitSwitchBanner } from "./profile-rate-limit-switch-banner";
import { ChatComposerBannerPortal } from "./chat-composer-banner-portal";
import { useChatComposerDraft } from "./use-chat-composer-draft";
import { useChatComposerSubmit } from "./use-chat-composer-submit";
import {
  useProviderReauthGate,
  type ProviderReauthGate,
  type ProviderReauthReason,
} from "./use-provider-reauth-gate";
import { useProfileRateLimitSwitchPrompt } from "./use-profile-rate-limit-switch-prompt";
import { useRefreshProvidersListOnTurn } from "@/hooks/providers/use-refresh-providers-list-on-turn";
import {
  useAmbientDriftGate,
  type AmbientDriftSendNotice,
} from "./use-ambient-drift-gate";
import { useComposerPickerItems } from "./picker/use-composer-picker-items";
import { commitSelection } from "@/stores/composer/commit-selection";
import { useTaskProfileRateLimitSwitch } from "./use-task-profile-rate-limit-switch";

interface ChatComposerProps {
  readonly taskId: string;
  /**
   * When true, this composer is the tile currently active inside
   * the epic canvas; it registers with the focused-composer-
   * controls registry so the command palette dispatches against
   * it. Otherwise registration is suppressed. Callers that never
   * render in a multi-tile context (e.g. a mobile standalone chat
   * view) should pass `true`.
   */
  readonly isActive: boolean;
  readonly sendDisabled: boolean | undefined;
  readonly mentionRoots: ReadonlyArray<string> | null;
  readonly fallbackToGlobalMentionRoots: boolean;
  readonly currentEpicId: string | null;
  readonly settingsSeed: ChatRunSettings | null;
  readonly fallbackSettingsSeed: ChatRunSettings | null;
  readonly onSubmitMessage:
    ((input: ChatComposerSubmitInput) => boolean) | null;
  readonly onSettingsChange: ((settings: ChatRunSettings) => void) | null;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly editingQueueItemId: string | null;
  readonly onCancelQueueEdit: (() => void) | null;
  readonly hasPendingApprovals: boolean;
  readonly stopDisabled: boolean;
  readonly onStopTurn: (() => void) | null;
  /**
   * The workspace-controls cluster (Location / Mode+branch / Environment chips,
   * plus any trailing chip like context usage) rendered below the input. The
   * caller - typically the chat tile - owns each chip's binding source so this
   * prop stays presentation-only. `null` renders no row.
   */
  readonly workspaceControls: ReactNode | null;
  /** Availability of the workspace backing this chat turn. */
  readonly workspaceAvailability: WorkspaceComposerAvailability;
  readonly topSpacing: ChatLowerSurfaceTopSpacing;
  /**
   * Optional element rendered directly above the composer input box (within
   * the same `max-w-3xl` column). Used by the chat tile for the
   * accumulated-changes tab, which connects to the composer's top edge.
   * `null` renders nothing.
   */
  readonly topSlot: ReactNode | null;
}

export interface ChatComposerSubmitInput {
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly settings: ChatRunSettings;
}

function ChatComposerImpl(props: ChatComposerProps) {
  const {
    taskId,
    isActive,
    sendDisabled,
    mentionRoots,
    fallbackToGlobalMentionRoots,
    currentEpicId,
    settingsSeed,
    fallbackSettingsSeed,
    onSubmitMessage,
    onSettingsChange,
    activeTurnStatus,
    editingQueueItemId,
    onCancelQueueEdit,
    hasPendingApprovals,
    stopDisabled,
    onStopTurn,
    workspaceControls,
    workspaceAvailability,
    topSpacing,
    topSlot,
  } = props;
  const resolvedMentionRoots = useWorkspaceMentionRoots(
    mentionRoots,
    fallbackToGlobalMentionRoots,
  );
  const hostClient = useTabHostClient();
  const tabHostId = useTabHostId();
  const workspaceBlocked = !workspaceComposerCanStart(workspaceAvailability);

  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  // Counts editor-ready transitions (a counter, not a boolean, so a torn-down
  // and re-created editor re-fires). The draft-reset bridge keys its
  // handle-ready catch-up on this - a ref flip alone never re-renders us.
  const [editorReadyTick, setEditorReadyTick] = useState(0);
  const handleEditorReady = useCallback(
    () => setEditorReadyTick((tick) => tick + 1),
    [],
  );
  const [pickerStore] = useState(() => createComposerPickerStore());

  // The mention/slash menu renders through a body portal, so a left-open menu
  // keeps painting over whichever surface the keep-alive host swaps in next.
  // This composer is concealed (display:none) once either its canvas tab is no
  // longer the selected body or its epic pane goes hidden, yet the portal
  // escapes that container - so close the picker whenever the surface stops
  // being actually visible. Both signals default to `true` outside their
  // providers (standalone/mobile chat), so this is a no-op there.
  const tabBodySelected = useTabBodySelected();
  const paneVisible = usePaneVisible();
  const surfaceVisible = tabBodySelected && paneVisible;
  useEffect(() => {
    if (surfaceVisible) return;
    pickerStore.getState().close();
  }, [surfaceVisible, pickerStore]);

  const {
    initialContent,
    initialSelection,
    draftContent,
    draftHasText,
    draftHasImages,
    handleSnapshot,
  } = useChatComposerDraft({
    taskId,
    editorRef,
    editorReadyTick,
  });

  const { dictationControl, dictationPreparing } = useComposerDictation({
    editorRef,
    isActive,
  });

  // S11: one seed source, computed once and consumed identically by both the
  // toolbar store and the reauth gate below - `settingsSeed` (non-null) makes
  // it `authoritative` (a real chat pin); otherwise it falls back to
  // `fallbackSettingsSeed` (a picker default, not a commitment - see
  // `deriveReauthReason`'s comment for why that distinction matters).
  const seedSource = authoritativeOrFallbackSeedSource(
    settingsSeed,
    fallbackSettingsSeed,
    hostClient,
  );
  // Per-composer toolbar store: this component only subscribes to the two
  // slices it consumes (harness id for the picker/editor, selected model for
  // the image gate); everything else - permission, reasoning, tier, the
  // catalog churn - stays inside the toolbar leaves and the submit path.
  // Note for the chat-tile owner: SurfaceActivityContext defaults to `true`
  // here (the old hardcoded `activityEnabled`); wiring per-tile activity for
  // keep-alive chat panes is a follow-up at the tile level.
  const toolbarStore = useComposerToolbarStore(
    isActive ? "chat-tile" : null,
    seedSource,
    onSettingsChange,
    false,
  );
  const harnessId = useStore(toolbarStore, (s) => s.selection.harnessId);
  const profileId = useStore(toolbarStore, (s) => s.selection.profileId);
  const modelSlug = useStore(toolbarStore, (s) => s.selection.modelSlug);
  // Connection-level auth gate for the selected provider, scoped to the tab's
  // host. When the provider CLI is signed out it blocks send and mounts the
  // re-auth banner above the composer; a doomed turn can't start.
  const reauthGate = useProviderReauthGate(
    harnessId,
    profileId,
    isActive,
    seedSource.kind,
  );
  const sendBlocked = sendDisabled === true || reauthGate.signedOut;
  // Rate-limit switch prompt: purely informational + user-confirmed, so it
  // never blocks send the way the reauth gate does.
  const rateLimitPrompt = useProfileRateLimitSwitchPrompt(
    harnessId,
    profileId,
    isActive,
  );
  // Keeps the switch prompt's own `providers.list` read converging with a
  // turn's passive rate-limit capture: without this, a turn that just pushed
  // this harness's profile into near/hard limit wouldn't surface the banner
  // until `providers.list`'s next unrelated 15-minute refetch.
  useRefreshProvidersListOnTurn(harnessId, tabHostId);
  const onSwitchProfile = useCallback(
    (nextProfileId: string | null) => {
      commitSelection(toolbarStore, harnessId, modelSlug, nextProfileId);
    },
    [toolbarStore, harnessId, modelSlug],
  );
  // Task-wide extension of the rate-limit switch: sibling chats of this task
  // pinned to the same limited profile, and the action moving them together.
  const taskProfileSwitch = useTaskProfileRateLimitSwitch({
    enabled: rateLimitPrompt.limited,
    harnessId,
    profileId,
    epicId: currentEpicId,
    chatId: taskId,
  });
  const selectedModel = useStore(toolbarStore, (s) => s.selectedModel);
  const imagesUnsupported = imageAttachmentsUnsupported(
    draftHasImages,
    selectedModel,
  );
  const unsupportedImagesMessage = imageAttachmentWarning(imagesUnsupported);

  useComposerPickerItems({
    pickerStore,
    hostClient,
    harnessId,
    mentionRoots: resolvedMentionRoots,
    currentEpicId,
    isActive,
  });

  const submitDraft = useChatComposerSubmit({
    taskId,
    editorRef,
    pickerStore,
    toolbarStore,
    activeTurnStatus,
    hasPendingApprovals,
    sendDisabled: sendBlocked,
    workspaceBlocked,
    imagesUnsupported,
    onSubmitMessage,
  });
  const ambientDrift = useAmbientDriftGate(
    hostClient,
    reauthGate.state,
    profileId,
  );
  const handleSubmitDraft = useCallback((): void => {
    ambientDrift.guardSubmit(submitDraft);
  }, [ambientDrift, submitDraft]);
  const reauthBanner = resolveReauthBannerProps(reauthGate);
  const topBannerKind = resolveComposerTopBannerKind({
    reauthVisible: reauthBanner !== null,
    ambientDriftVisible: ambientDrift.pendingNotice !== null,
    rateLimitVisible: !reauthGate.signedOut && rateLimitPrompt.limited,
  });
  const continueAfterAmbientDrift = (): void => {
    ambientDrift.acknowledge(() => {
      if (rateLimitPrompt.limited) return;
      submitDraft();
    });
  };

  const {
    onPaste,
    onDrop,
    onDragOver,
    onDragEnter,
    onDragLeave,
    attachImageFiles,
    isDraggingFiles,
  } = useComposerPaste(editorRef);

  const removeImage = useCallback((id: string) => {
    editorRef.current?.removeImageAttachmentById(id);
  }, []);

  // Excludes the model-resolution gate: ComposerToolbarRight ANDs the
  // store-derived `modelResolved` onto the send button, and the submit hook
  // re-checks it at dispatch, so this composer never re-renders when the
  // model catalog resolves.
  const canSubmit = canSubmitDraft({
    activeTurnStatus,
    hasPendingApprovals,
    sendDisabled: sendBlocked,
    workspaceBlocked,
    imagesUnsupported,
    draftHasText,
    draftHasImages,
  });

  return (
    <>
      {topBannerKind === "rate-limit" ? (
        <ChatComposerBannerPortal>
          <div className="bg-canvas px-4 pt-4">
            <div className="mx-auto w-full max-w-3xl">
              <ProfileRateLimitSwitchBanner
                harnessId={harnessId}
                hardLimited={rateLimitPrompt.hardLimited}
                current={rateLimitPrompt.current}
                alternatives={rateLimitPrompt.alternatives}
                onSwitchProfile={onSwitchProfile}
                affectedChatCount={taskProfileSwitch.affectedChatCount}
                onSwitchProfileForTask={taskProfileSwitch.switchOtherTaskChats}
                onDismiss={rateLimitPrompt.dismiss}
              />
            </div>
          </div>
        </ChatComposerBannerPortal>
      ) : null}
      <div
        className={cn(
          "bg-canvas px-4 pb-4",
          topSpacing === "normal" ? "pt-4" : "pt-0",
        )}
      >
        <div className="mx-auto w-full max-w-3xl">
          {topBannerKind === "reauth" && reauthBanner !== null ? (
            <ProviderReauthBanner
              providerId={reauthBanner.providerId}
              state={reauthGate.state}
              reason={reauthBanner.reason}
              profileLabel={reauthGate.profileLabel}
              onContinueOnAmbient={
                reauthBanner.reason === "provider_unauthenticated"
                  ? null
                  : () => onSwitchProfile(null)
              }
            />
          ) : null}
          {topBannerKind === "ambient-drift" &&
          ambientDrift.pendingNotice !== null ? (
            <AmbientDriftSendBanner
              notice={ambientDrift.pendingNotice}
              onContinue={continueAfterAmbientDrift}
              onDismiss={ambientDrift.dismiss}
            />
          ) : null}
          {topSlot}
          <div className="flex flex-col gap-3">
            <ComposerShell
              pickerStore={pickerStore}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnter={onDragEnter}
              onDragLeave={onDragLeave}
              isDraggingFiles={isDraggingFiles}
              attachmentsStrip={
                <ChatComposerAttachmentsStrip
                  content={draftContent}
                  editingQueueItemId={editingQueueItemId}
                  onCancelQueueEdit={onCancelQueueEdit}
                  onRemoveImage={removeImage}
                />
              }
              editor={
                <ChatComposerEditorSlot
                  ref={editorRef}
                  pickerStore={pickerStore}
                  initialContent={initialContent}
                  initialSelection={initialSelection}
                  slashProviderId={harnessId}
                  isActive={isActive}
                  onSnapshot={handleSnapshot}
                  onSubmit={handleSubmitDraft}
                  onPaste={onPaste}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onEditorReady={handleEditorReady}
                />
              }
              toolbar={
                <ChatComposerToolbarSlot
                  store={toolbarStore}
                  onAttachImages={attachImageFiles}
                  canSubmit={canSubmit}
                  onSubmit={handleSubmitDraft}
                  activeTurnStatus={activeTurnStatus}
                  hasPendingApprovals={hasPendingApprovals}
                  stopDisabled={stopDisabled}
                  onStopTurn={onStopTurn}
                  composerDisabledHint={workspaceAvailability.disabledHint}
                  dictation={dictationControl}
                  dictationPreparing={dictationPreparing}
                  settingsLocked={false}
                  createProfileHostId={tabHostId}
                  runTargetHostId={tabHostId}
                />
              }
            />
            {workspaceControls !== null ? (
              <ComposerWorkspaceRow workspaceControls={workspaceControls} />
            ) : null}
          </div>
          {unsupportedImagesMessage === null ? null : (
            <output
              aria-live="polite"
              aria-atomic="true"
              className="mt-2 text-ui-xs text-destructive"
              data-testid="composer-image-unsupported-message"
            >
              {unsupportedImagesMessage}
            </output>
          )}
        </div>
      </div>
    </>
  );
}

export const ChatComposer = memo(ChatComposerImpl);

// Narrowed props for `ProviderReauthBanner`, resolved once so neither the
// `topBannerKind` derivation nor the JSX re-derives the same three-way
// `signedOut && providerId !== null && reason !== null` check.
function resolveReauthBannerProps(gate: ProviderReauthGate): {
  readonly providerId: ProviderId;
  readonly reason: ProviderReauthReason;
} | null {
  if (!gate.signedOut || gate.providerId === null || gate.reason === null) {
    return null;
  }
  return { providerId: gate.providerId, reason: gate.reason };
}

function AmbientDriftSendBanner({
  notice,
  onContinue,
  onDismiss,
}: {
  readonly notice: AmbientDriftSendNotice;
  readonly onContinue: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  return (
    <div className="mb-2 flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-ui-sm text-amber-900 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium">Terminal account changed</div>
          <div className="text-ui-xs">
            Terminal account is now {driftEmailCopy(notice.currentEmail)}; was{" "}
            {driftEmailCopy(notice.previousEmail)}.
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <button
          type="button"
          className="rounded-md bg-foreground/90 px-2.5 py-1 text-ui-xs font-medium text-background transition-colors hover:bg-foreground"
          onClick={onContinue}
        >
          Continue with Terminal account
        </button>
        <button
          type="button"
          className="rounded-md px-2.5 py-1 text-ui-xs text-current opacity-80 transition-opacity hover:opacity-100"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function driftEmailCopy(email: string | null): string {
  return email === null ? "an unknown account" : redactEmail(email);
}

function imageAttachmentsUnsupported(
  draftHasImages: boolean,
  selectedModel: ModelOption | null,
): boolean {
  return draftHasImages && selectedModelRejectsImageAttachments(selectedModel);
}

function imageAttachmentWarning(imagesUnsupported: boolean): string | null {
  if (!imagesUnsupported) return null;
  return "Attached images are not supported by the selected model. Remove images or switch models.";
}

interface CanSubmitDraftArgs {
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly hasPendingApprovals: boolean;
  readonly sendDisabled: boolean | undefined;
  readonly workspaceBlocked: boolean;
  readonly imagesUnsupported: boolean;
  readonly draftHasText: boolean;
  readonly draftHasImages: boolean;
}

function canSubmitDraft(args: CanSubmitDraftArgs): boolean {
  return (
    args.activeTurnStatus !== "stopping" &&
    !args.hasPendingApprovals &&
    !args.sendDisabled &&
    !args.workspaceBlocked &&
    !args.imagesUnsupported &&
    (args.draftHasText || args.draftHasImages)
  );
}
