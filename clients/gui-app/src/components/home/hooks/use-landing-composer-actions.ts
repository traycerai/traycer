import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import type {
  CreateEpicChatSeedV12,
  CreateEpicResponseV12,
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
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import { CURRENT_EPIC_VERSION } from "@traycer-clients/shared/epic/epic-version";

import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
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
  type DraftSubmissionSettlement,
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
  type SlashCommandCatalog,
} from "@/lib/composer/tiptap-json-content";
import { normalizeComposerContentWithSelection } from "@/lib/composer/composer-content-normalizer";
// The inline step is shared with the in-epic send, the edit-and-resend, the
// new-conversation create and the handoff resend - every surface that has to
// hand the host base64 - so "what the host receives" has one implementation.
import {
  containsImageAtoms,
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";
import { sessionImageBytes } from "@/lib/composer/landing-image-store";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import {
  resolveDraftImageBytes,
  type DraftImageByteTarget,
} from "@/lib/drafts/resolve-draft-image-bytes";
import { bytesToBase64 } from "@/lib/composer/image-base64";
// The by-hash half of the same question: which of those nodes need NOT be
// inlined, because the host will resolve them from this account's blob tier.
import {
  confirmAttachmentsByHash,
  createAttachmentsByHashSupported,
  exceedsCreateAttachmentHashCap,
  planAttachmentsByHash,
  reportCreateAttachmentHashCapExceeded,
  type AttachmentsByHashPlan,
} from "@/lib/composer/attachments-by-hash";
import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import {
  createOutcomeIsDecidable,
  pollEpicExistence,
} from "@/lib/epics/epic-existence-poll";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import {
  orderFoldersPrimaryFirst,
  resolvePrimaryPath,
} from "@/lib/worktree/resolve-primary-path";
import {
  armEpicCreateSeedHoldTimer,
  clearEpicCreateSeedPending,
  clearUnheldEpicCreateSeed,
  markEpicCreateSeedPending,
} from "@/lib/worktree/pending-epic-create-seeds";
import { shouldDeferWorktreeProvisioning } from "@/lib/worktree/defer-worktree-provisioning";
import { effectiveWorktreeIntent } from "@/lib/worktree/effective-worktree-intent";
import { getNegotiatedHostMethodVersion } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  refuseCreateWithoutCloudVerdict,
  resolveLandingPlacement,
  type LandingPlacement,
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
  /**
   * The composer's loaded command catalog, or null when it has not loaded.
   * Submit-time chip conversion resolves a written `/command` / `$skill`
   * against it - see `buildSubmittedChatJSONContent`. Read at submit time by
   * the caller, which owns the picker store.
   */
  readonly slashCatalog: SlashCommandCatalog | null;
  readonly toolbar: {
    readonly selection: HarnessModelSelection;
    readonly reasoning: ReasoningLevel;
    readonly serviceTier: ServiceTier;
    readonly permission: PermissionMode;
    readonly identityId: string | null;
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

/**
 * Both actions return the submit-time placement refusal (selection model §54)
 * instead of dispatching, or `null` when the create was dispatched. The caller
 * renders the message inline on the composer - never a toast-and-proceed, and
 * never a silent fallback onto another host.
 */
export interface LandingComposerActions {
  readonly submit: (
    args: LandingComposerSubmitArgs,
  ) => LandingPlacementRefusal | null;
  readonly selectTerminalAgent: (
    launch: TerminalAgentLaunch,
    draftId: string | null,
  ) => LandingPlacementRefusal | null;
  /**
   * Whether a create started here is still running.
   *
   * Exposed rather than left to the composer to observe, because the composer
   * CANNOT observe it: TanStack v5 mutation state is per-OBSERVER, so the
   * `useEpicCreateForClient` / `useCreateTuiAgentForClient` pair the composer
   * used to build for itself tracked a second, never-mutated observer and its
   * `isPending` was permanently false. A shared `mutationKey` would not have
   * fixed it either (keys do not sync observers; only `useIsMutating` reads
   * across them, and that is a GLOBAL count that would also light up for a
   * create fired from the new-conversation modal on the same key - trading an
   * inert read for a false-positive one).
   *
   * The observers that actually run live here, so the honest answer does too.
   */
  readonly isPending: boolean;
}

export interface LandingPlacementRefusal {
  readonly message: string;
}

interface FinalizeLandingSubmissionInput {
  /** What the HOST receives: image hashes inlined back to base64. */
  readonly resolvedContent: JsonContent;
  /**
   * The same document with its image nodes still HASH-ONLY — what the handoff
   * entry records.
   *
   * The two differ on purpose. The handoff is persisted to `localStorage` and
   * is a GC root for the bytes it names, so it must hold the hash, not a
   * megabyte of base64: storing the inlined copy is what put the image in
   * `traycer-gui-app:initial-chat-handoffs` in the first place, and the persist
   * `partialize` that now strips base64 would drop it on the next write. The
   * resend inlines from the composer image store at the moment it sends.
   */
  readonly hashOnlyContent: JsonContent;
  /**
   * Whether `resolvedContent` still carries hash-only image nodes the host must
   * resolve from this account's draft blob tier - `epic.create@1.2`'s
   * `attachmentsByHash`.
   *
   * PER MESSAGE, not per node: it says "resolve the hash-only nodes in here",
   * and inline nodes beside them stay inline. A mixed document (some images
   * confirmed on the host, some inlined because they could not be) is the
   * ordinary output of the submit gate, not an edge case.
   */
  readonly attachmentsByHash: boolean;
  readonly text: string;
  readonly args: LandingComposerSubmitArgs;
  readonly workspaceContext: LandingWorkspaceContext;
  readonly attempt: DraftSubmissionAttempt;
  /**
   * The placement host, re-validated at submit by `resolveLandingPlacement`
   * and carried down verbatim. Never re-read off a client here: a second read
   * could answer with a host the user was never shown.
   */
  readonly hostId: string;
}

/**
 * Composes host mutations + store writes + navigation behind two stable
 * callbacks. Identities change only when the underlying mutation handles,
 * `navigate`, or the composer's PLACEMENT target change - the first two are
 * stable for the lifetime of a route, and the third moves only when the user
 * pins a different host (or the effective host moves under a following
 * composer), which is exactly when these callbacks must stop addressing the
 * old machine.
 *
 * `target` is the composer's resolved placement (selection model §54), and it
 * is the ONLY host any create below touches: the epic create, its folded chat
 * seed, and the terminal-agent chain all run on `target.client`, whose host
 * identity is re-validated at the top of each action. There is deliberately no
 * `useHostClient()` here - resolving the app-wide client would let the chip
 * name one machine while the create landed on another.
 */
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
  // The one client every request this hook makes goes out on - the placement's
  // own, never an app-wide read. Named here so the by-hash upload and the
  // existence poll cannot reach for a different one than the create does.
  const submitClient = target.client;

  // Guards the async (session-cold image) submit path against re-entry: on that
  // path `createEpic.isPending` — and thus the composer's `canSubmit` — only flips
  // inside the deferred `finalizeSubmission`, so without this a second submit
  // during the IndexedDB read would create a second epic.
  const submissionInFlightRef = useRef(false);
  // STATE, not a ref, because the composer has to see it: the by-hash submit
  // path spends its time in `drafts.putBlob`, before `createEpic.isPending`
  // flips, and a Send button that stays live through a multi-megabyte upload is
  // a second epic waiting to happen. The ref above guards re-entry; this is the
  // same window reported to the UI.
  const [attachmentUploadPending, setAttachmentUploadPending] = useState(false);

  // Single create path shared by the GUI-chat and terminal-agent flows so the
  // epic.create request (epic light + repos + workspaces + folded chat) - and
  // therefore the optimistic history insert in `useEpicCreate.onSuccess` - is
  // built identically and cannot drift between the two entry points.
  // Resolves with the LATEST `epic.create` line's response (`@1.2`), because
  // that is what the mutation hands back: its `refusal` is the `@1.2` instance,
  // whose kind enum carries a member the released one does not. Annotating the
  // frozen type would narrow nothing here - it would simply stop describing the
  // value this returns.
  const createLandingEpic = useCallback(
    (input: {
      readonly epicId: string;
      /** The validated placement host - never re-read off a client here. */
      readonly hostId: string;
      readonly title: string;
      readonly initialUserPrompt: string;
      readonly chat: CreateEpicChatSeedV12 | null;
      readonly workspaceFolders: ReadonlyArray<string>;
      readonly workspaceFolderInfoByPath: Readonly<
        Record<string, WorkspaceFolderInfo>
      >;
      readonly now: number;
      /**
       * Handed the closure that re-establishes everything this create seeded,
       * for the ONE caller that can learn a rejected create actually landed.
       *
       * The teardown in `.catch` below is right for every rejection that means
       * what it says, and it runs before any caller sees the error - so a
       * caller that then polls and finds the epic has already lost the seed,
       * the pair entry and, with it, the release invalidation and the backstop
       * that would have landed the real binding row. It cannot rebuild them:
       * the optimistic rows, the seeded query key and the `release` closure are
       * all locals of this callback.
       *
       * Passed OUT rather than deferring the teardown, deliberately: a
       * recovery nobody invokes leaves today's behaviour exactly as it is,
       * while a deferred teardown nobody completes leaks a hold that suppresses
       * this epic's binding refetches until the window is reloaded.
       */
      readonly captureSeedRecovery: (recover: () => void) => void;
    }): Promise<CreateEpicResponseV12> => {
      const profile = useAuthStore.getState().profile;
      const hostId = input.hostId;
      const optimisticRows = buildOptimisticWorkspaceBindingRows(
        input.workspaceFolders,
        input.workspaceFolderInfoByPath,
        hostId,
      );
      // The seed is keyed by the composer's PLACEMENT host - the same host the
      // new epic's chat / terminal tabs bind to, so the tab-scoped readers
      // (e.g. chat-tile's availability query, which resolves via the tab host)
      // read this seed. Keep the create-time tab binding and the placement
      // host in lockstep, or seed under the host the initial tabs bind to
      // instead. (Before P1.2 this was the app-wide active host, which the
      // picker rebound; it is now the surface pin's resolved host.)
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
      // Seed the binding-list query cache with the folders the user just picked
      // BEFORE the create resolves, so the in-epic chip and the command-palette
      // Files/Diff openers show them immediately instead of flashing empty
      // during the in-flight create.
      seedBindings();
      const seedChatId = input.chat?.chatId ?? null;
      // EVERY landing create registers an entry now, not only one that wrote
      // rows. Two independent facts ride it and they are not the same question:
      // `seedRows` is the `worktree.changed` burst guard's (does an optimistic
      // seed need protecting?), while `heldForDeferredCreate` is the
      // create-path refetch hold's (will the host have no binding row to answer
      // with until a post-response `git worktree add` lands?). A deferred
      // create whose picked folder produced no rows is the pair that needs
      // both answers to differ.
      //
      // While the create is in flight the seed is authoritative: a
      // `worktree.changed` burst refetch could return pre-binding
      // `{ rows: [] }` and clobber it, so the burst invalidation only MARKS
      // this epic's binding queries until the create settles - and, on the
      // deferred path, until the chat's own provisioning outcome.
      // Built once and used twice - at submit, and by the recovery below. The
      // two must be the SAME entry: a recovery that re-registered with, say,
      // `heldForDeferredCreate: false` would hand a deferred create's epic to
      // the first refetch that asked, which is the whole condition the hold
      // exists to prevent.
      const seedEntry = {
        hostId,
        seededMessageId: input.chat?.initialMessage?.messageId ?? null,
        seedRows: seededBindingsKey !== null,
        heldForDeferredCreate: input.chat?.deferWorktreeProvisioning === true,
        // The release IS an invalidate and nothing else: scoped to this epic's
        // own key (not the host-wide method scope the success path uses) and at
        // the default `refetchType: "active"`, so a mounted chip refetches now
        // and an unmounted one is marked - which is what lands the worktree row
        // on the next mount of a tile the user closed mid-window.
        release: () => {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.method<
              HostRpcRegistry,
              "worktree.listBindingsForEpic"
            >(hostId, "worktree.listBindingsForEpic", {
              epicId: input.epicId,
            }),
          });
        },
      };
      markEpicCreateSeedPending(input.epicId, seedChatId, seedEntry);
      input.captureSeedRecovery(() => {
        // The seeded rows first, so a chip that mounts between these two lines
        // reads folders rather than the empty listing the teardown left.
        seedBindings();
        markEpicCreateSeedPending(input.epicId, seedChatId, seedEntry);
        // ARMED HERE, and this is the part a plain re-registration would miss.
        // The backstop is normally armed by `useEpicCreateForClient.onSuccess`
        // - which never ran, because the response is exactly what was lost. An
        // entry with no timer and no response to release it would hold this
        // epic's binding listing until something unrelated refetched it, which
        // is a worse outcome than the teardown this is undoing.
        armEpicCreateSeedHoldTimer(input.epicId, seedChatId);
      });
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
          // A REFUSAL resolves, so it arrives HERE and not in the `.catch`
          // below - and the two arms want opposite things. Rolling back is
          // what a refusal needs: the seed exists to cover the in-flight
          // window for an epic that is about to exist, and after a refusal no
          // epic ever will, so re-asserting it would leave the chip and the
          // palette's Files/Diff openers listing folders for an epic id the
          // host never created. Same teardown as the rejection arm, minus the
          // rethrow: the call sites' own refusal branches settle the attempt,
          // and turning this into a rejection would route a refused create
          // into `onError`'s generic "Couldn't create epic." toast, discarding
          // the host's message and the repair the typed arm exists to offer.
          if (response.refusal !== undefined) {
            // UNCONDITIONAL, and it has to be: `onSuccess` returned at the
            // refusal before any hold or timer, and `onError` never touches the
            // marker, so nothing else would ever remove this entry.
            clearEpicCreateSeedPending(input.epicId, seedChatId);
            if (seededBindingsKey !== null) {
              queryClient.removeQueries({ queryKey: seededBindingsKey });
            }
            return response;
          }
          // Re-assert the seed after success to overwrite a racing first fetch
          // that returned `[]` before the host's warm-slot create seed landed
          // (no flicker). `useEpicCreateForClient`'s invalidation then
          // reconciles to the host's truth, including later removals, so the
          // chip can't get stuck showing removed folders.
          seedBindings();
          // UNHELD ONLY. A held entry has to survive its own response: the hold
          // was established at submit and `onSuccess` armed its timer before
          // this arm runs, so an unconditional delete here would leave nothing
          // that ever invalidates the epic's key - the chip would sit on the
          // seeded folders with no worktree row to follow. The tile driver (or
          // that timer) releases it.
          clearUnheldEpicCreateSeed(input.epicId, seedChatId);
          return response;
        })
        .catch((error: unknown) => {
          // Unconditional, like the refusal arm. A lifecycle throw inside
          // `onSuccess` AFTER the timer arm also rejects `mutateAsync` into
          // here, so this delete is what cancels that orphaned timer; for a
          // seeded entry the `removeQueries` below then makes the lost hold a
          // cold refetch of host truth rather than a stuck chip.
          clearEpicCreateSeedPending(input.epicId, seedChatId);
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

  // Everything from building `submittedContent` through the optimistic
  // local-state writes + navigation + host create. Pulled into its own callback
  // so the dispatcher below can feed it either the synchronously re-inlined
  // content (cached images, no await) or the IndexedDB-resolved content
  // (restored draft) while the sync local-state/nav block stays byte-identical
  // across both paths.
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
      // The same document the host gets, but hash-only — for the handoff entry,
      // which is persisted and roots those bytes against GC. Built through the
      // SAME normalizer so the two can only differ in the image payload, never
      // in the slash-command chip or any other structural rewrite.
      const handoffContent = buildSubmittedChatJSONContent(
        input.hashOnlyContent,
        args.slashCatalog,
      );
      const profile = useAuthStore.getState().profile;

      const settings = buildChatRunSettings({
        selection: toolbar.selection,
        permission: toolbar.permission,
        reasoning: toolbar.reasoning,
        serviceTier: toolbar.serviceTier,
        identityId: toolbar.identityId,
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
      // The folded chat is bound to a device for life. `activeHostId` is the
      // composer's re-validated placement host (see the input's `hostId`), so
      // there is no "no active device" arm left here - a missing/unusable
      // placement was already refused inline before this ran.
      // The workspace context and the target host arrive as two SEPARATE
      // fields of this input, and on the session-cold image path an IndexedDB
      // await separates their capture from this run. Nothing structural forces
      // a future caller to derive both from one placement, so fail closed if
      // they name different machines: creating on B with A's paths binds the
      // epic to a machine the user never composed against. The draft, staged
      // intent and placement survive, so a resubmit lands cleanly. A context
      // with no host of its own captured nothing host-specific.
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
              // The machine this composer runs on, NOT `activeHostId` (where
              // the chat is created): read at submit exactly as a send frame
              // reads it, so the first turn's browser is placed by the same
              // fact as every later one.
              sentFromHostId: readLocalHostIdSnapshot(),
              // Spread rather than a `false` literal, like the sibling opt-in
              // below: absent and `false` read identically on the host, and a
              // request that names the key only when it is asking for something
              // keeps the wire honest about which creates carry hashes.
              ...(input.attachmentsByHash
                ? { attachmentsByHash: true as const }
                : {}),
            }
          : null;

      // The host request remains a one-shot mutation. Local handoff state is
      // prepared before it, but the draft/layout is deliberately untouched
      // until this exact runtime's create reports success. Last-run memory is
      // keyed by the host the chat is created on (`activeHostId`, resolved
      // and null-guarded above).
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
        content: handoffContent,
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
        // Anchor the chat-title spinner on the empty store (mirrors the epic
        // spinner above and `dispatchTerminalAgent`): the chat is created with
        // an empty title, so the expected pre-generation value is `""`. The
        // spinner shows while the projected title is still empty and clears once
        // a non-empty AI title is projected (or the 30s backstop fires).
        useEpicCanvasStore.getState().markChatTitlePending(chatId, "");
      }

      if (!runtime.markCreateStarted(attempt)) {
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      // Mark before the one-shot create request so the existence reconciler
      // cannot prune the result while `epic.listTasks` still lags it. The
      // create host rides along so the epic session opens against the machine
      // that holds the local-first warm slot - any other host cold-opens into
      // a cloud NOT_FOUND until the create host's background connect lands.
      markEpicCreatedThisSession(epicId, activeHostId);

      // Where the epic's tab goes once the create is known to have landed.
      //
      // TWO ARMS REACH IT and they must place identically: the response, and -
      // now that the create is keyed - an existence poll that finds the epic
      // after the response was lost. Written as one closure rather than
      // duplicated so the second arm cannot drift into a different placement,
      // which is the kind of divergence nothing would notice until someone
      // lost a tab.
      const placeLandedEpic = (settlement: DraftSubmissionSettlement): void => {
        if (settlement.kind === "current") {
          placeCreatedDraftEpic({
            draftId: attempt.draftId,
            epicId,
            tabId,
            epicTitle,
            editor,
            placement: attempt.placement,
            activate: () => {
              // The create continuation can settle after the user opens
              // Settings / History. Keep the normal underlying transition
              // from draft to Epic, but carry that foreground overlay onto
              // the Epic route so async completion cannot dismiss it.
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
          return;
        }
        // Content changed after send: keep that later edit. A close during
        // create used to be the same branch because close destroyed the row;
        // now close retains, so `"closed"` must still delete (decision #13) or
        // the sent text stays as a draft alongside the new epic.
        placeCreatedEpicInBackground(epicId, epicTitle);
        if (settlement.kind === "closed") {
          useLandingDraftStore.getState().deleteDraft(attempt.draftId);
        }
      };

      // The opt-in, on the four facts this surface has in hand. It travels with
      // the UI for the state it produces (the queued row, the setup card and
      // its Retry), which all ship in the same change - so no client ever asks
      // for a worktree created after the response without being able to show
      // the user what is happening to it.
      const deferWorktreeProvisioning = shouldDeferWorktreeProvisioning({
        hostId: activeHostId,
        method: "epic.create",
        hasInitialMessage: initialMessage !== null,
        workspaceMode: workspaceContext.workspaceMode,
        worktreeIntent: workspaceContext.worktreeIntent,
      });

      // Filled synchronously by `createLandingEpic` before it dispatches, and
      // read only on the one branch that learns a rejected create landed after
      // all. A holder rather than a bare `let` so no flow analysis has to
      // reason about an assignment that happens inside a callback.
      const seedRecovery: { run: (() => void) | null } = { run: null };
      void createLandingEpic({
        epicId,
        hostId: activeHostId,
        title: epicTitle,
        initialUserPrompt: text,
        workspaceFolders: workspaceContext.workspaceFolders,
        workspaceFolderInfoByPath: workspaceContext.workspaceFolderInfoByPath,
        now,
        captureSeedRecovery: (recover) => {
          seedRecovery.run = recover;
        },
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
          // Spread rather than a `false` literal: absent and `false` mean the
          // same thing to the host, but a plain local-folder create on a `@1.2`
          // host is supposed to ship NO field, and a request that names the key
          // only when it is asking for something keeps the wire honest about
          // which creates opted in.
          ...(deferWorktreeProvisioning
            ? { deferWorktreeProvisioning: true }
            : {}),
        },
      })
        .then((response) => {
          const settlement = draftRuntimeRegistry.settlement(attempt);
          if (settlement.kind === "retired") {
            discardRetiredLandingEpic({ epicId, chatId });
            draftRuntimeRegistry.complete(attempt);
            return;
          }
          // A REFUSAL resolves this promise rather than rejecting it -
          // `epic.create@1.1` carries it as an optional key on the ordinary
          // response - so every line below has to be skipped explicitly. None
          // of it is harmless on a create that did not happen: it would open a
          // tab and navigate into an epic the host never made, then leave the
          // user on a route whose `epic.subscribe` fails with a second,
          // unrelated-looking error. The host also rejects the pending-create
          // gates on refusal, so those racing opens WILL fail; that is correct
          // and must not be narrated twice.
          //
          // Settled exactly like the rejection arm below, which is the same
          // fact from the other side: local state was staged for an epic that
          // will not exist, and that includes the handoff registered above -
          // left `pending` it would outlive the epic it names. The draft and
          // the staged worktree intent survive on purpose, so a repaired store
          // makes resubmitting work. `useEpicCreateForClient.onSuccess` owns
          // the user-facing message.
          if (response.refusal !== undefined) {
            settleUnlandedLandingEpic({
              epicId,
              chatId,
              hostId: activeHostId,
              userId,
            });
            draftRuntimeRegistry.complete(attempt);
            return;
          }
          // The server accepted the exact staged worktree intent. Failed
          // preparation and rejected create paths leave it intact for retry.
          useFirstTaskGuideStore.getState().dismiss();
          clearConsumedLandingWorktreeIntent(workspaceContext);
          // Re-anchor the create-race window on COMPLETION - see the terminal
          // flow's copy for why. This flow needs it most: the tab is opened
          // below, INSIDE this handler, so a create slower than the window
          // would hand the session an already-expired seed and open it on the
          // effective host - the exact race this marker exists to prevent.
          markEpicCreatedThisSession(epicId, activeHostId);
          // The host already kicked the provider turn from `initialMessage`;
          // jump the handoff straight to `sending` so the driver does not
          // re-send. (Re-sends are harmless - the host dedupes on
          // `messageId` - but skipping the round-trip is cheaper.)
          if (response.initialTurnStarted === true) {
            useInitialChatHandoffStore
              .getState()
              .markInitialTurnStarted(
                { hostId: activeHostId, userId, epicId },
                chatId,
              );
          }
          placeLandedEpic(settlement);
          draftRuntimeRegistry.complete(attempt);
        })
        .catch((error: unknown) => {
          // A retired attempt takes the same exit as the success path above:
          // the id-scoped leftovers still have to go, but `markFailed` must
          // not - it would re-insert a handoff entry keyed to an identity the
          // bridge already tore down, and the next identity would surface a
          // failure banner for a submission it never made.
          if (draftRuntimeRegistry.settlement(attempt).kind === "retired") {
            discardRetiredLandingEpic({ epicId, chatId });
            draftRuntimeRegistry.complete(attempt);
            return;
          }
          // ONE class of rejection no longer means "the epic never landed".
          // This create carries `idempotencyKey = epicId`, so an ambiguous
          // post-send drop (or a `keyReuseConflict`) leaves an epic the host
          // can be asked about by name - and tearing local state down for an
          // epic that DOES exist is the expensive mistake here: the handoff
          // moves to `failed`, the create marker is dropped, and the user is
          // told a task they now own was not created. Every other rejection is
          // its own answer and settles immediately, as before.
          if (
            !(error instanceof HostRpcError) ||
            !createOutcomeIsDecidable(error)
          ) {
            settleUnlandedLandingEpic({
              epicId,
              chatId,
              hostId: activeHostId,
              userId,
            });
            draftRuntimeRegistry.complete(attempt);
            return;
          }
          // Deduped with the mutation's own poll for this pair, so the notice
          // and this teardown are decided on ONE set of readings.
          void pollEpicExistence({
            client: submitClient,
            hostId: activeHostId,
            epicId,
          }).then(
            (verdict) => {
              if (verdict !== "exists") {
                settleUnlandedLandingEpic({
                  epicId,
                  chatId,
                  hostId: activeHostId,
                  userId,
                });
                draftRuntimeRegistry.complete(attempt);
                return;
              }
              // The create landed; only its answer was lost. This is the
              // success arm above minus the two things a lost response cannot
              // supply: the refusal check (a refusal is a RESOLVED body, so it
              // cannot arrive here) and `initialTurnStarted`. Leaving the
              // handoff `pending` is right rather than lossy - the driver
              // re-sends the seeded message, and the host dedupes it on
              // `messageId`, which is exactly the fallback path a `false`
              // answer would have taken.
              const settled = draftRuntimeRegistry.settlement(attempt);
              if (settled.kind === "retired") {
                discardRetiredLandingEpic({ epicId, chatId });
                draftRuntimeRegistry.complete(attempt);
                return;
              }
              clearConsumedLandingWorktreeIntent(workspaceContext);
              // Re-anchored HERE rather than left at its submit-time stamp: the
              // poll can run for a minute, and the marker's window is what
              // keeps the opening session on the create host.
              markEpicCreatedThisSession(epicId, activeHostId);
              // And so is the binding seed, which `createLandingEpic`'s own
              // `.catch` tore down before this poll ever started - correctly,
              // for every rejection that means what it says. This one does not:
              // the epic exists, the host may still be provisioning its
              // worktree, and without the entry the tile's hold driver finds
              // nothing to release and the listing this create seeded stays
              // empty until an unrelated refetch. Restored BEFORE the tab is
              // placed, so the tile mounts onto the seeded rows rather than
              // onto the hole.
              seedRecovery.run?.();
              placeLandedEpic(settled);
              draftRuntimeRegistry.complete(attempt);
            },
            () => {
              settleUnlandedLandingEpic({
                epicId,
                chatId,
                hostId: activeHostId,
                userId,
              });
              draftRuntimeRegistry.complete(attempt);
            },
          );
        });
    },
    [createLandingEpic, navigate, submitClient],
  );

  /**
   * The by-hash submit: confirm the bytes are on the placement host, inline
   * only what could not be confirmed, and send the rest as hashes.
   *
   * ALWAYS ASYNC, unlike the two inline paths beside it, because "is it on the
   * host" is not a question this window can answer synchronously. That costs
   * the landing composer its one-stack-frame submit for a message with images,
   * which is why the re-entry guard and the pending flag both cover it.
   *
   * REFUSES rather than dropping an image, which is the landing composer's own
   * rule and not a general one: a hash here names bytes that were pasted into
   * THIS window and exist nowhere else (no epic exists yet to hold them), so a
   * hash it can neither confirm nor inline is an image that would silently
   * vanish from the message. The chat and edit composers inline best-effort for
   * the opposite reason - their hashes routinely address the host's epic store.
   */
  /**
   * The authoritative cap check, on the hashes the create will actually carry.
   *
   * The pre-upload check below sees only the plan's ELIGIBLE set, which is not
   * what the host counts: `collectAttachmentHashes` counts every node still
   * holding a hash, whatever this client thought of its eligibility. On this
   * surface the two nearly always agree - an unresolvable hash is refused
   * outright a few lines down rather than shipped - so this is a backstop
   * rather than the live arm it is in the modal. It is here anyway because the
   * rule belongs to the wire, not to one surface's inlining policy, and a
   * backstop that costs one array walk is cheaper than the two surfaces
   * drifting apart.
   *
   * Returns whether it refused, having already narrated and settled the
   * attempt.
   */
  const refusedOverWireHashCap = useCallback(
    (content: JsonContent, attempt: DraftSubmissionAttempt): boolean => {
      if (!exceedsCreateAttachmentHashCap(hashOnlyImageHashes(content))) {
        return false;
      }
      reportCreateAttachmentHashCapExceeded();
      draftRuntimeRegistry.complete(attempt);
      return true;
    },
    [],
  );
  const dispatchByHashSubmission = useCallback(
    (input: {
      readonly args: LandingComposerSubmitArgs;
      readonly attempt: DraftSubmissionAttempt;
      readonly client: HostClient<HostRpcRegistry>;
      readonly editorContent: JsonContent;
      readonly hostId: string;
      readonly plan: AttachmentsByHashPlan;
      readonly text: string;
      readonly workspaceContext: LandingWorkspaceContext;
    }) => {
      const { attempt, editorContent, hostId, plan } = input;
      // BEFORE the upload, on the eligible set: an eligible set already over
      // the cap can never come back under it, so this keeps an oversized
      // request off the wire without paying for the uploads first. The
      // authoritative count is the post-inlining one below, on the hashes the
      // request actually carries.
      if (exceedsCreateAttachmentHashCap(plan.eligible)) {
        reportCreateAttachmentHashCapExceeded();
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      if (submissionInFlightRef.current) {
        // Same reason as the async inline path's guard: the attempt is
        // per-draft while this flag is per-composer, so a re-entrant submit
        // that resolved to a DIFFERENT draft has a live attempt that nothing
        // else would settle.
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      submissionInFlightRef.current = true;
      setAttachmentUploadPending(true);
      void confirmAttachmentsByHash({
        hostId,
        client: input.client,
        plan,
        // Read here, not inside the leaf: a confirmation is recorded against
        // the account that uploaded, and a `null` owner (no signed-in account
        // in this window) confirms nothing, which inlines everything.
        ownerUserId: currentDraftBlobOwnerId(),
      })
        .then(async (confirmed) => {
          if (attemptAborted(attempt)) return;
          if (confirmed.inline.length === 0) {
            if (refusedOverWireHashCap(editorContent, attempt)) return;
            finalizeSubmission({
              resolvedContent: editorContent,
              hashOnlyContent: editorContent,
              attachmentsByHash: true,
              text: input.text,
              args: input.args,
              workspaceContext: input.workspaceContext,
              attempt,
              hostId,
            });
            return;
          }
          const bytesByHash = await resolveBase64ByHash(
            confirmed.inline,
            draftImageByteTargetForHost(hostId),
          );
          if (attemptAborted(attempt)) return;
          const missing = confirmed.inline.filter(
            (hash) => !bytesByHash.has(hash),
          );
          if (missing.length > 0) {
            reportableErrorToast(
              "Couldn't attach an image.",
              { description: "Re-add the image and try sending again." },
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
          // Only the unconfirmed hashes are in the map, so every confirmed
          // node keeps its hash and every other one comes back as base64 -
          // the mixed document `attachmentsByHash` is defined for. Counted
          // AFTER that rewrite, because that is the document the host counts.
          const resolvedContent = inlineHashOnlyImageBytes(
            editorContent,
            bytesByHash,
          );
          if (refusedOverWireHashCap(resolvedContent, attempt)) return;
          finalizeSubmission({
            resolvedContent,
            hashOnlyContent: editorContent,
            // `false` when the upload confirmed nothing at all: the document
            // then carries no hash for the host to resolve, and claiming
            // otherwise would ask it to run a resolution pass over nothing.
            attachmentsByHash: confirmed.byHash.size > 0,
            text: input.text,
            args: input.args,
            workspaceContext: input.workspaceContext,
            attempt,
            hostId,
          });
        })
        .catch(() => {
          if (attemptAborted(attempt)) return;
          reportableErrorToast(
            "Couldn't attach an image.",
            { description: "Image storage is unavailable. Please try again." },
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
          setAttachmentUploadPending(false);
        });
    },
    [finalizeSubmission, refusedOverWireHashCap],
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
      // The runtime's stored content already reflects the latest edit (every
      // keystroke flows through `onDocumentChange` synchronously, well before
      // a later submit click) or was just seeded verbatim by
      // `ensureSubmissionDraft` - so only a genuine legacy-shape rewrite here
      // is a real document mutation worth recording. `normalized.changed` is
      // a cheap structural flag, not a document comparison, so this never
      // walks/serializes the (possibly multi-megabyte inline-image) content.
      if (normalized.changed) {
        runtime.setSnapshot(editorContent, runtime.store.getState().selection);
      }
      const attempt = runtime.startSubmission(
        captureSubmissionPlacement(draftId),
      );
      if (attempt === null) return;
      const exactArgs = { ...args, draftId };

      // The live editor content is hash-only (landing pastes hashes, never
      // base64). Re-inline each image hash back to base64 so the host ingests it
      // exactly like a fresh paste. Fast path: every hash is in the session cache
      // (the common "you just typed it" case) → resolve synchronously and keep
      // the optimistic local-state + navigation block synchronous. Slow path: a
      // restored (session-cold) draft → await IndexedDB BEFORE that block; a hash
      // with no bytes (manual wipe) blocks the send with a toast.
      const hashes = hashOnlyImageHashes(editorContent);
      if (hashes.length === 0) {
        finalizeSubmission({
          resolvedContent: editorContent,
          hashOnlyContent: editorContent,
          attachmentsByHash: false,
          text,
          args: exactArgs,
          workspaceContext,
          attempt,
          hostId,
        });
        return;
      }
      // …unless the host takes the hashes THEMSELVES, which is the whole point
      // of `epic.create@1.2`: the bytes crossed the relay once at paste, and a
      // create that re-inlines them sends the same megabytes a second time
      // inside a unary request that then has to be parsed on the host loop.
      //
      // Four conditions, and each failure lands on the inline path below - the
      // one that has always worked:
      //  - a client to upload on;
      //  - no node carrying BOTH base64 and a hash (see `hasInlineHashedNode`);
      //  - at least one node the preparer marked by-hash eligible, so there is
      //    something to gain;
      //  - the negotiated minor, read at dispatch and failing closed.
      const plan = planAttachmentsByHash(editorContent);
      if (
        submitClient !== null &&
        !plan.hasInlineHashedNode &&
        plan.eligible.length > 0 &&
        createAttachmentsByHashSupported(hostId, "epic.create")
      ) {
        dispatchByHashSubmission({
          args: exactArgs,
          attempt,
          client: submitClient,
          editorContent,
          hostId,
          plan,
          text,
          workspaceContext,
        });
        return;
      }
      const sessionBytes = sessionBase64ByHash(hashes);
      if (sessionBytes !== null) {
        finalizeSubmission({
          resolvedContent: inlineHashOnlyImageBytes(
            editorContent,
            sessionBytes,
          ),
          hashOnlyContent: editorContent,
          attachmentsByHash: false,
          text,
          args: exactArgs,
          workspaceContext,
          attempt,
          hostId,
        });
        return;
      }
      // Async (session-cold / restored draft) path only — the sync paths above
      // finalize in-stack and clear the editor before any re-entry is possible, so
      // they need no guard. `.catch` surfaces an IndexedDB read failure (private
      // browsing, quota exceeded, corrupt DB) instead of failing silently; `.finally`
      // clears the flag on success, missing-bytes, and a rejected read alike, so the
      // guard can never get stuck.
      if (submissionInFlightRef.current) {
        // `startSubmission` already flipped this attempt's draft to
        // `isSubmitting`, but this guard is per-composer while the attempt is
        // per-draft: a re-entrant submit that resolved to a DIFFERENT draft
        // gets a live attempt and then bails here, so without completing it
        // that draft stays `isSubmitting` with nothing left to settle it.
        draftRuntimeRegistry.complete(attempt);
        return;
      }
      submissionInFlightRef.current = true;
      void resolveBase64ByHash(hashes, draftImageByteTargetForHost(hostId))
        .then((bytesByHash) => {
          if (attemptAborted(attempt)) return;
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
            resolvedContent: inlineHashOnlyImageBytes(
              editorContent,
              bytesByHash,
            ),
            hashOnlyContent: editorContent,
            attachmentsByHash: false,
            text,
            args: exactArgs,
            workspaceContext,
            attempt,
            hostId,
          });
        })
        .catch(() => {
          if (attemptAborted(attempt)) return;
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
    [dispatchByHashSubmission, finalizeSubmission, submitClient],
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
      // The identity this create belongs to, captured synchronously. The
      // create's continuation outlives this component, and the completion
      // re-anchor below is an INSERT into account-scoped memory - see its own
      // comment for why that has to be checked. `dispatchSubmission` needs no
      // equivalent capture: its retired-settlement early return already turns
      // the whole continuation back on an identity teardown.
      const dispatchUserId = useAuthStore.getState().profile?.userId ?? null;
      // Stored untitled; the title is generated from the first terminal prompt,
      // and render surfaces fall back via `epicDisplayTitle` meanwhile. (The
      // tui-agent tile is named separately in `use-create-tui-agent.ts`.)
      const epicTitle = "";

      // Local state + navigation happen synchronously before the host
      // round-trip, mirroring `dispatchSubmission`. The placeholder tile
      // opened inside `terminalAgentCreateFn` renders "Loading terminal
      // agent…" for the whole setup wait, so the user lands on the epic
      // immediately instead of the landing page freezing on the ~3-4s
      // `agent.tui.prepareLaunch` round-trip.
      const tabId = uuidv4();
      // Terminal-agent create registers no initial-chat handoff, so this
      // synchronous marker is what keeps the existence reconciler from
      // force-closing the tab before `epic.listTasks` reflects the new epic.
      // The create host rides along for session placement; this flow
      // navigates BEFORE the host round-trip, so the session provider mounts
      // while only the create host can ever serve the epic.
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

      // Create the epic, then the tui-agent off the navigation critical
      // path. Chaining preserves the host ordering the blocking flow
      // relied on (`epic.create` → `agent.tui.prepareLaunch` →
      // `epic.createTuiAgent`); errors surface via each mutation hook's
      // `onError` toast.
      // Terminal agents are epic-only at create time (`chat: null`); the
      // tui-agent is created by the chained `terminalAgentCreateFn` below.
      void createLandingEpic({
        epicId,
        hostId,
        title: epicTitle,
        initialUserPrompt: "",
        workspaceFolders: workspaceContext.workspaceFolders,
        workspaceFolderInfoByPath: workspaceContext.workspaceFolderInfoByPath,
        now,
        // DISCARDED on this line, and that is the correct answer rather than an
        // omission: the terminal-agent flow has no existence reconciliation, so
        // a rejection here is final and the teardown that already ran is what
        // should stand. Nothing to recover to.
        captureSeedRecovery: () => undefined,
        chat: null,
      })
        .then(
          (response) => {
            // A REFUSAL lands HERE, not in the arm below: `epic.create@1.1`
            // answers it as an optional key on a resolved response, so the
            // fulfilled arm runs for a create that did not happen. This flow
            // is the dangerous one of the two - it navigated and opened the
            // tile BEFORE the round-trip, so without this branch it would
            // clear the staged worktree intent a retry needs, re-arm the
            // reconciler exemption for an epic that does not exist, and then
            // chain `agent.tui.prepareLaunch` / `epic.createTuiAgent` against
            // it, whose own `onError` toast would report the missing epic as a
            // second, unrelated-looking failure.
            //
            // Settled exactly like the rejection arm below, because it is the
            // same fact: the epic never landed, so drop the marker and let the
            // existence reconciler prune the orphan tab. `useEpicCreateForClient.onSuccess`
            // owns the user-facing message and the repair offer.
            if (response.refusal !== undefined) {
              unmarkEpicCreatedThisSession(epicId);
              return;
            }
            // This staged selection now belongs to a successfully-created
            // epic. Until this point a retry must see the exact same intent.
            clearConsumedLandingWorktreeIntent(workspaceContext);
            // Re-anchor the create-race window on COMPLETION. The marker
            // above is written before the request because the reconciler
            // needs it that early, but the race it bounds - the host's
            // deferred cloud connect - only starts now, and `epic.create`
            // can legitimately hold a 30s host-side deadline before landing.
            // Measured from the request instead, a slow create burns its own
            // window and the session it protects opens unprotected.
            //
            // Only for the identity that dispatched it. These markers are
            // account-scoped, and `auth-lifecycle-bridge` clears them on
            // sign-out/user-switch precisely so the NEXT identity's persisted
            // tabs reconcile normally. This continuation survives that
            // teardown, so an unguarded re-mark would restore the outgoing
            // account's host seed and reconciliation exemption for an epic id
            // the incoming account may also have a tab for.
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
          // Only `epic.create` rejection reaches this arm (a later tui-agent
          // failure goes to the trailing `.catch`). The epic never landed, so
          // drop the create marker to let the reconciler prune the orphan tab.
          // A downstream tui-agent failure leaves the marker in place - the epic
          // exists, so it must stay protected until `epic.listTasks` reflects it.
          () => {
            unmarkEpicCreatedThisSession(epicId);
          },
        )
        .catch(() => undefined);
    },
    [createLandingEpic, navigate, terminalAgentCreateFn],
  );

  // Selection model §54's submit-time re-validation, and the FIRST thing both
  // actions do. It runs before any store write, navigation, or optimistic
  // seed: a refusal must leave the composer exactly as the user left it, with
  // the message rendered inline next to the send button.
  //
  // `placement.hostId` is then the only host id that reaches the request, the
  // workspace-context read, the tab binding and the handoff registration - and
  // `placement.client` is the only client the requests go out on, so "created
  // on a host the chip never showed" is unreachable rather than unlikely.
  // The second submit-time gate, on the host the first one named: a session
  // without a cloud verdict may only create on a host that serves creates
  // locally, which `epic.create@1.1` now states directly (it used to be read
  // off the `epic.listTasks` line, because `epic.create` had only `@1.0` and
  // could not answer for itself). See `refuseCreateWithoutCloudVerdict`.
  const resolveAdmittedPlacement = useCallback((): LandingPlacement => {
    const placement = resolveLandingPlacement(target);
    if (placement.kind === "refused") return placement;
    return (
      refuseCreateWithoutCloudVerdict({
        status: useAuthStore.getState().status,
        negotiatedCreate: getNegotiatedHostMethodVersion(
          placement.hostId,
          "epic.create",
        ),
        hostLabel: target.hostLabel,
      }) ?? placement
    );
  }, [target]);

  const submit = useCallback(
    (args: LandingComposerSubmitArgs): LandingPlacementRefusal | null => {
      const placement = resolveAdmittedPlacement();
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
    [dispatchSubmission, queryClient, resolveAdmittedPlacement],
  );

  const selectTerminalAgent = useCallback(
    (
      launch: TerminalAgentLaunch,
      draftId: string | null,
    ): LandingPlacementRefusal | null => {
      const placement = resolveAdmittedPlacement();
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
    [dispatchTerminalAgent, queryClient, resolveAdmittedPlacement],
  );

  return useMemo(
    () => ({
      submit,
      selectTerminalAgent,
      // The upload phase counts. It runs BEFORE `epic.create` is dispatched, so
      // without it the composer would report itself idle for the whole of a
      // multi-megabyte `drafts.putBlob` pass and keep Send live through it.
      isPending:
        createEpic.isPending ||
        terminalAgentCreate.isPending ||
        attachmentUploadPending,
    }),
    [
      attachmentUploadPending,
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
      // The placement host is the same one whose workspace is restored below;
      // a pinned pristine composer must not seed either setting from the
      // app-wide active host.
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
    // There is no independent numeric layout revision in the renderer store.
    // Capture the exact structural projection at intent; success re-preflights
    // rather than relying on this potentially stale evidence.
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
  // `captureSubmissionPlacement` builds `refKey` as `draft:<draftId>`, so a
  // placement already names its own draft. Taking a separate `draftId` here
  // and re-checking the two agree expressed the invariant twice and only
  // created a way for a caller to pass a mismatched pair.
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
  // The identity bridge already cleared session-local handoff and created-epic
  // markers. These id-scoped leftovers were installed before the one-shot host
  // request and must not be observed by the next identity after a late reply.
  unmarkEpicCreatedThisSession(input.epicId);
  useComposerRunSettingsStore.getState().clearEpicRunSettings([input.epicId]);
  useEpicCanvasStore.getState().clearEpicTitlePending(input.epicId);
  useEpicCanvasStore.getState().clearChatTitlePending(input.chatId);
}

/**
 * The epic never landed on the host - a REJECTED or a REFUSED create - for an
 * attempt that is still current.
 *
 * Everything {@link discardRetiredLandingEpic} drops, plus the one settlement
 * the retired arm must not perform: the initial-chat handoff registered before
 * the request moves to `failed`. That entry is persisted and, while `pending`,
 * `selectHasActiveInitialChatHandoffForEpic` counts it as a reason to keep the
 * epic's tab from reconciliation - so left alone it outlives the epic it names.
 * The retired arm skips this because the identity bridge already tore the
 * entry down and `markFailed` would re-insert one under the departed identity;
 * a refusal has no such bridge, which is why it takes THIS exit and not that
 * one. One function for both arms so the two cannot drift again.
 */
function settleUnlandedLandingEpic(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly userId: string | null;
}): void {
  discardRetiredLandingEpic(input);
  useInitialChatHandoffStore
    .getState()
    .markFailed(
      { hostId: input.hostId, userId: input.userId, epicId: input.epicId },
      "Couldn't create the epic.",
    );
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
  // The DISPATCH-TIME host this context was read for - the same one its folder
  // bucket and cached default intent came from. Carried rather than re-read at
  // the write, so a host switch landing mid-dispatch cannot file this launch's
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

// Launch-boundary canonicalization shared by the draft and global paths, and
// the same `effectiveWorktreeIntent` the new-conversation modal and every
// seeded launcher route through: give each folder exactly one entry -
// synthesizing a `local` default for a folder that never reached the staging
// store - drop entries whose folder left the workspace, and stamp `isPrimary`
// from the resolved primary rather than the staged bit.
//
// The synthesis is what keeps a primary switch onto a NON-GIT folder honest.
// Non-git folders are never auto-staged, so restamping alone would flip the
// only staged (git) entry to `isPrimary: false` with nothing taking its
// place, sending a zero-primary intent.
//
// A nothing-staged launch only stays `null` when the cached workspace summaries
// do not identify a resolved git folder. When the picker is visibly showing its
// derived "New worktree" default but branch-dependent memory is still being
// validated, `cachedDefaultWorktreeIntent` closes that transient gap at the
// submit boundary without trusting the unvalidated remembered branch.
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
  // Restores the exact branches next time the epic opens. The per-folder default
  // memory is persisted eagerly on each selection, so send only writes the
  // per-epic tier. Keyed by the context's dispatch-time host - the intent names
  // paths and branches that only exist on that machine.
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
  // Every host's copy, and unconditionally: the landing picker rebinds the
  // app-wide host in place, so a pick staged on another host belongs to this
  // same consumed session. Gating on the SUBMITTING host having an intent
  // would skip the whole consume when the user staged on host A and then
  // submitted from a folderless host B - leaving A's slot to seed the next
  // landing session (null draft) or linger against the staging cap (minted
  // draft). This only runs once a create has actually succeeded, so there is
  // no retry left that needs the staged intent.
  useWorktreeIntentStagingStore.getState().clearForAllHosts(stagingKey);
}

/**
 * The landing composer's own byte-resolution policy, on top of the shared
 * primitives.
 *
 * The RESOLUTION (`resolveDraftImageBytes`) and the REWRITE
 * (`inlineHashOnlyImageBytes`) are upstream's and are not restated here. What
 * is local is the refusal: a hash with no bytes names nothing on a landing
 * submit, because no epic exists yet for the host to resolve it against, so
 * this surface reports a miss and refuses rather than sending a reference
 * nothing can answer. Every other surface leaves such a node hash-only on
 * purpose - see `draft-image-inlining.ts`.
 */
async function resolveBase64ByHash(
  hashes: ReadonlyArray<string>,
  target: DraftImageByteTarget,
): Promise<Map<string, string>> {
  const base64ByHash = new Map<string, string>();
  await Promise.all(
    hashes.map(async (hash) => {
      const bytes = await resolveDraftImageBytes(hash, target);
      if (bytes !== null) base64ByHash.set(hash, bytesToBase64(bytes));
    }),
  );
  return base64ByHash;
}

/**
 * The synchronous fast path: every hash straight from this session's cache, or
 * `null` the moment one is cold.
 *
 * Kept even though `resolveDraftImageBytes`' first leg already consults the
 * session cache, because the value here is not avoiding a round trip - it is
 * staying in ONE STACK FRAME. A landing submit that yields between reading the
 * document and clearing it opens a window for a re-entrant submit; the async
 * path below carries an explicit in-flight guard for exactly that reason, and
 * this path exists so the common case never needs it.
 */
function sessionBase64ByHash(
  hashes: ReadonlyArray<string>,
): Map<string, string> | null {
  const base64ByHash = new Map<string, string>();
  for (const hash of hashes) {
    const bytes = sessionImageBytes(hash);
    if (bytes === null) return null;
    base64ByHash.set(hash, bytesToBase64(bytes));
  }
  return base64ByHash;
}

/**
 * Whether this attempt has been abandoned since it was last asked.
 *
 * A FUNCTION rather than a bare `attempt.abortController.signal.aborted` read,
 * and that is the entire point of it. TypeScript narrows a property access and
 * KEEPS that narrowing across an `await`, because nothing in the type system
 * models the abort controller flipping the flag from outside this function. So
 * the first guard in a callback narrows the property to `false`, and the second
 * one - on the far side of the suspension, which is the only place an abort can
 * have happened, and therefore the guard that actually matters - types as
 * always-falsy and lints as an unnecessary condition.
 *
 * Deleting that guard is what the lint literally suggests and it would be a
 * bug: a submit abandoned during the byte read would go on to finalize. A
 * call's result is a fresh `boolean` every time, so no narrowing carries and
 * each guard means what it says. Used at every abort check on this surface, not
 * just the one that happened to trip the rule, so inserting an `await` above
 * any of them cannot quietly re-create the situation.
 */
function attemptAborted(attempt: DraftSubmissionAttempt): boolean {
  return attempt.abortController.signal.aborted;
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

// Minimal binding rows from the picked folders for the optimistic chip. Git
// details are unknown here and are filled in by the host's
// `worktree.listBindingsForEpic` response, which supersedes this seed.
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
        // The seed's git facts are a client-side guess (cloud association ≠
        // a git probe). A folder we could not associate to a repo is
        // git-unverified, so it renders as "checking" until the host's real
        // listing supersedes this seed; an associated (git) folder is shown
        // as-is.
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
