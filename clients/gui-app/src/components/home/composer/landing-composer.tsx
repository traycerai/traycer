import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
import { useLandingImageFetcher } from "@/hooks/composer/use-landing-image-fetcher";
import { sessionObjectUrl } from "@/lib/composer/landing-image-store";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useComposerPickerItems } from "@/components/chat/composer/picker/use-composer-picker-items";
import { useProfileRateLimitSwitchPrompt } from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { ProfileRateLimitSwitchBanner } from "@/components/chat/composer/profile-rate-limit-switch-banner";
import { useRefreshProvidersListOnTurnDefaultHost } from "@/hooks/providers/use-refresh-providers-list-on-turn-default-host";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import { ComposerBody } from "@/components/home/composer/composer-body";
import { COMPOSER_EDITOR_CLASSNAME } from "@/components/home/composer/composer-editor-classnames";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useLandingComposerPaste } from "@/hooks/composer/use-landing-composer-paste";
import { isAttachmentIngestPending } from "@/hooks/composer/use-composer-paste";
import { useLandingComposerMentionRoots } from "@/hooks/composer/use-workspace-mention-roots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicCreate } from "@/hooks/epic/use-epic-create-mutation";
import { useCreateTuiAgent } from "@/hooks/agent/use-create-tui-agent";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  useLandingComposerStore,
  flushPendingLandingDraftContent,
} from "@/stores/composer/landing-composer-store";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import {
  deriveFolderlessAllowedWorkspaceAvailability,
  workspaceComposerCanStart,
} from "@/lib/composer/workspace-composer-availability";
import {
  useLandingComposerActions,
  type TerminalAgentLaunch,
} from "@/components/home/hooks/use-landing-composer-actions";
import { landingComposerSettingsSeedForDraft } from "@/components/home/composer/landing-composer-settings-seed";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import { nextComposerMode } from "@/components/home/data/landing-options";
import { ArrowLeftRight } from "lucide-react";
import { useHostBinding, useHostClient } from "@/lib/host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

interface LandingComposerProps {
  readonly draftId: string | null;
  readonly initialSettings: ChatRunSettings | null;
  readonly workspaceControls: ReactNode;
}

