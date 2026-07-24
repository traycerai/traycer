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

import { v4 as uuidv4 } from "uuid";
import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
import { useLandingImageFetcher } from "@/hooks/composer/use-landing-image-fetcher";
import {
  hasLandingImageBytes,
  putImage,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";
import {
  markLandingEditorMounted,
  reserveLandingImageBudget,
  scheduleLandingImageReconcile,
} from "@/lib/composer/landing-image-gc";
import {
  collectImageAtoms,
  type ComposerImageAtom,
} from "@/lib/composer/image-atoms";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
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
import {
  decodeValidatedPastedImage,
  useLandingComposerPaste,
} from "@/hooks/composer/use-landing-composer-paste";
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

  // [B2] The landing surface is gated on windows-bridge hydration, so its mount
  // means the authoritative draft snapshot is in and the live-editor + draft
  // roots are trustworthy. This unblocks the landing image GC's deleting sweep,
  // which is otherwise deferred so a cold-start reconcile (empty session cache,
  // possibly stale-empty projected roots) can't reap freshly-restored bytes.
  useEffect(() => {
    markLandingEditorMounted();
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
  const runPendingImageJob = paste.runPendingImageJob;
  // Background job for ONE pending image node (already in the document, carrying
  // b64 + `id`): hash + store the bytes, then flip that node's payload to the
  // hash IN PLACE. Runs under the shared pending accounting so submit stays gated
  // until it settles. Editor-gone / store-failure paths drop the node (if still
  // present) and reclaim the bytes.
  const startPendingImageIngest = useCallback(
    (id: string, bytes: Uint8Array<ArrayBuffer>) => {
      runPendingImageJob(async (signal) => {
        try {
          const hash = await putImage(bytes);
          const handle = editorRef.current;
          if (signal.aborted || handle === null || !handle.isReady()) {
            // Editor unmounted mid-ingest: the pending node is gone from THIS
            // mount, so reclaim the just-stored bytes on the next sweep. (If a
            // remount kept the b64 node, its own mount-time re-entry re-ingests
            // and re-roots this hash before the debounced sweep runs.)
            scheduleLandingImageReconcile();
            return;
          }
          if (!handle.rewriteImageAttachmentHashById(id, hash)) {
            // The pending node was removed (the user deleted it before the write
            // settled), so the just-stored bytes are unrooted — reclaim them.
            scheduleLandingImageReconcile();
          }
        } catch {
          if (signal.aborted) {
            // The editor unmounted mid-ingest; a successor mount (if any)
            // re-ingests this node via mount-time re-entry. Don't toast for a
            // surface the user already left (matching the shared file-paste
            // path's abort handling) — just reclaim the bytes.
            scheduleLandingImageReconcile();
            return;
          }
          // Hashing / IndexedDB write failed: drop the pending node and reclaim.
          editorRef.current?.removeImageAttachmentById(id);
          reportableErrorToast(
            "Couldn't attach the image.",
            { description: "Please try adding it again." },
            {
              title: "Could not attach image",
              message: null,
              code: null,
              source: "Chat composer",
            },
          );
          scheduleLandingImageReconcile();
        }
      });
    },
    [runPendingImageJob],
  );
  // Synchronously validate a landing paste's inline-base64 images (decode,
  // MIME/5MB, budget), mint a fresh id + start the background job for each
  // accepted one, and report a verdict per image. The paste handler keeps the
  // accepted nodes IN document order (stamped with these ids) and drops rejected
  // ones — no positions are ever discarded.
  const ingestPastedComposerImages = useCallback(
    (
      images: ReadonlyArray<PastedComposerImage>,
    ): ReadonlyArray<PastedComposerImageOutcome> => {
      const decoded = images.map((image) => decodeValidatedPastedImage(image));
      const acceptedBytes = decoded.filter(
        (bytes): bytes is Uint8Array<ArrayBuffer> => bytes !== null,
      );
      const incomingBytes = acceptedBytes.reduce(
        (sum, bytes) => sum + bytes.byteLength,
        0,
      );
      // One budget reservation for the whole paste (evicts oldest inactive
      // drafts, or blocks with its own toast if it still can't fit).
      const budgetOk =
        acceptedBytes.length === 0 || reserveLandingImageBudget(incomingBytes);
      // Count ONLY undecodable images toward the generic "corrupted or too large"
      // toast. A valid image blocked solely by the aggregate budget is already
      // covered by `reserveLandingImageBudget`'s own accurate budget toast, so
      // adding this one would double-toast it with a false cause — matching the
      // shared file-paste path, which returns after the budget toast.
      let corruptedCount = 0;
      const outcomes = decoded.map((bytes): PastedComposerImageOutcome => {
        if (bytes === null) {
          corruptedCount += 1;
          return { kind: "rejected" };
        }
        if (!budgetOk) return { kind: "rejected" };
        const id = uuidv4();
        startPendingImageIngest(id, bytes);
        return { kind: "accepted", id };
      });
      if (corruptedCount > 0) {
        reportableErrorToast(
          corruptedCount === 1
            ? "Couldn't attach a pasted image."
            : "Couldn't attach some pasted images.",
          { description: "The image was corrupted or too large." },
          {
            title: "Could not attach image",
            message: null,
            code: null,
            source: "Chat composer",
          },
        );
      }
      return outcomes;
    },
    [startPendingImageIngest],
  );
  // Mount-time re-entry completes the pending-node model: the b64 image node IS
  // the work token, so whichever mount owns the editor restarts its ingest. This
  // covers the null-bound first paste (which creates a draft and key-remounts the
  // composer) and any in-session navigate-away-and-back — the b64 node survives
  // in the canonical in-memory draft (`setDraftContent` no longer strips) and its
  // ingest resumes here. Idempotent by construction: `putImage` is content-
  // addressed + single-flight and the rewrite is by id, so re-ingesting a node an
  // aborted prior job already stored just re-roots the same hash. Budget is NOT
  // re-reserved — a node already in the document was admitted this session and the
  // module-level budget survives the remount. Fired once per editor instance.
  const reingestPendingImages = useCallback(() => {
    const handle = editorRef.current;
    if (handle === null || !handle.isReady()) return;
    const pending = collectImageAtoms(handle.getJSON()).filter(
      (atom): atom is ComposerImageAtom & { readonly b64content: string } =>
        atom.b64content !== null,
    );
    if (pending.length === 0) return;
    let corruptedCount = 0;
    for (const atom of pending) {
      const bytes = decodeValidatedPastedImage({
        fileName: atom.fileName,
        mimeType: atom.mimeType,
        b64content: atom.b64content,
      });
      if (bytes === null) {
        // A corrupt/oversized b64 node (only reachable via a manually corrupted
        // restore) can't be ingested: drop it with the single shared toast.
        handle.removeImageAttachmentById(atom.id);
        corruptedCount += 1;
        continue;
      }
      startPendingImageIngest(atom.id, bytes);
    }
    if (corruptedCount > 0) {
      reportableErrorToast(
        corruptedCount === 1
          ? "Couldn't attach a pasted image."
          : "Couldn't attach some pasted images.",
        { description: "The image was corrupted or too large." },
        {
          title: "Could not attach image",
          message: null,
          code: null,
          source: "Chat composer",
        },
      );
    }
  }, [startPendingImageIngest]);
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
      hasPastedImageBytes={hasLandingImageBytes}
      ingestPastedComposerImages={ingestPastedComposerImages}
      onEditorReady={reingestPendingImages}
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
