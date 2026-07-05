import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

import { useComposerPaste } from "@/hooks/composer/use-composer-paste";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useWorkspaceMentionRoots } from "@/hooks/composer/use-workspace-mention-roots";
import { ComposerShell } from "@/components/home/composer/composer-shell";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import type { ModelOption } from "@/components/home/data/landing-options";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { selectedModelRejectsImageAttachments } from "@/lib/composer/chat-run-settings";
import {
  workspaceComposerCanStart,
  type WorkspaceComposerAvailability,
} from "@/lib/composer/workspace-composer-availability";
import type { ChatLowerSurfaceTopSpacing } from "@/components/chat/chat-pinned-stack";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import type { Attachment } from "@/lib/composer/types";
import { cn } from "@/lib/utils";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";

import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { ChatComposerAttachmentsStrip } from "./chat-composer-attachments-strip";
import { ChatComposerEditorSlot } from "./chat-composer-editor-slot";
import { ChatComposerToolbarSlot } from "./chat-composer-toolbar-slot";
import { createComposerPickerStore } from "./picker/composer-picker-store";
import { ProviderReauthBanner } from "./provider-reauth-banner";
import { useChatComposerDraft } from "./use-chat-composer-draft";
import { useChatComposerSubmit } from "./use-chat-composer-submit";
import { useProviderReauthGate } from "./use-provider-reauth-gate";
import { useComposerPickerItems } from "./picker/use-composer-picker-items";

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
  const resolvedMentionRoots = useWorkspaceMentionRoots(mentionRoots, true);
  const hostClient = useTabHostClient();
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

  // Per-composer toolbar store: this component only subscribes to the two
  // slices it consumes (harness id for the picker/editor, selected model for
  // the image gate); everything else - permission, reasoning, tier, the
  // catalog churn - stays inside the toolbar leaves and the submit path.
  // Note for the chat-tile owner: SurfaceActivityContext defaults to `true`
  // here (the old hardcoded `activityEnabled`); wiring per-tile activity for
  // keep-alive chat panes is a follow-up at the tile level.
  const toolbarStore = useComposerToolbarStore(
    isActive ? "chat-tile" : null,
    settingsSeed ?? fallbackSettingsSeed,
    onSettingsChange,
    false,
  );
  const harnessId = useStore(toolbarStore, (s) => s.selection.harnessId);
  // Connection-level auth gate for the selected provider, scoped to the tab's
  // host. When the provider CLI is signed out it blocks send and mounts the
  // re-auth banner above the composer; a doomed turn can't start.
  const reauthGate = useProviderReauthGate(harnessId, isActive);
  const sendBlocked = sendDisabled === true || reauthGate.signedOut;
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
    <div
      className={cn(
        "bg-canvas px-4 pb-4",
        topSpacing === "normal" ? "pt-4" : "pt-0",
      )}
    >
      <div className="mx-auto w-full max-w-3xl">
        {reauthGate.signedOut && reauthGate.providerId !== null ? (
          <ProviderReauthBanner
            providerId={reauthGate.providerId}
            state={reauthGate.state}
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
                onSubmit={submitDraft}
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
                onSubmit={submitDraft}
                activeTurnStatus={activeTurnStatus}
                hasPendingApprovals={hasPendingApprovals}
                stopDisabled={stopDisabled}
                onStopTurn={onStopTurn}
                composerDisabledHint={workspaceAvailability.disabledHint}
                dictation={dictationControl}
                dictationPreparing={dictationPreparing}
                settingsLocked={false}
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
  );
}

export const ChatComposer = memo(ChatComposerImpl);

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
