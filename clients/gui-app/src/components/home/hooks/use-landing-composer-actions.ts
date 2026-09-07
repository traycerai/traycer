import { useCallback, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import type {
  CreateEpicChatSeed,
  CreateEpicResponse,
  CreateEpicWorkspaceIdentifier,
  TaskRepoIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorktreeBindingSelectorRowV12,
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
  WorktreeWorkspaceSummaryV14,
} from "@traycer/protocol/host/worktree-schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import { CURRENT_EPIC_VERSION } from "@traycer-clients/shared/epic/epic-version";

import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useEpicCreateForClient } from "@/hooks/epic/use-epic-create-mutation";
import { useCreateTuiAgentForClient } from "@/hooks/agent/use-create-tui-agent";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  readStagedWorktreeIntent,
  stagedWorktreeIntentIsSuspended,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import {
  useLandingDraftStore,
  type LandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";
import {
  draftRuntimeRegistry,
  type DraftSubmissionPlacement,
  type DraftSubmissionAttempt,
} from "@/stores/home/draft-runtime-registry";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  markEpicCreatedThisSession,
  unmarkEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import {
  activateTabIntent,
  existingEpicTabIntent,
  navigateToTabIntent,
  openExactEpicTabIntent,
} from "@/lib/tab-navigation";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  buildSubmittedChatJSONContent,
  extractPlainTextFromComposerJSONContent,
  stringValue,
  type SlashCommandCatalog,
} from "@/lib/composer/tiptap-json-content";
import { normalizeComposerContentWithSelection } from "@/lib/composer/composer-content-normalizer";
import {
  collectImageAtoms,
  containsImageAtoms,
} from "@/lib/composer/image-atoms";
import {
  getImageBytes,
  sessionImageBytes,
} from "@/lib/composer/landing-image-store";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import {
  orderFoldersPrimaryFirst,
  resolvePrimaryPath,
} from "@/lib/worktree/resolve-primary-path";
import {
  clearEpicCreateSeedPending,
  markEpicCreateSeedPending,
} from "@/lib/worktree/pending-epic-create-seeds";
import { effectiveWorktreeIntent } from "@/lib/worktree/effective-worktree-intent";
import {
  resolveLandingPlacement,
  type LandingPlacementTarget,
} from "@/lib/composer/landing-placement";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type {
  PermissionMode,
  HarnessModelSelection,
  ReasoningLevel,
  ServiceTier,
} from "@/components/home/data/landing-options";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useTabsStore } from "@/stores/tabs/store";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { toast } from "sonner";
import {
  buildDefaultBranchByPath,
  EMPTY_DEFAULT_BRANCH,
} from "@/lib/worktree/default-branch-name";
import { defaultFolderIntent } from "@/lib/worktree/worktree-intent-seeding";
import { useSettingsStore } from "@/stores/settings/settings-store";

export interface LandingComposerSubmitArgs {
  /** The caller-owned draft; null creates one before the exact attempt starts. */
  readonly draftId: string | null;
  readonly editor: ComposerPromptEditorHandle | null;
  /** Submit-time chip conversion resolves a written `/command` / `$skill` against it - see
   * `buildSubmittedChatJSONContent`. Read at submit time by the caller, which owns the picker store. */
  readonly slashCatalog: SlashCommandCatalog | null;
  readonly toolbar: {
    readonly selection: HarnessModelSelection;
    readonly reasoning: ReasoningLevel;
    readonly serviceTier: ServiceTier;
    readonly permission: PermissionMode;
  };
}

export interface TerminalAgentLaunch {
  readonly harnessId: TuiHarnessId;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly terminalAgentArgs: string | null;
  // Which of the harness's logged-in profiles (subscriptions) to launch this
  // agent on. `null` = the ambient/host login.
  readonly profileId: string | null;
}

/** Both actions return the submit-time placement refusal (selection model §54) instead of dispatching, or
 * `null` when the create was dispatched. */
export interface LandingComposerActions {
  readonly submit: (
    args: LandingComposerSubmitArgs,
  ) => LandingPlacementRefusal | null;
  readonly selectTerminalAgent: (
    launch: TerminalAgentLaunch,
    draftId: string | null,
  ) => LandingPlacementRefusal | null;
  /** A shared `mutationKey` would not have fixed it either (keys do not sync observers. */
  readonly isPending: boolean;
}

export interface LandingPlacementRefusal {
  readonly message: string;
}

interface FinalizeLandingSubmissionInput {
  readonly resolvedContent: JsonContent;
  readonly text: string;
  readonly args: LandingComposerSubmitArgs;
  readonly workspaceContext: LandingWorkspaceContext;
  readonly attempt: DraftSubmissionAttempt;
  /** Never re-read off a client here: a second read could answer with a host the user was never shown. */
  readonly hostId: string;
}

/** Identities change only when the underlying mutation handles, `navigate`, or the composer's placement target
 * change. */
