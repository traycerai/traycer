import { useStore } from "zustand";
import type { ReactNode, RefObject } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { UseComposerPasteResult } from "@/hooks/composer/use-composer-paste";
import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import { ComposerShell } from "@/components/home/composer/composer-shell";
import { ComposerMobileToolbar } from "@/components/home/mobile/composer-mobile-toolbar";
import { ComposerWorkspaceRow } from "@/components/home/composer/composer-workspace-mode-row";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { TerminalLaunchPanel } from "@/components/home/composer/terminal-launch-panel";
import type { ComposerMode } from "@/components/home/data/landing-options";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { cn } from "@/lib/utils";

const COMPOSER_PLACEHOLDER = "Ask Traycer anything. @ mention for context";

export interface ComposerBodyProps {
  readonly pickerStore: ComposerPickerStore;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly toolbarStore: ComposerToolbarStore;
  readonly composerMode: ComposerMode;
  readonly chatEditorIsActive: boolean;
  readonly editorClassName: string;
  readonly initialContent: JsonContent;
  readonly initialSelection: {
    readonly from: number;
    readonly to: number;
  } | null;
  readonly canSubmit: boolean;
  readonly isSubmitting: boolean;
  readonly attachmentPending: boolean;
  readonly workspaceDisabledHint: string | null;
  readonly header: ReactNode;
  /**
   * Rendered between `header` and the composer card (`ComposerShell`) - the
   * decision-log-mandated slot for a banner that must sit flush above the
   * card itself, below any mode-switch header. `null` for callers with
   * nothing to show there (the chat composer routes its own rate-limit
   * banner through a separate portal and never uses this slot).
   */
  readonly topBanner: ReactNode | null;
  /**
   * Which toolbar this surface wants. `"collapsed"` is the phone-width row,
   * which moves the secondary controls into a single options sheet. The
   * calling surface decides, so `ComposerBody` itself stays viewport-agnostic;
   * only the landing composer asks for `"collapsed"`, and only below `md`.
   */
  readonly toolbarLayout: "full" | "collapsed";
  readonly stashControl: ReactNode;
  readonly attachmentsStrip: ReactNode;
  readonly workspaceControls: ReactNode;
  readonly dictationControl: ComposerDictationControl | null;
  readonly dictationPreparing: DictationPreparingStatus | null;
  readonly paste: UseComposerPasteResult;
  readonly hasPastedImageBytes: ((hash: string) => boolean) | null;
  readonly ingestPastedComposerImages:
    | ((
        images: ReadonlyArray<PastedComposerImage>,
      ) => ReadonlyArray<PastedComposerImageOutcome>)
    | null;
  /**
   * Forwarded to the chat `ComposerPromptEditor`'s `onEditorReady` (fired once
   * when its async editor is created). Landing passes a callback that re-ingests
   * a restored draft's still-pending b64 image nodes; `null` where the editor
   * has nothing to resume (chat / new-conversation).
   */
  readonly onEditorReady: (() => void) | null;
  /**
   * The host this composer creates on - threaded to the toolbar's and the
   * terminal launcher's model pickers as their `createProfileHostId` /
   * `runTargetHostId`, so the harnesses/models/providers they offer are that
   * host's. `null` follows the app-wide default (the landing composer, whose
   * own host picker rebinds that default); the new-conversation modal passes
   * the host it was pinned to.
   */
  readonly hostId: string | null;
  readonly onSubmit: () => void;
  readonly onStartTerminal: (launch: TerminalAgentLaunch) => void;
  readonly onDocumentChange: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSelectionChange: (selection: { from: number; to: number }) => void;
}

