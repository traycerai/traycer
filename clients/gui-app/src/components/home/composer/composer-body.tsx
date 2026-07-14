import { useStore } from "zustand";
import type { ReactNode, RefObject } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { UseComposerPasteResult } from "@/hooks/composer/use-composer-paste";
import type { ComposerDictationControl } from "@/components/home/toolbar/composer-mic-button";
import type { DictationPreparingStatus } from "@/hooks/composer/use-dictation-availability";
import { ComposerShell } from "@/components/home/composer/composer-shell";
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
  readonly workspaceDisabledHint: string | null;
  readonly header: ReactNode;
  readonly attachmentsStrip: ReactNode;
  readonly workspaceControls: ReactNode;
  readonly dictationControl: ComposerDictationControl | null;
  readonly dictationPreparing: DictationPreparingStatus | null;
  readonly paste: UseComposerPasteResult;
  readonly onSubmit: () => void;
  readonly onStartTerminal: (launch: TerminalAgentLaunch) => void;
  readonly onSnapshot: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
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
  workspaceDisabledHint,
  header,
  attachmentsStrip,
  workspaceControls,
  dictationControl,
  dictationPreparing,
  paste,
  onSubmit,
  onStartTerminal,
  onSnapshot,
}: ComposerBodyProps) {
  const harnessId = useStore(toolbarStore, (s) => s.selection.harnessId);
  const hiddenInTerminal = cn(composerMode !== "chat" && "hidden");
  const hiddenInChat = cn(composerMode !== "terminal" && "hidden");
  const showLandingAgentModeTooltip = true;

  return (
    <div className="flex flex-col gap-3">
      {header}
      <ComposerShell
        pickerStore={pickerStore}
        onDragOver={paste.onDragOver}
        onDrop={paste.onDrop}
        onDragEnter={paste.onDragEnter}
        onDragLeave={paste.onDragLeave}
        isDraggingFiles={paste.isDraggingFiles}
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
                isActive={chatEditorIsActive}
                disabled={false}
                placeholder={COMPOSER_PLACEHOLDER}
                editorClassName={editorClassName}
                stabilizeImageAttachmentCaret={false}
                onSnapshot={onSnapshot}
                onSubmit={onSubmit}
                onPaste={paste.onPaste}
                onDragOver={paste.onDragOver}
                onDrop={paste.onDrop}
                onKeyDown={undefined}
                onFocus={NOOP}
                onBlur={NOOP}
                onEditorReady={null}
              />
            </div>
            <div className={hiddenInChat}>
              <SurfaceActivityProvider active={composerMode === "terminal"}>
                <TerminalLaunchPanel
                  store={toolbarStore}
                  pending={isSubmitting}
                  disabledHint={workspaceDisabledHint}
                  onStart={onStartTerminal}
                />
              </SurfaceActivityProvider>
            </div>
          </>
        }
        toolbar={
          <div className={hiddenInTerminal}>
            <SurfaceActivityProvider active={composerMode === "chat"}>
              <ComposerToolbar
                store={toolbarStore}
                onAttachImages={paste.attachImageFiles}
                showNextTurnPermissionNote={false}
                showAgentModeTooltip={showLandingAgentModeTooltip}
                canSubmit={canSubmit}
                onSubmit={onSubmit}
                activeTurnStatus={null}
                stopDisabled
                onStopTurn={null}
                composerDisabledHint={workspaceDisabledHint}
                dictation={dictationControl}
                dictationPreparing={dictationPreparing}
                settingsLocked={false}
                // The landing composer has no tab yet - the app-wide default
                // host applies.
                createProfileHostId={null}
                runTargetHostId={null}
              />
            </SurfaceActivityProvider>
          </div>
        }
      />
      <ComposerWorkspaceRow workspaceControls={workspaceControls} />
    </div>
  );
}

const NOOP = (): void => undefined;
