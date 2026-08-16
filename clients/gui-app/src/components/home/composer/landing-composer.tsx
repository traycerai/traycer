import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import { v4 as uuidv4 } from "uuid";
import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
import { useLandingImageFetcher } from "@/hooks/composer/use-landing-image-fetcher";
import {
  getImageBytes,
  hasLandingImageBytes,
  putImage,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";
import {
  markLandingEditorMounted,
  scheduleLandingImageReconcile,
} from "@/lib/composer/landing-image-gc";
import {
  reserveLandingImageBudget,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
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
import { useProviderPackGate } from "@/hooks/providers/use-provider-pack-gate";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import {
  selectGlobalLastRunSettings,
  useComposerRunSettingsStore,
} from "@/stores/composer/composer-run-settings-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import {
  draftRuntimeRegistry,
  EMPTY_DRAFT_RUNTIME_CONTENT,
  imageHashes,
  type DraftRuntimeState,
} from "@/stores/home/draft-runtime-registry";
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
import {
  nextComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import { ComposerModeSwitcher } from "@/components/home/composer/composer-mode-switcher";
import { useHostBinding, useHostClient } from "@/lib/host";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import { PromptStashControl } from "@/components/chat/composer/prompt-stash-control";
import {
  landingStashIdentity,
  useLandingPromptStashDestination,
  useLandingPromptStashSource,
} from "./use-landing-prompt-stash-adapters";

interface LandingComposerProps {
  readonly draftId: string | null;
  /**
   * Pre-minted draft id used as the React mount key while `draftId` is null.
   * Threaded into `setSnapshot`'s create branch so the first substantive edit
   * creates the draft under that same id (no editor remount). Null when bound.
   */
  readonly pendingCreateId: string | null;
  readonly initialSettings: ChatRunSettings | null;
  readonly workspaceControls: (disabled: boolean) => ReactNode;
}

interface PendingImageIngestOptions {
  readonly onSettled: (() => void) | undefined;
  readonly reserveAfterStore: boolean;
}

function useLandingDraftComposerMode(
  draftId: string | null,
): ComposerMode | null {
  return useLandingDraftStore((state) => {
    if (draftId === null) return null;
    return (
      state.drafts.find((draft) => draft.id === draftId)?.composerMode ?? null
    );
  });
}

function promptStashIsDisabled(
  isSubmitting: boolean,
  attachmentPending: boolean,
): boolean {
  return isSubmitting || attachmentPending;
}

export function LandingComposer(props: LandingComposerProps) {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const createdUnboundDraftIdRef = useRef<string | null>(null);
  const [pickerStore] = useState(() => createComposerPickerStore());
  const hostClient = useHostBinding()?.hostClient ?? null;
  const activityEnabled = useSurfaceActivity();
  const runtime = draftRuntimeRegistry.getOrHydrate(props.draftId);
  const [unboundRuntime] = useState(() =>
    createStore<DraftRuntimeState>(() => ({
      content: EMPTY_DRAFT_RUNTIME_CONTENT,
      selection: null,
      contentRevision: 0,
      attachmentRoots: new Set<string>(),
      isSubmitting: false,
    })),
  );
  const runtimeStore = runtime?.store ?? unboundRuntime;
  const runtimeState = useStore(runtimeStore);
  const [initialContent] = useState<JsonContent>(() => runtimeState.content);
  // Restore the caret to where it was when the draft was last persisted (decision
  // A3). Read once at mount; the composer is keyed by draft id, so each draft
  // mounts fresh and `composer-prompt-editor` applies `initialSelection` once.
  const [initialSelection] = useState<DraftSelection | null>(
    () => runtimeState.selection,
  );
  const draftId = props.draftId;
  const globalComposerMode = useSettingsStore((state) => state.composerMode);
  const setGlobalComposerMode = useSettingsStore(
    (state) => state.setComposerMode,
  );
  const draftComposerMode = useLandingDraftComposerMode(draftId);
  const setDraftComposerMode = useLandingDraftStore(
    (state) => state.setDraftComposerMode,
  );
  const composerMode = draftComposerMode ?? globalComposerMode;
  const chatComposerActive = activityEnabled && composerMode === "chat";

  useEffect(() => {
    return () => {
      draftRuntimeRegistry.flush(props.draftId);
    };
  }, [props.draftId]);

  // [B2] The landing surface is gated on windows-bridge hydration, so its mount
  // means the authoritative draft snapshot is in and the live-editor + draft
  // roots are trustworthy. This unblocks the landing image GC's deleting sweep,
  // which is otherwise deferred so a cold-start reconcile (empty session cache,
  // possibly stale-empty projected roots) can't reap freshly-restored bytes.
  useEffect(() => {
    markLandingEditorMounted();
  }, []);

  // The landing composer follows the app-wide active host (its picker rebinds
  // that default), so its remembered last-run settings are the ACTIVE host's
  // bucket - switching hosts re-seeds the toolbar from the new host's memory.
  const activeHostId = useReactiveActiveHostId();
  const globalLastRunSettings = useComposerRunSettingsStore((state) =>
    selectGlobalLastRunSettings(state, activeHostId),
  );
  const setGlobalRunSettings = useComposerRunSettingsStore(
    (state) => state.setGlobalRunSettings,
  );
  const setDraftSettings = useLandingDraftStore(
    (state) => state.setDraftSettings,
  );
  const handleToolbarSettingsChange = useCallback(
    (settings: ChatRunSettings) => {
      setGlobalRunSettings(activeHostId, settings, Date.now());
      if (draftId !== null) {
        setDraftSettings(draftId, settings);
      }
    },
    [activeHostId, draftId, setDraftSettings, setGlobalRunSettings],
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
  // chat's initial settings. The catalog reads through the same `hostClient`:
  // the landing host picker rebinds the app-wide default, so the active
  // client IS this composer's target host.
  const toolbarStore = useComposerToolbarStore(
    "landing",
    fallbackSeedSource(settingsSeed, hostClient),
    handleToolbarSettingsChange,
    { hostClient, hostId: activeHostId, tuiOnly: composerMode === "terminal" },
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
  const isSubmitting =
    runtimeState.isSubmitting ||
    createEpic.isPending ||
    terminalAgentCreate.isPending;

  const hasSubmittableContent = contentIsSubmittable(runtimeState.content);
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
    activeHostId,
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
  const paste = useLandingComposerPaste({
    editorRef,
    draftId,
    disabled: isSubmitting,
    fileDrops: runnerHost.fileDrops,
    mentionRoots,
  });
  const runPendingImageJob = paste.runPendingImageJob;
  // Background job for ONE pending image node (already in the document, carrying
  // b64 + `id`): hash + store the bytes, then flip that node's payload to the
  // hash IN PLACE. Runs under the shared pending accounting so submit stays gated
  // until it settles. Editor-gone / store-failure paths drop the node (if still
  // present) and reclaim the bytes. `onSettled` (when the caller holds a batch
  // budget reservation covering this image) fires exactly once, after every
  // other branch below, regardless of which one is taken. A remount reserves
  // the now-known hash after `putImage` settles and before rewriting the node;
  // this avoids double-charging the original anonymous reservation while its
  // aborted job is still awaiting the same single-flight write.
  const startPendingImageIngest = useCallback(
    (
      id: string,
      bytes: Uint8Array<ArrayBuffer>,
      options: PendingImageIngestOptions,
    ) => {
      runPendingImageJob(async (signal) => {
        let postStoreReservation: LandingImageBudgetReservation | null = null;
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
          if (options.reserveAfterStore) {
            postStoreReservation = reserveLandingImageBudget(draftId, [
              { hash, bytes: bytes.byteLength },
            ]);
            if (postStoreReservation === null) {
              handle.removeImageAttachmentById(id);
              scheduleLandingImageReconcile();
              return;
            }
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
        } finally {
          postStoreReservation?.release();
          options.onSettled?.();
        }
      });
    },
    [draftId, runPendingImageJob],
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
      // Reserve atomically as a batch, but retain one handle per image so an
      // unmounted job releases its own anonymous charge before that image's
      // remount re-entry acquires the now-hash-aware reservation. Holding one
      // aggregate handle until the slowest sibling settles can transiently
      // double-charge earlier images near the cap.
      const reservations: LandingImageBudgetReservation[] = [];
      for (const bytes of acceptedBytes) {
        const reservation = reserveLandingImageBudget(draftId, [
          { hash: null, bytes: bytes.byteLength },
        ]);
        if (reservation === null) break;
        reservations.push(reservation);
      }
      const budgetOk = reservations.length === acceptedBytes.length;
      if (!budgetOk) {
        for (const reservation of reservations) reservation.release();
        reservations.length = 0;
        scheduleLandingImageReconcile();
      }
      // Count ONLY undecodable images toward the generic "corrupted or too large"
      // toast. A valid image blocked solely by the aggregate budget is already
      // covered by `reserveLandingImageBudget`'s own accurate budget toast, so
      // adding this one would double-toast it with a false cause — matching the
      // shared file-paste path, which returns after the budget toast.
      let corruptedCount = 0;
      let acceptedIndex = 0;
      const outcomes = decoded.map((bytes): PastedComposerImageOutcome => {
        if (bytes === null) {
          corruptedCount += 1;
          return { kind: "rejected" };
        }
        if (!budgetOk) return { kind: "rejected" };
        const reservation = reservations[acceptedIndex];
        acceptedIndex += 1;
        const id = uuidv4();
        startPendingImageIngest(id, bytes, {
          onSettled: () => reservation.release(),
          reserveAfterStore: false,
        });
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
    [draftId, startPendingImageIngest],
  );
  // Mount-time re-entry completes the pending-node model: the b64 image node IS
  // the work token, so whichever mount owns the editor restarts its ingest. This
  // covers the null-bound first paste (which creates a draft and key-remounts the
  // composer) and any in-session navigate-away-and-back — the b64 node survives
  // in the canonical in-memory draft (`setDraftContent` no longer strips) and its
  // ingest resumes here. Idempotent by construction: `putImage` is content-
  // addressed + single-flight and the rewrite is by id, so re-ingesting a node an
  // aborted prior job already stored just re-roots the same hash. The restarted
  // job re-reserves the measured, now-hashed bytes after the shared write settles:
  // the original anonymous reservation is released first, while capacity consumed
  // during an inactive gap correctly rejects and removes the pending node.
  // Fired once per editor instance.
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
      startPendingImageIngest(atom.id, bytes, {
        onSettled: undefined,
        reserveAfterStore: true,
      });
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
  const readPromptStashImage = useCallback(async (hash: string) => {
    const bytes = await getImageBytes(hash);
    return bytes ?? null;
  }, []);
  // The unbound phase is intentionally namespaced away from the eventual
  // persisted draft id. Its runtime owns an independent revision counter, so
  // treating both phases as one identity could let equal counter values clear
  // content written after promotion.
  const stashIdentity = landingStashIdentity(draftId, props.pendingCreateId);
  const promptStashSource = useLandingPromptStashSource({
    stashIdentity,
    runtimeStore,
    draftId,
    unboundRuntime,
    editorRef,
  });
  const promptStashDestination = useLandingPromptStashDestination({
    stashIdentity,
    draftId,
    runtimeStore,
    editorRef,
  });
  const promptStash = usePromptStash({
    active: chatComposerActive,
    disabled: promptStashIsDisabled(isSubmitting, attachmentPending),
    editorRef,
    readHashImage: readPromptStashImage,
    source: promptStashSource,
    destination: promptStashDestination,
  });
  // Send-time gate for the selected provider's managed binary pack. Folded
  // into `canSubmit` rather than checked separately at submit, so the button
  // and its hint can never disagree - the user is told why BEFORE pressing,
  // which is the whole point of gating the affordance instead of accepting the
  // turn and failing it. Fails open while `providers.list` is loading; the
  // host resolver is the authoritative backstop either way.
  const packGate = useProviderPackGate(harnessId);
  const { submitBlocked, submitBlockedHint } = resolveLandingSubmitBlock({
    workspaceDisabledHint: workspaceAvailability.disabledHint,
    packPreparingHint: packGate.hint,
    packBlocked: packGate.blocked,
  });
  const canSubmit =
    !isSubmitting &&
    !attachmentPending &&
    !submitBlocked &&
    workspaceCanStart &&
    hasSubmittableContent;

  const actions = useLandingComposerActions();
  const { dictationControl, dictationPreparing } = useComposerDictation({
    editorRef,
    isActive: chatComposerActive,
  });

  const handleDocumentChange = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      if (runtime !== null) {
        runtime.setSnapshot(content, selection);
        return;
      }
      unboundRuntime.setState((current) => ({
        content,
        selection,
        contentRevision: current.contentRevision + 1,
        attachmentRoots: imageHashes(content),
      }));
      if (!contentIsSubmittable(content)) return;
      const existingDraftId = createdUnboundDraftIdRef.current;
      if (existingDraftId !== null) {
        useLandingDraftStore
          .getState()
          .setDraftContent(existingDraftId, content, selection);
        return;
      }
      // Reuse the parent-pre-minted mount key (props.pendingCreateId) as the
      // new draft's id so activeDraftId's null -> id flip lines up with the
      // key the parent already mounted under (no editor remount). Falls back
      // to a fresh id when the caller has not pre-minted one.
      const createdDraftId = useLandingDraftStore
        .getState()
        .createDraftWithId(
          props.pendingCreateId ?? uuidv4(),
          useComposerRunSettingsStore
            .getState()
            .getGlobalRunSettings(
              getHostBindingSnapshot()?.hostClient.getActiveHostId() ?? null,
            ),
        );
      createdUnboundDraftIdRef.current = createdDraftId;
      // The workspace picker's staging key is keyed by this draft id
      // (`{surface:"landing", draftId}`), so minting it here flips that key
      // from `landing:` to `landing:<id>` the instant this commits. Carry any
      // staged worktree intent over synchronously, before React re-renders
      // the picker on the new key - otherwise it briefly reads as unstaged
      // and the Environment dialog (keyed off the resolved target's kind)
      // remounts and drops an in-progress edit.
      useWorktreeIntentStagingStore
        .getState()
        .migrateKey(
          { surface: "landing", draftId: null },
          { surface: "landing", draftId: createdDraftId },
        );
      useLandingDraftStore
        .getState()
        .setDraftContent(createdDraftId, content, selection);
    },
    [props.pendingCreateId, runtime, unboundRuntime],
  );

  const handleSelectionChange = useCallback(
    (selection: { from: number; to: number }) => {
      if (runtime !== null) {
        runtime.setSelection(selection);
        return;
      }
      unboundRuntime.setState({ selection });
      const existingDraftId = createdUnboundDraftIdRef.current;
      if (existingDraftId === null) return;
      useLandingDraftStore
        .getState()
        .setDraftSelection(existingDraftId, selection);
    },
    [runtime, unboundRuntime],
  );

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const toolbar = toolbarStore.getState();
    if (toolbar.selection.modelSlug.length === 0) return;
    actions.submit({
      // `handleDocumentChange` mints the unbound draft the moment the first
      // edit becomes submittable, but `props.draftId` only catches up on the
      // parent's next render - so a type-then-Enter still reads `null` here.
      // Without this fallback `ensureSubmissionDraft` would mint a SECOND
      // draft and strand the one already holding the user's content.
      draftId: draftId ?? createdUnboundDraftIdRef.current,
      editor: editorRef.current,
      slashCatalog: pickerStore.getState().knownSlashCommands,
      toolbar: {
        selection: toolbar.selection,
        reasoning: toolbar.reasoning,
        serviceTier: toolbar.serviceTier,
        permission: toolbar.permission,
      },
    });
  }, [actions, canSubmit, draftId, pickerStore, toolbarStore]);

  const handleStartTerminal = useCallback(
    (launch: TerminalAgentLaunch) => {
      if (!workspaceCanStart || isSubmitting) return;
      actions.selectTerminalAgent(launch, draftId);
    },
    [actions, draftId, isSubmitting, workspaceCanStart],
  );

  const handleRemoveImage = useCallback(
    (id: string) => {
      if (isSubmitting) return;
      Analytics.getInstance().track(AnalyticsEvent.AttachmentRemoved, {
        kind: "image",
        surface: "draft",
      });
      editorRef.current?.removeImageAttachmentById(id);
    },
    [isSubmitting],
  );

  const switcher = (
    <ComposerModeSwitcher
      composerMode={composerMode}
      disabled={isSubmitting}
      onSwitch={() => {
        const next = nextComposerMode(composerMode);
        setGlobalComposerMode(next);
        if (draftId !== null) {
          setDraftComposerMode(draftId, next);
        }
      }}
    />
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
      workspaceDisabledHint={submitBlockedHint}
      header={<div className="flex justify-start">{switcher}</div>}
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
            // the `hostId={null}` this surface hands `ComposerBody` below.
            runTargetHostId={null}
            onSwitchProfile={onSwitchRateLimitedProfile}
            affectedChatCount={0}
            onSwitchProfileForTask={noopSwitchProfileForTask}
            onDismiss={rateLimitPrompt.dismiss}
          />
        ) : null
      }
      stashControl={
        <PromptStashControl
          controller={promptStash}
          pickerStore={pickerStore}
        />
      }
      attachmentsStrip={
        <LandingComposerAttachmentStrip
          content={runtimeState.content}
          onRemoveImage={handleRemoveImage}
        />
      }
      workspaceControls={props.workspaceControls(isSubmitting)}
      dictationControl={dictationControl}
      dictationPreparing={dictationPreparing}
      paste={paste}
      hasPastedImageBytes={hasLandingImageBytes}
      ingestPastedComposerImages={ingestPastedComposerImages}
      onEditorReady={reingestPendingImages}
      // No tab yet: the landing composer creates on the app-wide default host,
      // which its own host picker rebinds - so `null` (follow the default) IS
      // the picked host here.
      hostId={null}
      onSubmit={handleSubmit}
      onStartTerminal={handleStartTerminal}
      onDocumentChange={handleDocumentChange}
      onSelectionChange={handleSelectionChange}
    />
  );
}