export function LandingComposer(props: LandingComposerProps) {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [pickerStore] = useState(() => createComposerPickerStore());
  const hostClient = useHostBinding()?.hostClient ?? null;
  const activityEnabled = useSurfaceActivity();
  const [initialContent] = useState<JsonContent>(() =>
    useLandingComposerStore.getState().openDraft(props.draftId),
  );
  // Restore the caret to where it was when the draft was last persisted (decision
  // A3). Read once at mount; the composer is keyed by draft id, so each draft
  // mounts fresh and `composer-prompt-editor` applies `initialSelection` once.
  const [initialSelection] = useState<DraftSelection | null>(() => {
    if (props.draftId === null) return null;
    return (
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === props.draftId)?.selection ?? null
    );
  });
  const draftId = props.draftId;
  const globalComposerMode = useSettingsStore((state) => state.composerMode);
  const setGlobalComposerMode = useSettingsStore(
    (state) => state.setComposerMode,
  );
  const draftComposerMode = useLandingDraftStore((state) => {
    if (draftId === null) return null;
    return (
      state.drafts.find((draft) => draft.id === draftId)?.composerMode ?? null
    );
  });
  const setDraftComposerMode = useLandingDraftStore(
    (state) => state.setDraftComposerMode,
  );
  const composerMode = draftComposerMode ?? globalComposerMode;
  const chatComposerActive = activityEnabled && composerMode === "chat";

  useEffect(() => {
    return () => {
      flushPendingLandingDraftContent();
    };
  }, []);

  const globalLastRunSettings = useComposerRunSettingsStore(
    (state) => state.globalLastRunSettings,
  );
  const setGlobalRunSettings = useComposerRunSettingsStore(
    (state) => state.setGlobalRunSettings,
  );
  const setDraftSettings = useLandingDraftStore(
    (state) => state.setDraftSettings,
  );
  const handleToolbarSettingsChange = useCallback(
    (settings: ChatRunSettings) => {
      setGlobalRunSettings(settings, Date.now());
      if (draftId !== null) {
        setDraftSettings(draftId, settings);
      }
    },
    [draftId, setDraftSettings, setGlobalRunSettings],
  );
  const settingsSeed = useMemo(
    () =>
      landingComposerSettingsSeedForDraft(
        draftId,
        props.initialSettings,
        globalLastRunSettings,
      ),
    [globalLastRunSettings, draftId, props.initialSettings],
  );
  // `settingsSeed` may carry a frozen `profileId` from an old landing draft
  // (`landing-draft-store` persists a draft's settings snapshot indefinitely,
  // independent of the current provider state) or the cross-session
  // `globalLastRunSettings` fallback - validated against the active host
  // (the one this draft will actually create the chat on) via the same
  // machinery `useComposerToolbarStore` runs for every composer surface.
  // Never authoritative: the landing composer has no reauth gate of its own
  // to defend a dead pin with a banner, so a genuinely-removed profile must
  // be corrected to ambient here rather than silently submitted as the new
  // chat's initial settings.
  const toolbarStore = useComposerToolbarStore(
    "landing",
    fallbackSeedSource(settingsSeed, hostClient),
    handleToolbarSettingsChange,
    composerMode === "terminal",
  );
  const harnessId = useStore(toolbarStore, (s) => s.selection.harnessId);
  const profileId = useStore(toolbarStore, (s) => s.selection.profileId);
  const selectedModel = useStore(toolbarStore, (s) => s.selectedModel);
  const mentionRoots = useLandingComposerMentionRoots(draftId);
  useComposerPickerItems({
    pickerStore,
    hostClient,
    harnessId,
    mentionRoots,
    currentEpicId: null,
    // Mirror the chat editor's activity (see `isActive` below): skip the eager
    // catalog fetch when the landing surface is in Terminal mode or occluded.
    isActive: chatComposerActive,
  });

  const createEpic = useEpicCreate();
  const terminalAgentCreate = useCreateTuiAgent();
  const isSubmitting = createEpic.isPending || terminalAgentCreate.isPending;

  const setSnapshot = useLandingComposerStore((s) => s.setSnapshot);
  const hasSubmittableContent = useLandingComposerStore((s) =>
    contentIsSubmittable(s.currentContent),
  );
  const draftWorkspace = useLandingDraftStore((state) => {
    if (draftId === null) return null;
    return (
      state.drafts.find((draft) => draft.id === draftId)?.workspace ?? null
    );
  });
  const defaultHostClient = useHostClient();
  // Rate-limit switch prompt for the landing composer's own toolbar
  // selection, scoped to the app-wide default host (landing has no tab of
  // its own) - the same shared hook the chat composer uses, mirroring its
  // wiring in `chat-composer.tsx`. Purely informational: it never blocks
  // epic creation.
  const rateLimitPrompt = useProfileRateLimitSwitchPrompt({
    harnessId,
    profileId,
    selectedModel,
    active: activityEnabled,
    client: defaultHostClient,
  });
  // Keeps the banner's `providers.list` read converging with a turn's
  // passive rate-limit capture from ANY running epic on this host -
  // mirrors `useRefreshProvidersListOnTurn` in `chat-composer.tsx`, scoped
  // to the default host instead of a tab.
  useRefreshProvidersListOnTurnDefaultHost(harnessId);
  const onSwitchRateLimitedProfile = useCallback(
    (nextProfileId: string | null) => {
      commitProfileSelection(toolbarStore, nextProfileId);
    },
    [toolbarStore],
  );
  const resolvedWorkspace = useResolvedWorkspaceFolders(
    draftWorkspace,
    defaultHostClient,
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
  const runnerHost = useRunnerHost();
  const paste = useLandingComposerPaste(
    editorRef,
    runnerHost.fileDrops,
    mentionRoots,
  );
  const attachmentPending = isAttachmentIngestPending(paste);
  const canSubmit =
    !isSubmitting &&
    !attachmentPending &&
    workspaceCanStart &&
    hasSubmittableContent;

  const actions = useLandingComposerActions();
  const { dictationControl, dictationPreparing } = useComposerDictation({
    editorRef,
    isActive: chatComposerActive,
  });

  const handleSnapshot = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      setSnapshot(draftId, content, selection);
    },
    [draftId, setSnapshot],
  );

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const toolbar = toolbarStore.getState();
    if (toolbar.selection.modelSlug.length === 0) return;
    actions.submit({
      editor: editorRef.current,
      toolbar: {
        selection: toolbar.selection,
        reasoning: toolbar.reasoning,
        serviceTier: toolbar.serviceTier,
        permission: toolbar.permission,
        agentMode: toolbar.agentMode,
      },
    });
  }, [actions, canSubmit, toolbarStore]);

  const handleStartTerminal = useCallback(
    (launch: TerminalAgentLaunch) => {
      if (!workspaceCanStart) return;
      actions.selectTerminalAgent(launch);
    },
    [actions, workspaceCanStart],
  );

  const handleRemoveImage = useCallback((id: string) => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRemoved, {
      kind: "image",
      surface: "draft",
    });
    editorRef.current?.removeImageAttachmentById(id);
  }, []);

  const switcher = (
    <button
      type="button"
      aria-label={
        composerMode === "chat"
          ? "Switch to the Terminal interface"
          : "Switch to the Chat interface"
      }
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        const next = nextComposerMode(composerMode);
        setGlobalComposerMode(next);
        if (draftId !== null) {
          setDraftComposerMode(draftId, next);
        }
      }}
    >
      <ArrowLeftRight className="size-3 shrink-0" />
      {composerMode === "chat" ? "Switch to Terminal" : "Switch to Chat"}
    </button>
  );

  return (
    <ComposerBody
      pickerStore={pickerStore}
      editorRef={editorRef}
      toolbarStore={toolbarStore}
      composerMode={composerMode}
      chatEditorIsActive={chatComposerActive}
      editorClassName={COMPOSER_EDITOR_CLASSNAME}
      initialContent={initialContent}
      initialSelection={initialSelection}
      canSubmit={canSubmit}
      isSubmitting={isSubmitting}
      attachmentPending={attachmentPending}
      workspaceDisabledHint={workspaceAvailability.disabledHint}
      header={<div className="flex justify-end">{switcher}</div>}
      topBanner={
        rateLimitPrompt.kind === "visible" ? (
          <ProfileRateLimitSwitchBanner
            key={rateLimitPrompt.warningKey}
            harnessId={harnessId}
            providerId={rateLimitPrompt.providerId}
            severity={rateLimitPrompt.severity}
            limitedFamilies={rateLimitPrompt.limitedFamilies}
            current={rateLimitPrompt.current}
            profiles={rateLimitPrompt.profiles}
            destinations={rateLimitPrompt.destinations}
            primaryTarget={rateLimitPrompt.primaryTarget}
            probeTarget={rateLimitPrompt.probeTarget}
            // Landing has no tab of its own; `null` resolves the usage
            // sidecar/R-key refresh to the app-wide default host, matching
            // `ComposerToolbar`'s own `runTargetHostId={null}` for this
            // surface (composer-body.tsx).
            runTargetHostId={null}
            onSwitchProfile={onSwitchRateLimitedProfile}
            affectedChatCount={0}
            onSwitchProfileForTask={noopSwitchProfileForTask}
            onDismiss={rateLimitPrompt.dismiss}
          />
        ) : null
      }
      attachmentsStrip={
        <LandingComposerAttachmentStrip onRemoveImage={handleRemoveImage} />
      }
      workspaceControls={props.workspaceControls}
      dictationControl={dictationControl}
      dictationPreparing={dictationPreparing}
      paste={paste}
      hasPastedImageBytes={null}
      onSubmit={handleSubmit}
      onStartTerminal={handleStartTerminal}
      onSnapshot={handleSnapshot}
    />
  );
}

function noopSwitchProfileForTask(): void {}

function LandingComposerAttachmentStrip(props: {
  readonly onRemoveImage: (id: string) => void;
}): ReactNode {
  const currentContent = useLandingComposerStore((s) => s.currentContent);
  const fetcher = useLandingImageFetcher();
  return (
    <AttachmentStrip
      content={currentContent}
      onRemoveImage={props.onRemoveImage}
      fetcher={fetcher}
      sessionObjectUrl={sessionObjectUrl}
    />
  );
}
