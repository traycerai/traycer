import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import { v4 as uuidv4 } from "uuid";
import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
import { useLandingImageFetcher } from "@/hooks/composer/use-landing-image-fetcher";
import { useComposerPendingImageIngest } from "@/hooks/composer/use-composer-pending-image-ingest";
import {
  hasLandingImageBytes,
  sessionObjectUrl,
} from "@/lib/composer/landing-image-store";
import { useDraftFirstImageFetcher } from "@/lib/attachments/use-draft-image-fetcher";
import { markLandingEditorMounted } from "@/lib/composer/landing-image-gc";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useComposerPickerItems } from "@/components/chat/composer/picker/use-composer-picker-items";
import { NO_LOCAL_SLASH_COMMANDS } from "@/hooks/composer/use-slash-commands";
import { useProfileRateLimitSwitchPrompt } from "@/components/chat/composer/use-profile-rate-limit-switch-prompt";
import { ProfileRateLimitSwitchBanner } from "@/components/chat/composer/profile-rate-limit-switch-banner";
import type { TaskChatScope } from "@/components/chat/composer/use-task-profile-rate-limit-switch";
import { ProfileDisabledBanner } from "@/components/chat/composer/profile-disabled-banner";
import { useProfileEligibilityGate } from "@/components/chat/composer/use-profile-eligibility-gate";
import { useRefreshProvidersListOnTurn } from "@/hooks/providers/use-refresh-providers-list-on-turn";
import { commitProfileSelection } from "@/stores/composer/commit-selection";
import { ComposerBody } from "@/components/home/composer/composer-body";
import { LANDING_COMPOSER_EDITOR_CLASSNAME } from "@/components/home/composer/composer-editor-classnames";
import { useSurfaceActivity } from "@/components/home/composer/surface-activity-hooks";
import { useComposerDictation } from "@/hooks/composer/use-composer-dictation";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useLandingComposerPaste } from "@/hooks/composer/use-landing-composer-paste";
import { isAttachmentIngestPending } from "@/hooks/composer/use-composer-paste";
import { useLandingComposerMentionRoots } from "@/hooks/composer/use-workspace-mention-roots";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { useProviderPackGate } from "@/hooks/providers/use-provider-pack-gate";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import {
  selectGlobalLastRunSettings,
  useComposerRunSettingsStore,
} from "@/stores/composer/composer-run-settings-store";
import {
  landingRowIsForeign,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import { toastRepointedStagingReset } from "@/lib/composer/repointed-staging-toast";
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
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { ComposerModeSwitcher } from "@/components/home/composer/composer-mode-switcher";
import { useComposerPlacement } from "@/hooks/host/use-composer-placement";
import { subscribeFollowingSurfaceReset } from "@/stores/host/surface-host-selection-store";
import { ComposerHostNotice } from "@/components/home/composer/composer-host-notice";
import { toggleActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import { useComposerHostNotice } from "@/hooks/composer/use-composer-host-notice";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { ComposerDraftsControl } from "@/components/composer/drafts/composer-drafts-control";
import { forkLandingDraftInPlace } from "@/lib/drafts/landing-draft-fork";
import { useDraftAuthorityControl } from "@/hooks/drafts/use-draft-authority";

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

function landingComposerCanSubmit(args: {
  readonly isSubmitting: boolean;
  readonly attachmentPending: boolean;
  readonly submitBlocked: boolean;
  readonly workspaceCanStart: boolean;
  readonly hasSubmittableContent: boolean;
}): boolean {
  return (
    !args.isSubmitting &&
    !args.attachmentPending &&
    !args.submitBlocked &&
    args.workspaceCanStart &&
    args.hasSubmittableContent
  );
}

export function LandingComposer(props: LandingComposerProps) {
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const createdUnboundDraftIdRef = useRef<string | null>(null);
  const [pickerStore] = useState(() => createComposerPickerStore());
  // The composer's PLACEMENT (redesign P1.2, selection model §54): its own
  // window-keyed surface pin, or the effective host while it follows. Not the
  // app-wide selection - the picker no longer moves that - so every RPC this
  // surface makes, and every create it performs, resolves through here.
  const placement = useComposerPlacement(null);
  // READ target for this surface's queries; SUBMIT target (host-frozen client)
  // for anything that creates - see `useComposerPlacement`.
  const placementTarget = placement.target;
  const submitTarget = placement.submitTarget;
  const composerFollowsEffective = placement.followsEffective;
  const hostLabelFromDirectory = placement.hostLabelFor;
  const resolvedHostId = placementTarget.resolvedHostId;
  const hostClient = placementTarget.client;
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
  // Phones collapse the composer toolbar into a single options-sheet trigger.
  // Only the toolbar slot swaps, so the editor keeps its position in the tree
  // and never remounts when the viewport crosses the breakpoint.
  const isMobile = useIsMobileViewport();
  // The phone sheet (`ComposerShell`'s `expansion`); a sent draft drops it
  // back to the compact card.
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerExpansion = useMemo(
    () => ({
      expanded: composerExpanded,
      onExpandedChange: setComposerExpanded,
    }),
    [composerExpanded, setComposerExpanded],
  );

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
  // Keyed on the composer's RESOLVED host (pin ?? effective): under the
  // surface-pin model the settings memory follows what this draft will
  // actually create on, not an app-wide "active" the picker no longer moves.
  const activeHostId = resolvedHostId;
  const globalLastRunSettings = useComposerRunSettingsStore((state) =>
    selectGlobalLastRunSettings(state, activeHostId),
  );
  const setGlobalRunSettings = useComposerRunSettingsStore(
    (state) => state.setGlobalRunSettings,
  );
  const setDraftSettings = useLandingDraftStore(
    (state) => state.setDraftSettings,
  );
  // Hoisted above the toolbar wiring so the settings handler can reach it:
  // every control that mutates the persisted draft - the editor, the mode
  // switcher, the run-settings toolbar - notes its edit, and the first edit
  // of a draft this host does not own FORKS it underneath: the content moves
  // into a fresh draft of the placement host's own, the tab re-keys onto it
  // and the composer remounts under the new id with the same content and
  // caret. Nothing is held; the user never meets the ownership mechanism.
  // Foreignness is read at the edit (`landingRowIsForeign` against the
  // placement), never from a render.
  const isForeignDraft = useCallback((): boolean => {
    if (draftId === null) return false;
    const row = useLandingDraftStore
      .getState()
      .drafts.find((entry) => entry.id === draftId);
    return row !== undefined && landingRowIsForeign(row);
  }, [draftId]);
  const forkDraft = useCallback((): void => {
    if (draftId !== null) forkLandingDraftInPlace(draftId);
  }, [draftId]);
  const authority = useDraftAuthorityControl({
    isForeign: isForeignDraft,
    fork: forkDraft,
  });
  // Every local mutation of the draft row bumps `generation`, including the
  // workspace controls, whose handlers write the store without passing
  // through this component. A bump past the one seen at mount counts as an
  // edit only when a substantive field moved with it: a caret move bumps
  // `generation` but changes no field, and merely looking at a draft must
  // not fork it. A host echo changes fields without bumping `generation`,
  // so it does not count either.
  const landingEditMark = useLandingDraftStore(
    useShallow((state) => {
      const draft =
        draftId === null
          ? undefined
          : state.drafts.find((entry) => entry.id === draftId);
      return {
        generation: draft?.generation ?? 0,
        content: draft?.content ?? null,
        settings: draft?.settings ?? null,
        composerMode: draft?.composerMode ?? null,
        workspace: draft?.workspace ?? null,
        closed: draft?.closed ?? null,
      };
    }),
  );
  const seenEditMark = useRef<typeof landingEditMark | null>(null);
  useEffect(() => {
    const seen = seenEditMark.current;
    seenEditMark.current = landingEditMark;
    if (seen === null) return;
    if (landingEditMark.generation <= seen.generation) return;
    const substantive =
      landingEditMark.content !== seen.content ||
      landingEditMark.settings !== seen.settings ||
      landingEditMark.composerMode !== seen.composerMode ||
      landingEditMark.workspace !== seen.workspace ||
      landingEditMark.closed !== seen.closed;
    if (substantive) authority.noteEdit();
  }, [authority, landingEditMark]);
  const handleToolbarSettingsChange = useCallback(
    (settings: ChatRunSettings) => {
      setGlobalRunSettings(activeHostId, settings, Date.now());
      if (draftId !== null) {
        setDraftSettings(draftId, settings);
      }
      // After the write: the fork copies the row as it is, so the setting
      // rides into the fork and the old row is retired locally unpublished.
      authority.noteEdit();
    },
    [activeHostId, authority, draftId, setDraftSettings, setGlobalRunSettings],
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
  // `globalLastRunSettings` fallback - validated against this composer's
  // resolved host (the one this draft will actually create the chat on) via
  // the same machinery `useComposerToolbarStore` runs for every composer
  // surface. Never authoritative: the landing composer has no reauth gate of
  // its own to defend a dead pin with a banner, so a genuinely-removed profile
  // must be corrected to ambient here rather than silently submitted as the
  // new chat's initial settings. The catalog reads through the same
  // `hostClient` - the composer's pinned/followed host, NOT the app-wide
  // default (P1.2 retired the picker's rebind of that default).
  const toolbarStore = useComposerToolbarStore(
    "landing",
    fallbackSeedSource(settingsSeed, hostClient),
    handleToolbarSettingsChange,
    {
      hostClient,
      hostId: activeHostId,
      tuiOnly: composerMode === "terminal",
      // The landing composer has no chat yet - see `ComposerBody`.
      chatLineCarriesAutoMode: null,
    },
  );
  const harnessId = useStore(toolbarStore, (s) => s.selection.harnessId);
  const profileId = useStore(toolbarStore, (s) => s.selection.profileId);
  const selectedModel = useStore(toolbarStore, (s) => s.selectedModel);
  const profileEligibility = useProfileEligibilityGate(
    hostClient,
    harnessId,
    profileId,
    chatComposerActive,
  );
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
    // No chat exists yet, so there is nothing a `/btw` could fork.
    localSlashCommands: NO_LOCAL_SLASH_COMMANDS,
  });

  // Hoisted from below so `isSubmitting` can read it. The create observers
  // live in here, which is what actually mutates. This surface used to build a
  // SECOND pair of them locally and read their `isPending` - two observers
  // nobody ever called `.mutate()` on, so both booleans were permanently false
  // and the OR below had exactly one live term. Deleted rather than
  // re-pointed: they also cost two live mutation subscriptions for an answer
  // they could not give.
  const actions = useLandingComposerActions(submitTarget);
  const isSubmitting = runtimeState.isSubmitting || actions.isPending;
  const mutationsDisabled = isSubmitting;

  const hasSubmittableContent = contentIsSubmittable(runtimeState.content);
  const draftWorkspace = useLandingDraftStore((state) => {
    if (draftId === null) return null;
    return (
      state.drafts.find((draft) => draft.id === draftId)?.workspace ?? null
    );
  });
  // Rate-limit switch prompt for the landing composer's own toolbar
  // selection, scoped to this composer's RESOLVED host (landing has no tab of
  // its own) - the same shared hook the chat composer uses, mirroring its
  // wiring in `chat-composer.tsx`. Purely informational: it never blocks
  // epic creation.
  const rateLimitPrompt = useProfileRateLimitSwitchPrompt({
    harnessId,
    profileId,
    selectedModel,
    active: activityEnabled,
    client: hostClient,
  });
  // Keeps the banner's `providers.list` read converging with a turn's
  // passive rate-limit capture from ANY running epic on this host -
  // mirrors `useRefreshProvidersListOnTurn` in `chat-composer.tsx`, scoped to
  // the composer's resolved host. (It used the app-wide default before P1.2;
  // a pinned composer would then invalidate a cache entry keyed to a host it
  // never reads, and never the one whose banner it feeds.)
  useRefreshProvidersListOnTurn(harnessId, resolvedHostId);
  const onSwitchRateLimitedProfile = useCallback(
    (nextProfileId: string | null) => {
      commitProfileSelection(toolbarStore, nextProfileId);
    },
    [toolbarStore],
  );
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
  const runnerHost = useRunnerHost();
  const paste = useLandingComposerPaste({
    editorRef,
    draftId,
    disabled: isSubmitting,
    fileDrops: runnerHost.fileDrops,
    mentionRoots,
  });
  // The SHARED pending-image ingest, the same one the chat composer, the inline
  // edit and the new-conversation modal use. This surface grew the logic first
  // and kept a private copy through the epic that extracted it, because it was
  // the control the three new callers were compared against. The copy has now
  // been retired: it had drifted behind on five fixes the shared hook received
  // during that review - a deadline on the store write, a reconcile for a write
  // that lands after the deadline, the format verdict running before budget
  // admission, reservations keyed by image index rather than a running counter,
  // and leaving a format the host refuses INLINE instead of hashing it.
  //
  // `draftId` names the budget toast's wording, and is non-null only here: this
  // is the one composer whose draft a user could close to free capacity.
  const { ingestPastedComposerImages, reingestPendingImages } =
    useComposerPendingImageIngest({
      editorRef,
      runPendingImageJob: paste.runPendingImageJob,
      draftId,
    });
  const attachmentPending = isAttachmentIngestPending(paste);
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
    profileDisabled: profileEligibility.disabled,
  });
  const canSubmit = landingComposerCanSubmit({
    isSubmitting,
    attachmentPending,
    submitBlocked,
    workspaceCanStart,
    hasSubmittableContent,
  });

  // Submit-time refusal copy (selection model §54). The G4 re-point used to
  // share this slot; it narrates as a toast now, and only when it actually
  // reset staged intent — see the effect below.
  const {
    notice: hostNotice,
    raise: raiseHostNotice,
    dismiss: dismissHostNotice,
  } = useComposerHostNotice(resolvedHostId);
  // G4: this composer FOLLOWS the effective host only when nothing else
  // answered its placement - no override, no pin IN FORCE - and only then
  // does a derivation move re-point it and its host-dependent state must not
  // silently travel with it: the staged worktree/branch choices name paths
  // and refs on the machine the user picked them on. `placement.pin.isPinned`
  // alone is NOT the right gate here: a DEPOSED pin (its host died, so the
  // composer auto-followed) still reads `isPinned: true` while
  // `honoredSelection` is null, and that composer genuinely re-pointed - the
  // stale `isPinned` gate would suppress both the notice and the staged-intent
  // reset for a move that just happened. A composer resting on its pin is not
  // moved by the derivation and must not narrate one (D6).
  //
  // Deliberately scoped to the staged INTENT, not to the draft's chosen
  // folders: an automatic failover is not a user gesture, and discarding a
  // folder set the user assembled by hand would be an unrecoverable loss on a
  // blip. The folders re-resolve against the new host through the picker's
  // existing absent-row + Locate affordance, which names the dangle instead of
  // hiding it - and submit re-validation stands behind both.
  //
  // Narrated as a toast, and ONLY when the move reset something: the switch
  // itself is `toastSelectionSwitched`'s to tell, and a persistent banner
  // here outlived the condition it described — a startup failover round trip
  // left it announcing the user's own host as news over an empty composer.
  useEffect(() => {
    return subscribeFollowingSurfaceReset(({ nextEffectiveHostId }) => {
      if (!composerFollowsEffective) return;
      const stagingKey = {
        surface: "landing",
        hostId: activeHostId,
        draftId,
      } as const;
      // Checked at the SAME breadth this clears at - one bucket, the host the
      // composer is leaving. The modal's equivalent asks across every host
      // because it clears across every host; pairing the two is what keeps
      // "we warn exactly when we destroyed something" true on both surfaces.
      const hadStagedIntent = readStagedWorktreeIntent(stagingKey) !== null;
      useWorktreeIntentStagingStore.getState().clear(stagingKey);
      if (hadStagedIntent) {
        toastRepointedStagingReset(hostLabelFromDirectory(nextEffectiveHostId));
      }
    });
  }, [activeHostId, composerFollowsEffective, draftId, hostLabelFromDirectory]);
  const { dictationControl, dictationPreparing } = useComposerDictation({
    editorRef,
    isActive: chatComposerActive,
  });

  /**
   * The id of this start page's draft, minting it when the page is still
   * unbound. The ONE mint path for an unbound landing composer: the first
   * substantive edit calls it, and so does the picker's sign-in button, whose
   * terminal panel does not exist until a draft anchors it.
   *
   * Idempotent per composer - a second call returns the id the first minted -
   * so pressing the button and then typing does not create two drafts.
   */
  const ensureBoundDraftId = useCallback((): string => {
    // An already-bound page mints nothing. `handleDocumentChange` reaches this
    // only while unbound (a bound composer returns on its own runtime first),
    // but the sign-in button calls it from both states.
    if (draftId !== null) return draftId;
    const existingDraftId = createdUnboundDraftIdRef.current;
    if (existingDraftId !== null) return existingDraftId;
    // Reuse the parent-pre-minted mount key (props.pendingCreateId) as the
    // new draft's id so activeDraftId's null -> id flip lines up with the
    // key the parent already mounted under (no editor remount). Falls back
    // to a fresh id when the caller has not pre-minted one.
    const createdDraftId = useLandingDraftStore.getState().createDraftWithId(
      props.pendingCreateId ?? uuidv4(),
      useComposerRunSettingsStore
        .getState()
        // The composer's own resolved placement host - not the app
        // binding: the seed should describe the machine this draft
        // will create on.
        .getGlobalRunSettings(activeHostId),
    );
    // Keep the workspace aligned with the caller's captured placement, which
    // supplied the settings above, before accepting a submit.
    useLandingDraftStore
      .getState()
      .restoreDraftWorkspaceForHost(createdDraftId, activeHostId);
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
      .migrateKeyForAllHosts(
        { surface: "landing", hostId: activeHostId, draftId: null },
        { surface: "landing", hostId: activeHostId, draftId: createdDraftId },
      );
    return createdDraftId;
  }, [activeHostId, draftId, props.pendingCreateId]);

  // The start page whose terminal panel a picker-started setup terminal opens
  // in, keyed exactly as the panel keys its layouts. It BINDS the page rather
  // than naming it: an unbound start page renders no pane anchor, so its panel
  // has nowhere to mount and the sign-in terminal would exist unseen. Memoized
  // because the toolbar and picker are memo'd.
  const terminalLoginSurface = useMemo<ProviderTerminalLoginSurface>(
    () => ({ kind: "landing", resolveLandingPageId: ensureBoundDraftId }),
    [ensureBoundDraftId],
  );

  const handleDocumentChange = useCallback(
    (content: JsonContent, selection: { from: number; to: number }) => {
      if (runtime !== null) {
        runtime.setSnapshot(content, selection);
        // After the write, in the same handler: a fork flushes the runtime
        // first, so the copy carries this keystroke, and the old row (never
        // written through - it is foreign) is retired locally underneath.
        authority.noteEdit();
        return;
      }
      unboundRuntime.setState((current) => ({
        content,
        selection,
        contentRevision: current.contentRevision + 1,
        attachmentRoots: imageHashes(content),
      }));
      if (!contentIsSubmittable(content)) return;
      useLandingDraftStore
        .getState()
        .setDraftContent(ensureBoundDraftId(), content, selection);
    },
    [authority, ensureBoundDraftId, runtime, unboundRuntime],
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

  const handleSubmit = useCallback((): boolean => {
    if (!canSubmit) return false;
    const toolbar = toolbarStore.getState();
    if (toolbar.selection.modelSlug.length === 0) return false;
    // Submit is "delete the draft here, create the chat". A draft this host
    // does not own is sent as it is: its retirement receipt keeps the row
    // from being ingested back here, and its cloud row is retracted on the
    // user's authority underneath. Nothing waits on ownership.
    const refusal = actions.submit({
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
    // Nothing was created when a refusal comes back - the draft, its content
    // and its staged workspace are exactly as the user left them, and the
    // reason is stated inline above the composer rather than as a toast.
    raiseHostNotice(
      refusal === null ? null : { kind: "refused", message: refusal.message },
    );
    if (refusal === null) setComposerExpanded(false);
    return refusal === null;
  }, [
    actions,
    canSubmit,
    draftId,
    pickerStore,
    raiseHostNotice,
    setComposerExpanded,
    toolbarStore,
  ]);

  const dispatchStartTerminal = useCallback(
    (launch: TerminalAgentLaunch): boolean => {
      const refusal = actions.selectTerminalAgent(launch, draftId);
      raiseHostNotice(
        refusal === null ? null : { kind: "refused", message: refusal.message },
      );
      return refusal === null;
    },
    [actions, draftId, raiseHostNotice],
  );
  const handleStartTerminal = useCallback(
    (launch: TerminalAgentLaunch, assembledFor: string | null): boolean => {
      if (!workspaceCanStart || isSubmitting) return false;
      // A launch names a harness, model and profile out of the host's own
      // catalog. `assembledFor` is the host the terminal panel held when it
      // assembled the launch (the one its picker resolved against), so a
      // launch put together for a host the placement has since left is
      // dropped rather than forwarded to a host whose catalog may not hold
      // them.
      if (assembledFor !== null && assembledFor !== resolvedHostId) {
        return false;
      }
      return dispatchStartTerminal(launch);
    },
    [dispatchStartTerminal, isSubmitting, resolvedHostId, workspaceCanStart],
  );

  const handleRemoveImage = useCallback(
    (id: string) => {
      if (mutationsDisabled) return;
      Analytics.getInstance().track(AnalyticsEvent.AttachmentRemoved, {
        kind: "image",
        surface: "draft",
      });
      editorRef.current?.removeImageAttachmentById(id);
    },
    [mutationsDisabled],
  );

  const switcher = (
    <ComposerModeSwitcher
      composerMode={composerMode}
      disabled={mutationsDisabled}
      onSwitch={() => {
        const next = nextComposerMode(composerMode);
        setGlobalComposerMode(next);
        if (draftId !== null) {
          setDraftComposerMode(draftId, next);
        }
        authority.noteEdit();
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
      editorClassName={LANDING_COMPOSER_EDITOR_CLASSNAME}
      initialContent={initialContent}
      initialSelection={initialSelection}
      canSubmit={canSubmit}
      isSubmitting={isSubmitting}
      editorReadOnly={false}
      attachmentPending={attachmentPending}
      workspaceDisabledHint={submitBlockedHint}
      header={<div className="flex justify-start">{switcher}</div>}
      toolbarLayout={isMobile ? "collapsed" : "full"}
      expansion={composerExpansion}
      topBanner={
        <>
          <ComposerHostNotice
            notice={hostNotice}
            onDismiss={dismissHostNotice}
          />
          {profileEligibility.disabled ? (
            <ProfileDisabledBanner
              profileLabel={profileEligibility.profileLabel}
              enablePending={profileEligibility.enablePending}
              onEnableProfile={profileEligibility.enableProfile}
              onChooseProfile={() => {
                toggleActiveModelPicker();
              }}
            />
          ) : null}
          {!profileEligibility.disabled &&
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
              // The composer's resolved host (pin, else effective), matching
              // the `hostId` this surface hands `ComposerBody` below - so the
              // usage sidecar / R-key refresh reads the machine the turn will
              // actually run on.
              runTargetHostId={resolvedHostId}
              onSwitchProfile={onSwitchRateLimitedProfile}
              taskScope={NO_TASK_SCOPE}
              onResolveTaskScope={noopResolveTaskScope}
              onSwitchProfileForTask={noopSwitchProfileForTask}
              onDismiss={rateLimitPrompt.dismiss}
            />
          ) : null}
        </>
      }
      draftsControl={
        <ComposerDraftsControl
          scope={{ surface: "landing", activeDraftId: draftId }}
          hostId={resolvedHostId}
          pickerStore={pickerStore}
          editorRef={editorRef}
          // The rail is no longer chat-mode-only (D11), so the Cmd+S owner is
          // the surface being edited, whichever composer mode it is in.
          active={activityEnabled}
        />
      }
      attachmentsStrip={
        <LandingComposerAttachmentStrip
          content={runtimeState.content}
          onRemoveImage={handleRemoveImage}
          hostId={resolvedHostId}
        />
      }
      workspaceControls={props.workspaceControls(mutationsDisabled)}
      dictationControl={dictationControl}
      dictationPreparing={dictationPreparing}
      paste={paste}
      hasPastedImageBytes={hasLandingImageBytes}
      ingestPastedComposerImages={ingestPastedComposerImages}
      onEditorReady={reingestPendingImages}
      // No tab yet, but a placement all the same: the composer creates on its
      // window-keyed surface pin's resolved host (P1.2). `null` reaches here
      // only in the ∅ case - nothing usable to create on - which submit
      // re-validation refuses before any create runs.
      hostId={resolvedHostId}
      terminalLoginSurface={terminalLoginSurface}
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
  readonly profileDisabled: boolean;
}): {
  readonly submitBlocked: boolean;
  readonly submitBlockedHint: string | null;
} {
  return {
    submitBlocked: args.profileDisabled || args.packBlocked,
    submitBlockedHint:
      args.workspaceDisabledHint ??
      (args.profileDisabled
        ? "Profile disabled — enable it or choose another profile"
        : args.packPreparingHint),
  };
}

function noopSwitchProfileForTask(): void {}

function noopResolveTaskScope(): void {}

/** A new task has no sibling chats to switch with it. */
const NO_TASK_SCOPE: TaskChatScope = { kind: "none" };

/**
 * Exported for its test only. The byte source below is the whole subject of
 * that test, and a test that rebuilt this composition itself would keep passing
 * after someone put the local-only fetcher back - which is the regression it
 * exists to catch.
 */
export function LandingComposerAttachmentStrip(props: {
  readonly content: JsonContent;
  readonly onRemoveImage: (id: string) => void;
  readonly hostId: string | null;
}): ReactNode {
  // Draft-first, over the local-only landing fetcher rather than instead of it.
  // A restored draft's chip used to have exactly one source - this window's
  // partition - and the blob cache retries a failed fetch four times inside
  // about 1.75 s before resting on `unavailable` until a remount. Bytes that a
  // cloud recovery landed at three seconds therefore sat in the store with
  // nothing to make the mounted chip look again. Resolving through the draft
  // legs means the chip's OWN fetch performs the cloud read, so it renders on
  // the first attempt instead of racing that ladder. The landing fetcher stays
  // underneath as the fallback whose throw keeps the poisoned-entry retry.
  const fetcher = useDraftFirstImageFetcher(
    useLandingImageFetcher(),
    props.hostId,
  );
  return (
    <AttachmentStrip
      content={props.content}
      onRemoveImage={props.onRemoveImage}
      fetcher={fetcher}
      sessionObjectUrl={sessionObjectUrl}
    />
  );
}