/**
 * Whether submit is blocked by a gate that owes the user copy, and that copy.
 * Returned as a pair for the same reason `resolveSendBlock` does it in
 * `chat-composer.tsx`: a reason that kills the button without supplying its
 * hint leaves a grey button that reads as broken.
 *
 * Priority matches the chat composer's, and mirrors severity: the workspace
 * gate first (nothing can run, and the user has to fix it), then the
 * managed-pack gate (self-resolving, and it says so). Ordered the other way, a
 * user with an unusable workspace would sit through `Preparing… 40%` and find
 * the button still dead once the download finished, with the real reason only
 * appearing then.
 */
function resolveLandingSubmitBlock(args: {
  readonly workspaceDisabledHint: string | null;
  readonly packPreparingHint: string | null;
  readonly packBlocked: boolean;
}): {
  readonly submitBlocked: boolean;
  readonly submitBlockedHint: string | null;
} {
  return {
    submitBlocked: args.packBlocked,
    submitBlockedHint: args.workspaceDisabledHint ?? args.packPreparingHint,
  };
}

function noopSwitchProfileForTask(): void {}

function LandingComposerAttachmentStrip(props: {
  readonly content: JsonContent;
  readonly onRemoveImage: (id: string) => void;
}): ReactNode {
  const fetcher = useLandingImageFetcher();
  return (
    <AttachmentStrip
      content={props.content}
      onRemoveImage={props.onRemoveImage}
      fetcher={fetcher}
      sessionObjectUrl={sessionObjectUrl}
    />
  );
}