export function useLandingComposerActions(
  target: LandingPlacementTarget,
): LandingComposerActions {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createEpic = useEpicCreateForClient(target.client);
  const terminalAgentCreate = useCreateTuiAgentForClient(
    target.client,
    target.resolvedHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const createEpicMutateAsync = createEpic.mutateAsync;
  const terminalAgentCreateFn = terminalAgentCreate.create;

  // Guards the async (session-cold image) submit path against re-entry: on that path `createEpic.isPending` -
  // and thus the composer's `canSubmit`.
  const submissionInFlightRef = useRef(false);

  // Single create path for GUI-chat and terminal-agent so epic.create and the optimistic history insert stay aligned.
  const createLandingEpic = useCallback(
    (input: {
      readonly epicId: string;
      /** The validated placement host - never re-read off a client here. */
      readonly hostId: string;
      readonly title: string;
      readonly initialUserPrompt: string;
      readonly chat: CreateEpicChatSeed | null;
      readonly workspaceFolders: ReadonlyArray<string>;
      readonly workspaceFolderInfoByPath: Readonly<
        Record<string, WorkspaceFolderInfo>
      >;
      readonly now: number;
    }): Promise<CreateEpicResponse> => {
      const profile = useAuthStore.getState().profile;
      const hostId = input.hostId;
      const optimisticRows = buildOptimisticWorkspaceBindingRows(
        input.workspaceFolders,
        input.workspaceFolderInfoByPath,
        hostId,
      );
      // Keep the create-time tab binding and the placement host in lockstep, or seed under the host the initial tabs
      // bind to instead.
      const seededBindingsKey =
        optimisticRows.length > 0
          ? hostQueryKeys.method<
              HostRpcRegistry,
              "worktree.listBindingsForEpic"
            >(hostId, "worktree.listBindingsForEpic", {
              epicId: input.epicId,
            })
          : null;
      const seedBindings = () => {
        if (seededBindingsKey === null) return;
        queryClient.setQueryData<{
          readonly rows: WorktreeBindingSelectorRowV12[];
        }>(seededBindingsKey, { rows: [...optimisticRows] });
      };
      // Seed the binding-list query cache with the folders the user just picked before the create resolves.
      seedBindings();
      // While the create is in flight the seed is authoritative: a `worktree.changed` burst refetch could return
      // pre-binding `{ rows.
      if (seededBindingsKey !== null) {
        markEpicCreateSeedPending(input.epicId);
      }
      return createEpicMutateAsync({
        epic: buildEpicLight({
          id: input.epicId,
          title: input.title,
          initialUserPrompt: input.initialUserPrompt,
          createdBy: profile?.email ?? profile?.userName ?? "unknown",
          now: input.now,
        }),
        repoIdentifiers: buildRepoIdentifiers(
          input.workspaceFolders,
          input.workspaceFolderInfoByPath,
        ),
        workspaces: buildWorkspaceAssociations(
          input.workspaceFolders,
          input.workspaceFolderInfoByPath,
        ),
        chat: input.chat,
      })
        .then((response) => {
          // `useEpicCreateForClient`'s invalidation then reconciles to the host's truth, including later removals, so
          // the chip can't get stuck showing removed folders.
          seedBindings();
          clearEpicCreateSeedPending(input.epicId);
          return response;
        })
        .catch((error: unknown) => {
          clearEpicCreateSeedPending(input.epicId);
          // Roll back the seed so a failed create can't leave the chip showing
          // folders for an epic that never existed.
          if (seededBindingsKey !== null) {
            queryClient.removeQueries({ queryKey: seededBindingsKey });
          }
          throw error;
        });
    },
    [createEpicMutateAsync, queryClient],
  );

  // Pulled into its own callback so the dispatcher below can feed it either the synchronously re-inlined content
  // (cached images.
  const finalizeSubmission = useCallback(
    (input: FinalizeLandingSubmissionInput) => {
      const { resolvedContent, text, args, workspaceContext, attempt } = input;
      const activeHostId = input.hostId;
      const { editor, toolbar } = args;
      if (editor === null) {
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      const runtime = draftRuntimeRegistry.getOrHydrate(args.draftId);
      if (runtime === null || !runtime.canStartCreate(attempt)) {
        draftRuntimeRegistry.complete(attempt);
        return;
      }

      const submittedContent = buildSubmittedChatJSONContent(
        resolvedContent,
        args.slashCatalog,
      );
      const profile = useAuthStore.getState().profile;

      const settings = buildChatRunSettings({
        selection: toolbar.selection,
        permission: toolbar.permission,
        reasoning: toolbar.reasoning,
        serviceTier: toolbar.serviceTier,
      });
      if (settings.model.length === 0) {
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      // Global, single-selection billing context captured at create time; it
      // rides as a sibling of the per-chat settings on the initial message.
      const accountContext = useAccountContextStore.getState().accountContext;

      const epicId = uuidv4();
      const chatId = uuidv4();
      // Pre-mint so the same ids ride on `epic.createChat`'s `initialMessage`
      // (turn-overlap) and any fallback `send`; the host dedupes on them.
      const messageId = uuidv4();
      const clientActionId = uuidv4();
      const now = Date.now();
      // Nothing structural forces a future caller to derive both from one placement, so fail closed if they name
      // different machines.
      if (
        workspaceContext.hostId !== null &&
        workspaceContext.hostId !== activeHostId
      ) {
        reportableErrorToast(
          "Couldn't create epic.",
          {
            description:
              "The active device changed while this was being prepared. Try again.",
          },
          {
            title: "Could not create Epic",
            message: "Active device changed mid-submission.",
            code: null,
            source: "Epic creation",
          },
        );
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      const userId = profile?.userId ?? null;
      const initialMessage =
        userId !== null
          ? {
              messageId,
              clientActionId,
              content: submittedContent,
              sender: { type: "user" as const, userId },
              settings,
              accountContext,
            }
          : null;

      // Local handoff state is prepared before it, but the draft/layout is deliberately untouched until this exact
      // runtime's create reports success.
      useComposerRunSettingsStore
        .getState()
        .setGlobalRunSettings(activeHostId, settings, now);
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings(epicId, activeHostId, settings, now);
      rememberLandingWorktreeIntent(workspaceContext, epicId, now);
      useInitialChatHandoffStore.getState().register({
        hostId: activeHostId,
        userId,
        epicId,
        chatId,
        content: submittedContent,
        settings,
        worktreeIntent: workspaceContext.worktreeIntent,
        placement: null,
        messageId,
        clientActionId,
        createdAt: now,
      });
      // Stored untitled; the displayed label is derived at render via
      // `epicDisplayTitle`.
      const epicTitle = "";
      const tabId = uuidv4();
      // Spinner anchor is the pre-generation title (empty here); it clears once
      // a non-empty title is projected or the backstop fires.
      if (initialMessage !== null) {
        // The spinner shows while the projected title is still empty and clears once a non-empty AI title is projected
        // (or the 30s backstop fires).
        useEpicCanvasStore.getState().markChatTitlePending(chatId, "");
      }

      if (!runtime.markCreateStarted(attempt)) {
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      // Mark before the one-shot create request so the existence reconciler cannot prune the result while
      // `epic.listTasks` still lags it.
      markEpicCreatedThisSession(epicId, activeHostId);

      void createLandingEpic({
        epicId,
        hostId: activeHostId,
        title: epicTitle,
        initialUserPrompt: text,
        workspaceFolders: workspaceContext.workspaceFolders,
        workspaceFolderInfoByPath: workspaceContext.workspaceFolderInfoByPath,
        now,
        chat: {
          chatId,
          parentId: null,
          hostId: activeHostId,
          // Stored untitled; the "Untitled agent" / first-message fallback is a
          // render concern, never baked into the stored title.
          title: "",
          workspaceMode: workspaceContext.workspaceMode,
          worktreeIntent: workspaceContext.worktreeIntent,
          initialMessage,
        },
      })
        .then((response) => {
          const settlement = draftRuntimeRegistry.settlement(attempt);
          if (settlement.kind === "retired") {
            discardRetiredLandingEpic({ epicId, chatId });
            draftRuntimeRegistry.complete(attempt);
            return;
          }
          // The server accepted the exact staged worktree intent. Failed
          // preparation and rejected create paths leave it intact for retry.
          clearConsumedLandingWorktreeIntent(workspaceContext);
          // Re-anchor the create-race window on completion - see the terminal flow's copy for why.
          markEpicCreatedThisSession(epicId, activeHostId);
          // The host already kicked the provider turn from `initialMessage`; jump the handoff straight to `sending` so
          // the driver does not re-send.
          if (response.initialTurnStarted === true) {
            useInitialChatHandoffStore
              .getState()
              .markInitialTurnStarted(
                { hostId: activeHostId, userId, epicId },
                chatId,
              );
          }
          if (settlement.kind === "current") {
            placeCreatedDraftEpic({
              draftId: attempt.draftId,
              epicId,
              tabId,
              epicTitle,
              editor,
              placement: attempt.placement,
              activate: () => {
                // Keep the normal underlying transition from draft to Epic, but carry that foreground overlay onto the Epic
                // route so async completion cannot dismiss it.
                const preserveSystemOverlay =
                  (getSystemTabModalApi()?.active ?? null) !== null;
                activateTabIntent(
                  navigate,
                  existingEpicTabIntent({ epicId, tabId, focus: undefined }),
                  preserveSystemOverlay
                    ? { search: (previous) => previous }
                    : undefined,
                );
              },
            });
          } else {
            // The successful server result remains discoverable without replacing or focusing either one.
            placeCreatedEpicInBackground(epicId, epicTitle);
          }
          draftRuntimeRegistry.complete(attempt);
        })
        .catch(() => {
          // A retired attempt takes the same exit as the success path above: the id-scoped leftovers still have to go,
          // but `markFailed` must not.
          if (draftRuntimeRegistry.settlement(attempt).kind === "retired") {
            discardRetiredLandingEpic({ epicId, chatId });
            draftRuntimeRegistry.complete(attempt);
            return;
          }
          // The epic never landed on the host: drop the create marker so its
          // orphaned tab is no longer exempt from existence reconciliation.
          unmarkEpicCreatedThisSession(epicId);
          useComposerRunSettingsStore.getState().clearEpicRunSettings([epicId]);
          useEpicCanvasStore.getState().clearEpicTitlePending(epicId);
          useEpicCanvasStore.getState().clearChatTitlePending(chatId);
          useInitialChatHandoffStore
            .getState()
            .markFailed(
              { hostId: activeHostId, userId, epicId },
              "Couldn't create the epic.",
            );
          draftRuntimeRegistry.complete(attempt);
        });
    },
    [createLandingEpic, navigate],
  );

  const dispatchSubmission = useCallback(
    (
      args: LandingComposerSubmitArgs,
      workspaceContext: LandingWorkspaceContext,
      hostId: string,
    ) => {
      const { editor } = args;
      if (editor === null) return;

      const normalized = normalizeComposerContentWithSelection(
        editor.getJSON(),
        null,
      );
      const editorContent = normalized.content;
      const text = extractPlainTextFromComposerJSONContent(editorContent);
      const hasImages = containsImageAtoms(editorContent);
      if (text.trim().length === 0 && !hasImages) return;
      const draftId = ensureSubmissionDraft(
        args.draftId,
        editorContent,
        hostId,
      );
      const runtime = draftRuntimeRegistry.getOrHydrate(draftId);
      if (runtime === null) return;
      // `normalized.changed` is a cheap structural flag, not a document comparison, so this never walks/serializes
      // the (possibly multi-megabyte inline-image) content.
      if (normalized.changed) {
        runtime.setSnapshot(editorContent, runtime.store.getState().selection);
      }
      const attempt = runtime.startSubmission(
        captureSubmissionPlacement(draftId),
      );
      if (attempt === null) return;
      const exactArgs = { ...args, draftId };

      // The live editor content is hash-only (landing pastes hashes, never base64).
      const hashes = imageHashesFromContent(editorContent);
      if (hashes.length === 0) {
        finalizeSubmission({
          resolvedContent: editorContent,
          text,
          args: exactArgs,
          workspaceContext,
          attempt,
          hostId,
        });
        return;
      }
      const sessionBytes = readSessionImageBytes(hashes);
      if (sessionBytes !== null) {
        finalizeSubmission({
          resolvedContent: inlineImageHashes(editorContent, sessionBytes),
          text,
          args: exactArgs,
          workspaceContext,
          attempt,
          hostId,
        });
        return;
      }
      // `.catch` surfaces an IndexedDB read failure (private browsing, quota exceeded, corrupt DB) instead of
      // failing silently.
      if (submissionInFlightRef.current) {
        // `startSubmission` already flipped this attempt's draft to `isSubmitting`, but this guard is per-composer
        // while the attempt is per-draft.
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      submissionInFlightRef.current = true;
      void resolveImageBytes(hashes)
        .then((bytesByHash) => {
          if (attempt.abortController.signal.aborted) return;
          const missing = hashes.filter((hash) => !bytesByHash.has(hash));
          if (missing.length > 0) {
            reportableErrorToast(
              "Couldn't attach an image.",
              {
                description: "Re-add the image and try sending again.",
              },
              {
                title: "Could not attach image",
                message: null,
                code: null,
                source: "Chat composer",
              },
            );
            draftRuntimeRegistry.complete(attempt);
            return;
          }
          finalizeSubmission({
            resolvedContent: inlineImageHashes(editorContent, bytesByHash),
            text,
            args: exactArgs,
            workspaceContext,
            attempt,
            hostId,
          });
        })
        .catch(() => {
          if (attempt.abortController.signal.aborted) return;
          reportableErrorToast(
            "Couldn't attach an image.",
            {
              description: "Image storage is unavailable. Please try again.",
            },
            {
              title: "Could not attach image",
              message: "Image storage was unavailable.",
              code: null,
              source: "Chat composer",
            },
          );
          draftRuntimeRegistry.complete(attempt);
        })
        .finally(() => {
          submissionInFlightRef.current = false;
        });
    },
    [finalizeSubmission],
  );

  const dispatchTerminalAgent = useCallback(
    (
      launch: TerminalAgentLaunch,
      workspaceContext: LandingWorkspaceContext,
      hostId: string,
    ) => {
      const {
        harnessId,
        model,
        reasoningEffort,
        terminalAgentArgs,
        profileId,
      } = launch;
      const epicId = uuidv4();
      const now = Date.now();
      rememberLandingWorktreeIntent(workspaceContext, epicId, now);
      // The identity this create belongs to, captured synchronously.
      const dispatchUserId = useAuthStore.getState().profile?.userId ?? null;
      // Stored untitled; the title is generated from the first terminal prompt, and render surfaces fall back via
      // `epicDisplayTitle` meanwhile.
      const epicTitle = "";

      // Local state + navigation happen synchronously before the host round-trip, mirroring `dispatchSubmission`.
      const tabId = uuidv4();
      // The create host rides along for session placement; this flow navigates before the host round-trip, so the
      // session provider mounts while only the create host can ever serve the epic.
      markEpicCreatedThisSession(epicId, hostId);
      const replaced =
        workspaceContext.draftId === null
          ? null
          : tabCommandCoordinator.replaceDraftWithEpic({
              draftId: workspaceContext.draftId,
              epicId,
              epicTabId: tabId,
              epicName: epicTitle,
            });
      if (replaced === null) {
        activateTabIntent(
          navigate,
          openExactEpicTabIntent({
            epicId,
            tabId,
            name: epicTitle,
            focus: undefined,
          }),
          undefined,
        );
      } else {
        navigateToTabIntent(
          navigate,
          existingEpicTabIntent({ epicId, tabId, focus: undefined }),
          undefined,
        );
      }

      // Terminal agents are epic-only at create time (`chat: null`); the tui-agent is created by the chained
      // `terminalAgentCreateFn` below.
      void createLandingEpic({
        epicId,
        hostId,
        title: epicTitle,
        initialUserPrompt: "",
        workspaceFolders: workspaceContext.workspaceFolders,
        workspaceFolderInfoByPath: workspaceContext.workspaceFolderInfoByPath,
        now,
        chat: null,
      })
        .then(
          () => {
            // This staged selection now belongs to a successfully-created
            // epic. Until this point a retry must see the exact same intent.
            clearConsumedLandingWorktreeIntent(workspaceContext);
            // The marker above is written before the request because the reconciler needs it that early, but the race it
            // bounds - the host's deferred cloud connect.
            if (
              (useAuthStore.getState().profile?.userId ?? null) ===
              dispatchUserId
            ) {
              markEpicCreatedThisSession(epicId, hostId);
            }
            return terminalAgentCreateFn({
              epicId,
              tabId,
              parentId: null,
              title: "",
              placement: null,
              harnessId,
              model,
              reasoningEffort,
              forkSourceHarnessSessionId: null,
              sourceTuiAgentId: null,
              sourceProfileId: null,
              onStatusChange: null,
              worktreeIntent: workspaceContext.worktreeIntent,
              workspaceMode: workspaceContext.workspaceMode,
              terminalAgentArgs,
              profileId,
            });
          },
          // The epic never landed, so drop the create marker to let the reconciler prune the orphan tab.
          () => {
            unmarkEpicCreatedThisSession(epicId);
          },
        )
        .catch(() => undefined);
    },
    [createLandingEpic, navigate, terminalAgentCreateFn],
  );

  // `placement.hostId` is then the only host id that reaches the request, the workspace-context read, the tab
  // binding and the handoff registration.
  const submit = useCallback(
    (args: LandingComposerSubmitArgs): LandingPlacementRefusal | null => {
      const placement = resolveLandingPlacement(target);
      if (placement.kind === "refused") {
        return { message: placement.message };
      }
      const workspaceContext = readLandingWorkspaceContext(
        args.draftId,
        queryClient,
        placement.hostId,
      );
      if (workspaceContext.worktreeIntentSuspended) return null;
      dispatchSubmission(args, workspaceContext, placement.hostId);
      return null;
    },
    [dispatchSubmission, queryClient, target],
  );

  const selectTerminalAgent = useCallback(
    (
      launch: TerminalAgentLaunch,
      draftId: string | null,
    ): LandingPlacementRefusal | null => {
      const placement = resolveLandingPlacement(target);
      if (placement.kind === "refused") {
        return { message: placement.message };
      }
      const workspaceContext = readLandingWorkspaceContext(
        draftId,
        queryClient,
        placement.hostId,
      );
      if (workspaceContext.worktreeIntentSuspended) return null;
      dispatchTerminalAgent(launch, workspaceContext, placement.hostId);
      return null;
    },
    [dispatchTerminalAgent, queryClient, target],
  );

  return useMemo(
    () => ({
      submit,
      selectTerminalAgent,
      isPending: createEpic.isPending || terminalAgentCreate.isPending,
    }),
    [
      createEpic.isPending,
      selectTerminalAgent,
      submit,
      terminalAgentCreate.isPending,
    ],
  );
}

function ensureSubmissionDraft(
  draftId: string | null,
  content: JsonContent,
  hostId: string,
): string {
  if (draftId !== null) return draftId;
  const createdDraftId = useLandingDraftStore.getState().createDraft(
    useComposerRunSettingsStore
      .getState()
      // The placement host is the same one whose workspace is restored below; a pinned pristine composer must not
      // seed either setting from the app-wide active host.
      .getGlobalRunSettings(hostId),
  );
  useLandingDraftStore
    .getState()
    .restoreDraftWorkspaceForHost(createdDraftId, hostId);
  useLandingDraftStore
    .getState()
    .setDraftContent(createdDraftId, content, null);
  return createdDraftId;
}

function captureSubmissionPlacement(draftId: string): DraftSubmissionPlacement {
  const tabs = useTabsStore.getState();
  const focused = selectHostFocusedRef(tabs);
  return {
    refKey: `draft:${draftId}`,
    activeItemId: tabs.activeItemId,
    focusedRefKey: focused === null ? null : `${focused.kind}:${focused.id}`,
    // Capture the exact structural projection at intent; success re-preflights rather than relying on this
    // potentially stale evidence.
    layoutRevision: JSON.stringify({
      items: tabs.items,
      active: tabs.activeItemId,
    }),
  };
}

function placeCreatedDraftEpic(input: {
  readonly draftId: string;
  readonly epicId: string;
  readonly tabId: string;
  readonly epicTitle: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly placement: DraftSubmissionPlacement;
  readonly activate: () => void;
}): void {
  const ownsIntentFocus = placementOwnedFocusedRoute(input.placement);
  const stillFocusedOwner = draftOwnsFocusedRoute(input.draftId);
  const replaced = tabCommandCoordinator.replaceDraftWithEpic({
    draftId: input.draftId,
    epicId: input.epicId,
    epicTabId: input.tabId,
    epicName: input.epicTitle,
  });
  useEpicCanvasStore
    .getState()
    .markEpicTitlePending(input.epicId, input.epicTitle);
  scheduleLandingImageReconcile();

  if (replaced === null) {
    useEpicCanvasStore
      .getState()
      .openEpicTabInBackground(input.epicId, input.epicTitle);
    toast.info("Epic created in the background.");
    return;
  }

  input.editor.clear();
  if (!ownsIntentFocus || !stillFocusedOwner) return;
  input.activate();
}

function placeCreatedEpicInBackground(epicId: string, epicTitle: string): void {
  useEpicCanvasStore.getState().markEpicTitlePending(epicId, epicTitle);
  scheduleLandingImageReconcile();
  useEpicCanvasStore.getState().openEpicTabInBackground(epicId, epicTitle);
  toast.info("Epic created in the background.");
}

function placementOwnedFocusedRoute(
  placement: DraftSubmissionPlacement,
): boolean {
  // `captureSubmissionPlacement` builds `refKey` as `draft:<draftId>`, so a placement already names its own
  // draft.
  return (
    placement.activeItemId !== null &&
    placement.focusedRefKey === placement.refKey
  );
}

function draftOwnsFocusedRoute(draftId: string): boolean {
  const tabs = useTabsStore.getState();
  if (tabs.activeItemId === null) return false;
  const activeItem = tabs.items.find((item) => item.id === tabs.activeItemId);
  const focused = selectHostFocusedRef(tabs);
  return (
    activeItem !== undefined &&
    focused?.kind === "draft" &&
    focused.id === draftId
  );
}

function discardRetiredLandingEpic(input: {
  readonly epicId: string;
  readonly chatId: string;
}): void {
  // These id-scoped leftovers were installed before the one-shot host request and must not be observed by the
  // next identity after a late reply.
  unmarkEpicCreatedThisSession(input.epicId);
  useComposerRunSettingsStore.getState().clearEpicRunSettings([input.epicId]);
  useEpicCanvasStore.getState().clearEpicTitlePending(input.epicId);
  useEpicCanvasStore.getState().clearChatTitlePending(input.chatId);
}

interface LandingWorkspaceContext {
  readonly workspaceFolders: ReadonlyArray<string>;
  readonly workspaceFolderInfoByPath: Readonly<
    Record<string, WorkspaceFolderInfo>
  >;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly worktreeIntentSuspended: boolean;
  readonly workspaceMode: WorktreeBindingWorkspaceMode;
  readonly draftId: string | null;
  // Carried rather than re-read at the write, so a host switch landing mid-dispatch cannot file this launch's
  // remembered worktree intent under the host that just became active.
  readonly hostId: string | null;
}

function readLandingWorkspaceContext(
  draftId: string | null,
  queryClient: QueryClient,
  hostId: string | null,
): LandingWorkspaceContext {
  const draftState = useLandingDraftStore.getState();
  const activeDraft =
    draftId === null
      ? null
      : (draftState.drafts.find((draft) => draft.id === draftId) ?? null);
  const exactDraftId = activeDraft?.id ?? null;
  const landingStagingKey: WorktreeStagingKey = {
    surface: "landing",
    hostId,
    draftId: exactDraftId,
  };
  const stagedWorktreeIntent = readStagedWorktreeIntent(landingStagingKey);
  const worktreeIntentSuspended =
    stagedWorktreeIntentIsSuspended(landingStagingKey);
  if (activeDraft !== null) {
    return {
      ...canonicalLaunchWorkspace(
        activeDraft.workspace,
        stagedWorktreeIntent,
        readCachedDefaultWorktreeIntent(
          queryClient,
          hostId,
          activeDraft.workspace,
        ),
      ),
      workspaceFolderInfoByPath: activeDraft.workspace.folderInfoByPath,
      worktreeIntentSuspended,
      draftId: exactDraftId,
      hostId,
    };
  }
  // The launch host's own folder bucket - the same `hostId` the cached
  // default-intent read below is keyed by.
  const globalBucket = selectWorkspaceFoldersBucket(
    useWorkspaceFoldersStore.getState(),
    hostId,
  );
  const globalWorkspace = {
    folders: globalBucket.folders,
    folderInfoByPath: globalBucket.folderInfoByPath,
    primaryPath: globalBucket.primaryPath,
  };
  return {
    ...canonicalLaunchWorkspace(
      globalWorkspace,
      stagedWorktreeIntent,
      readCachedDefaultWorktreeIntent(queryClient, hostId, globalWorkspace),
    ),
    workspaceFolderInfoByPath: globalBucket.folderInfoByPath,
    worktreeIntentSuspended,
    draftId: null,
    hostId,
  };
}

// Non-git folders are never auto-staged, so restamping alone would flip the only staged (git) entry to
// `isPrimary: false` with nothing taking its place, sending a zero-primary intent.
function canonicalLaunchWorkspace(
  workspace: LandingDraftWorkspaceSnapshot,
  stagedWorktreeIntent: WorktreeIntent | null,
  cachedDefaultWorktreeIntent: WorktreeIntent | null,
): {
  readonly workspaceFolders: ReadonlyArray<string>;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly workspaceMode: WorktreeBindingWorkspaceMode;
} {
  const worktreeIntent =
    stagedWorktreeIntent === null && cachedDefaultWorktreeIntent === null
      ? null
      : effectiveWorktreeIntent({
          workspace,
          seedIntent: cachedDefaultWorktreeIntent,
          stagedIntent: stagedWorktreeIntent,
        });
  return {
    workspaceFolders: orderFoldersPrimaryFirst(
      workspace.folders,
      workspace.primaryPath,
    ),
    worktreeIntent,
    workspaceMode: deriveWorkspaceMode(
      workspace.folders.length,
      worktreeIntent,
    ),
  };
}

function readCachedDefaultWorktreeIntent(
  queryClient: QueryClient,
  hostId: string | null,
  workspace: LandingDraftWorkspaceSnapshot,
): WorktreeIntent | null {
  const response = queryClient.getQueryData<{
    readonly workspaces: ReadonlyArray<WorktreeWorkspaceSummaryV14>;
  }>(
    hostQueryKeys.method<HostRpcRegistry, "worktree.listByWorkspacePaths">(
      hostId,
      "worktree.listByWorkspacePaths",
      {
        workspacePaths: [...workspace.folders],
        scriptRefs: [],
        forceRefresh: false,
      },
    ),
  );
  const summariesByPath = new Map(
    response?.workspaces.map((summary) => [summary.workspacePath, summary]) ??
      [],
  );
  const worktreeDefaults = workspace.folders.flatMap((workspacePath) => {
    const summary = summariesByPath.get(workspacePath);
    if (
      summary === undefined ||
      summary.resolvedAt === null ||
      !summary.isGitRepo
    ) {
      return [];
    }
    const currentBranch = branchForCachedSummary(summary);
    return currentBranch === null ? [] : [{ summary, currentBranch }];
  });
  if (worktreeDefaults.length === 0) return null;

  const defaultBranchByPath = buildDefaultBranchByPath(
    worktreeDefaults.map((entry) => entry.summary),
    worktreeDefaults.length > 1,
    useSettingsStore.getState().worktreeBranchPrefix,
  );
  const primaryPath = resolvePrimaryPath(
    workspace.folders,
    workspace.primaryPath,
  );
  return {
    entries: worktreeDefaults.map(({ summary, currentBranch }) =>
      defaultFolderIntent({
        workspacePath: summary.workspacePath,
        repoIdentifier: summary.repoIdentifier,
        isPrimary: summary.workspacePath === primaryPath,
        isGitRepo: true,
        currentBranch,
        defaultNewBranchName: (
          defaultBranchByPath[summary.workspacePath] ?? EMPTY_DEFAULT_BRANCH
        ).name,
      }),
    ),
  };
}

function branchForCachedSummary(
  summary: WorktreeWorkspaceSummaryV14,
): string | null {
  const mainEntry = summary.worktrees.find((worktree) => worktree.isMain);
  return mainEntry?.branch ?? summary.mainBranch ?? null;
}

function rememberLandingWorktreeIntent(
  workspaceContext: LandingWorkspaceContext,
  epicId: string,
  now: number,
): void {
  // Restores the exact branches next time the epic opens. Keyed by the context's dispatch-time host - the intent
  // names paths and branches that only exist on that machine.
  const { worktreeIntent } = workspaceContext;
  if (worktreeIntent === null) return;
  useWorktreeIntentMemoryStore
    .getState()
    .setEpicIntent(epicId, workspaceContext.hostId, worktreeIntent, now);
}

function clearConsumedLandingWorktreeIntent(
  workspaceContext: LandingWorkspaceContext,
): void {
  const stagingKey: WorktreeStagingKey = {
    surface: "landing",
    hostId: workspaceContext.hostId,
    draftId: workspaceContext.draftId,
  };
  // Every host's copy, and unconditionally: the landing picker rebinds the app-wide host in place, so a pick
  // staged on another host belongs to this same consumed session.
  useWorktreeIntentStagingStore.getState().clearForAllHosts(stagingKey);
}

// Distinct image hashes referenced by the (hash-only) editor content.
function imageHashesFromContent(content: JsonContent): string[] {
  return Array.from(
    new Set(
      collectImageAtoms(content).flatMap((atom) =>
        atom.hash !== null ? [atom.hash] : [],
      ),
    ),
  );
}

// Returns null if any hash is missing, signalling the caller to fall back to the async IndexedDB path; a
// complete map keeps the submit fully synchronous.
function readSessionImageBytes(
  hashes: ReadonlyArray<string>,
): Map<string, Uint8Array> | null {
  const bytesByHash = new Map<string, Uint8Array>();
  for (const hash of hashes) {
    const bytes = sessionImageBytes(hash);
    if (bytes === null) return null;
    bytesByHash.set(hash, bytes);
  }
  return bytesByHash;
}

// Async resolve via the landing fetcher (session ?? IndexedDB). Hashes with no
// bytes are simply absent from the map; the caller treats those as missing.
async function resolveImageBytes(
  hashes: ReadonlyArray<string>,
): Promise<Map<string, Uint8Array>> {
  const bytesByHash = new Map<string, Uint8Array>();
  await Promise.all(
    hashes.map(async (hash) => {
      const bytes = await getImageBytes(hash);
      if (bytes !== undefined) bytesByHash.set(hash, bytes);
    }),
  );
  return bytesByHash;
}

// Nodes without resolvable bytes are left unchanged.
function inlineImageHashes(
  node: JsonContent,
  bytesByHash: ReadonlyMap<string, Uint8Array>,
): JsonContent {
  if (node.type === "imageAttachment") {
    const hash = stringValue(node.attrs?.hash);
    if (hash === null) return node;
    const bytes = bytesByHash.get(hash);
    if (bytes === undefined) return node;
    return {
      ...node,
      attrs: { ...node.attrs, b64content: bytesToBase64(bytes), hash: null },
    };
  }
  const children = node.content;
  if (children === undefined) return node;
  return {
    ...node,
    content: children.map((child) => inlineImageHashes(child, bytesByHash)),
  };
}

function buildEpicLight(input: {
  readonly id: string;
  readonly title: string;
  readonly initialUserPrompt: string;
  readonly createdBy: string;
  readonly now: number;
}) {
  return {
    id: input.id,
    title: input.title,
    initialUserPrompt: input.initialUserPrompt,
    ticketCount: 0,
    specCount: 0,
    storyCount: 0,
    reviewCount: 0,
    status: "todo",
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.createdBy,
    version: CURRENT_EPIC_VERSION,
  };
}

function buildWorkspaceAssociations(
  workspaceFolders: ReadonlyArray<string>,
  workspaceFolderInfoByPath: Readonly<
    Record<string, { readonly repoIdentifier: TaskRepoIdentifier | null }>
  >,
): CreateEpicWorkspaceIdentifier[] {
  return workspaceFolders.flatMap((workspacePath) =>
    Object.hasOwn(workspaceFolderInfoByPath, workspacePath)
      ? [{ workspacePath }]
      : [],
  );
}

// Minimal binding rows from the picked folders for the optimistic chip.
function buildOptimisticWorkspaceBindingRows(
  workspaceFolders: ReadonlyArray<string>,
  workspaceFolderInfoByPath: Readonly<
    Record<string, { readonly repoIdentifier: TaskRepoIdentifier | null }>
  >,
  hostId: string | null,
): WorktreeBindingSelectorRowV12[] {
  if (hostId === null) return [];
  let addedRowCount = 0;
  return workspaceFolders.flatMap((workspacePath) => {
    if (!Object.hasOwn(workspaceFolderInfoByPath, workspacePath)) {
      return [];
    }
    const repoIdentifier =
      workspaceFolderInfoByPath[workspacePath].repoIdentifier;
    const isPrimary = addedRowCount === 0;
    addedRowCount += 1;
    return [
      {
        hostId,
        runningDir: workspacePath,
        workspacePath,
        worktreePath: null,
        mode: "local",
        isGitRepo: repoIdentifier !== null,
        repoIdentifier,
        branch: null,
        isPrimary,
        isImported: false,
        setupState: "not_required",
        disabledReason: null,
        sources: [],
        // The seed's git facts are a client-side guess (cloud association ≠ a git probe).
        isGitResolvePending: repoIdentifier === null,
      },
    ];
  });
}

function buildRepoIdentifiers(
  workspaceFolders: ReadonlyArray<string>,
  workspaceFolderInfoByPath: Readonly<
    Record<string, { readonly repoIdentifier: TaskRepoIdentifier | null }>
  >,
): TaskRepoIdentifier[] {
  return Array.from(
    new Map(
      workspaceFolders.flatMap((folderPath) => {
        if (!Object.hasOwn(workspaceFolderInfoByPath, folderPath)) return [];
        const repoIdentifier =
          workspaceFolderInfoByPath[folderPath].repoIdentifier;
        return repoIdentifier === null
          ? []
          : [
              [
                `${repoIdentifier.owner}/${repoIdentifier.repo}`,
                repoIdentifier,
              ] as const,
            ];
      }),
    ).values(),
  );
}