export function ComposerBody({
  pickerStore,
  editorRef,
  toolbarStore,
  composerMode,
  chatEditorIsActive,
  editorClassName,
  initialContent,
  initialSelection,
  canSubmit,
  isSubmitting,
  attachmentPending,
  workspaceDisabledHint,
  header,
  topBanner,
  toolbarLayout,
  stashControl,
  attachmentsStrip,
  workspaceControls,
  dictationControl,
  dictationPreparing,
  paste,
  hasPastedImageBytes,
  ingestPastedComposerImages,
  onEditorReady,
  hostId,
  onSubmit,
  onStartTerminal,
  onDocumentChange,
  onSelectionChange,
}: ComposerBodyProps) {
  const harnessId = useStore(toolbarStore, (s) => s.selection.harnessId);
  const chatPasteActive = composerMode === "chat";
  const hiddenInTerminal = cn(composerMode !== "chat" && "hidden");
  const hiddenInChat = cn(composerMode !== "terminal" && "hidden");
  // Every prop both toolbars take, identical for either layout - only the
  // desktop-only permission note below differs. Shared so the two branches
  // cannot drift apart silently; the moment they need different values, stop
  // spreading and pass them explicitly again.
  const sharedToolbarProps = {
    store: toolbarStore,
    onAttachImages: paste.attachImageFiles,
    canSubmit,
    attachmentPending,
    onSubmit,
    activeTurnStatus: null,
    stopDisabled: true,
    onStopTurn: null,
    composerDisabledHint: workspaceDisabledHint,
    dictation: dictationControl,
    dictationPreparing,
    settingsLocked: isSubmitting,
    createProfileHostId: hostId,
    runTargetHostId: hostId,
  } as const;

  return (
    <div className="flex flex-col gap-3">
      {header}
      {topBanner}
      <ComposerShell
        pickerStore={pickerStore}
        onDragOver={chatPasteActive ? paste.onDragOver : NOOP}
        onDrop={chatPasteActive ? paste.onDrop : NOOP}
        onDragEnter={chatPasteActive ? paste.onDragEnter : NOOP}
        onDragLeave={chatPasteActive ? paste.onDragLeave : NOOP}
        dragOverlayVariant={chatPasteActive ? paste.dragOverlayVariant : null}
        utilityRail={composerMode === "chat" ? stashControl : null}
        attachmentsStrip={composerMode === "chat" ? attachmentsStrip : null}
        editor={
          <>
            <div className={hiddenInTerminal}>
              <ComposerPromptEditor
                ref={editorRef}
                pickerStore={pickerStore}
                initialContent={initialContent}
                initialSelection={initialSelection}
                slashProviderId={harnessId}
                hasPastedImageBytes={hasPastedImageBytes}
                ingestPastedComposerImages={ingestPastedComposerImages}
                isActive={chatEditorIsActive}
                disabled={isSubmitting}
                placeholder={COMPOSER_PLACEHOLDER}
                editorClassName={editorClassName}
                stabilizeImageAttachmentCaret
                onDocumentChange={onDocumentChange}
                onSelectionChange={onSelectionChange}
                onSubmit={onSubmit}
                onPaste={chatPasteActive ? paste.onPaste : NOOP}
                onDragOver={chatPasteActive ? paste.onDragOver : NOOP}
                onDrop={chatPasteActive ? paste.onDrop : NOOP}
                onKeyDown={undefined}
                onFocus={NOOP}
                onBlur={NOOP}
                onEditorReady={onEditorReady}
              />
            </div>
            <div className={hiddenInChat}>
              <SurfaceActivityProvider active={composerMode === "terminal"}>
                <TerminalLaunchPanel
                  store={toolbarStore}
                  pending={isSubmitting}
                  disabledHint={workspaceDisabledHint}
                  hostId={hostId}
                  onStart={onStartTerminal}
                />
              </SurfaceActivityProvider>
            </div>
          </>
        }
        toolbar={
          <div className={hiddenInTerminal}>
            <SurfaceActivityProvider active={composerMode === "chat"}>
              {toolbarLayout === "collapsed" ? (
                <ComposerMobileToolbar {...sharedToolbarProps} />
              ) : (
                <ComposerToolbar
                  {...sharedToolbarProps}
                  showNextTurnPermissionNote={false}
                />
              )}
            </SurfaceActivityProvider>
          </div>
        }
      />
      <ComposerWorkspaceRow workspaceControls={workspaceControls} />
    </div>
  );
}

const NOOP = (): void => undefined;
