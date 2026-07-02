import { useCallback, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import type {
  CreateEpicChatSeed,
  CreateEpicResponse,
  CreateEpicWorkspaceIdentifier,
  TaskRepoIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host/worktree-schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { CURRENT_EPIC_VERSION } from "@traycer-clients/shared/epic/epic-version";

import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useEpicCreate } from "@/hooks/epic/use-epic-create-mutation";
import { useCreateTuiAgent } from "@/hooks/agent/use-create-tui-agent";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import {
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useLandingComposerStore } from "@/stores/composer/landing-composer-store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  markEpicCreatedThisSession,
  unmarkEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import {
  existingEpicTabIntent,
  navigateToTabIntent,
} from "@/lib/tab-navigation";
import {
  buildSubmittedChatJSONContent,
  extractPlainTextFromComposerJSONContent,
  stringValue,
} from "@/lib/composer/tiptap-json-content";
import { normalizeComposerContent } from "@/lib/composer/composer-content-normalizer";
import {
  collectImageAtoms,
  containsImageAtoms,
} from "@/lib/composer/image-atoms";
import {
  getImageBytes,
  sessionImageBytes,
} from "@/lib/composer/landing-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type {
  PermissionMode,
  AgentMode,
  HarnessModelSelection,
  ReasoningLevel,
  ServiceTier,
} from "@/components/home/data/landing-options";

export interface LandingComposerSubmitArgs {
  readonly editor: ComposerPromptEditorHandle | null;
  readonly toolbar: {
    readonly selection: HarnessModelSelection;
    readonly reasoning: ReasoningLevel;
    readonly serviceTier: ServiceTier;
    readonly permission: PermissionMode;
    readonly agentMode: AgentMode;
  };
}

export interface TerminalAgentLaunch {
  readonly harnessId: TuiHarnessId;
  readonly agentMode: AgentMode;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly terminalAgentArgs: string | null;
}

export interface LandingComposerActions {
  readonly submit: (args: LandingComposerSubmitArgs) => void;
  readonly selectTerminalAgent: (launch: TerminalAgentLaunch) => void;
}

/**
 * Composes host mutations + store writes + navigation behind two stable
 * callbacks. Identities only change when the underlying mutation handles or
 * `navigate` change - both stable for the lifetime of a route. Callers can
 * rely on `submit` / `selectTerminalAgent` as constants without wrapping
 * them in `useRef`.
 */
export function useLandingComposerActions(): LandingComposerActions {
  const navigate = useNavigate();
  const client = useHostClient();
  const queryClient = useQueryClient();
  const createEpic = useEpicCreate();
  const terminalAgentCreate = useCreateTuiAgent();
  const createEpicMutateAsync = createEpic.mutateAsync;
  const terminalAgentCreateFn = terminalAgentCreate.create;

  // Guards the async (session-cold image) submit path against re-entry: on that
  // path `createEpic.isPending` — and thus the composer's `canSubmit` — only flips
  // inside the deferred `finalizeSubmission`, so without this a second submit
  // during the IndexedDB read would create a second epic.
  const submissionInFlightRef = useRef(false);

  // Single create path shared by the GUI-chat and terminal-agent flows so the
  // epic.create request (epic light + repos + workspaces + folded chat) - and
  // therefore the optimistic history insert in `useEpicCreate.onSuccess` - is
  // built identically and cannot drift between the two entry points.
  const createLandingEpic = useCallback(
    (input: {
      readonly epicId: string;
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
      const hostId = client.getActiveHostId();
      const optimisticRows = buildOptimisticWorkspaceBindingRows(
        input.workspaceFolders,
        input.workspaceFolderInfoByPath,
        hostId,
      );
      // The seed is keyed by the create-time ACTIVE host. That is the same
      // host the new epic's chat / terminal tabs bind to, so the tab-scoped
      // readers (e.g. chat-tile's availability query, which resolves via the
      // tab host) read this seed. Keep the create-time tab binding and the
      // active host in lockstep, or seed under the host the initial tabs
      // bind to instead.
      const seededBindingsKey =
        optimisticRows.length > 0 && hostId !== null
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
          readonly rows: WorktreeBindingSelectorRow[];
        }>(seededBindingsKey, { rows: [...optimisticRows] });
      };
      // Seed the binding-list query cache with the folders the user just picked
      // BEFORE the create resolves, so the in-epic chip and the command-palette
      // Files/Diff openers show them immediately instead of flashing empty
      // during the in-flight create.
      seedBindings();
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
          // Re-assert the seed after success to overwrite a racing first fetch
          // that returned `[]` before the host's warm-slot create seed landed
          // (no flicker). `useEpicCreate`'s invalidation then reconciles to the
          // host's truth, including later removals, so the chip can't get
          // stuck showing removed folders.
          seedBindings();
          return response;
        })
        .catch((error: unknown) => {
          // Roll back the seed so a failed create can't leave the chip showing
          // folders for an epic that never existed.
          if (seededBindingsKey !== null) {
            queryClient.removeQueries({ queryKey: seededBindingsKey });
          }
          throw error;
        });
    },
    [client, createEpicMutateAsync, queryClient],
  );

  // Everything from building `submittedContent` through the optimistic
  // local-state writes + navigation + host create. Pulled into its own callback
  // so the dispatcher below can feed it either the synchronously re-inlined
  // content (cached images, no await) or the IndexedDB-resolved content
  // (restored draft) while the sync local-state/nav block stays byte-identical
  // across both paths.
  const finalizeSubmission = useCallback(
    (
      resolvedContent: JsonContent,
      text: string,
      args: LandingComposerSubmitArgs,
      workspaceContext: LandingWorkspaceContext,
    ) => {
      const { editor, toolbar } = args;
      if (editor === null) return;

      const submittedContent = buildSubmittedChatJSONContent(resolvedContent);
      const profile = useAuthStore.getState().profile;

      const workspaces = buildWorkspaceAssociations(
        workspaceContext.workspaceFolders,
        workspaceContext.workspaceFolderInfoByPath,
      );
      if (workspaces.length === 0) {
        toast.error("Couldn't create epic.", {
          description:
            "Select at least one workspace folder to create an epic.",
        });
        return;
      }

      const settings = buildChatRunSettings({
        selection: toolbar.selection,
        permission: toolbar.permission,
        reasoning: toolbar.reasoning,
        serviceTier: toolbar.serviceTier,
        agentMode: toolbar.agentMode,
      });
      if (settings.model.length === 0) return;
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
      const activeHostId = client.getActiveHostId();
      // The folded chat is bound to a device for life, so a host must be
      // active to mint its binding (workspaces already imply one).
      if (activeHostId === null) {
        toast.error("Couldn't create epic.", {
          description: "No active device. Reconnect and try again.",
        });
        return;
      }
      const userId = profile?.userId ?? null;

      // Local state + navigation happen synchronously before the host
      // round-trip. The chat is folded into `epic.create` and seeded into the
      // epic doc atomically, so the chat tile's gated subscribe never opens the
      // epic before the chat exists.
      useComposerRunSettingsStore
        .getState()
        .setGlobalRunSettings(settings, now);
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings(epicId, settings, now);
      rememberLandingWorktreeIntent(
        epicId,
        workspaceContext.worktreeIntent,
        now,
      );
      useInitialChatHandoffStore.getState().register({
        hostId: activeHostId,
        userId,
        epicId,
        chatId,
        content: submittedContent,
        settings,
        worktreeIntent: workspaceContext.worktreeIntent,
        placement: { kind: "active-tile" },
        messageId,
        clientActionId,
        createdAt: now,
      });
      // Stored untitled; the displayed label is derived at render via
      // `epicDisplayTitle`.
      const epicTitle = "";
      const tabId = useEpicCanvasStore
        .getState()
        .openEpicTab(epicId, epicTitle);
      // Mark before navigation so the epic-tab existence reconciler never
      // force-closes this tab while `epic.listTasks` still lags `epic.create`.
      markEpicCreatedThisSession(epicId);
      // Spinner anchor is the pre-generation title (empty here); it clears once
      // a non-empty title is projected or the backstop fires.
      useEpicCanvasStore.getState().markEpicTitlePending(epicId, epicTitle);
      const activeDraftId = useLandingDraftStore.getState().activeDraftId;
      if (activeDraftId !== null) {
        useLandingDraftStore.getState().closeDraft(activeDraftId);
      }
      useLandingComposerStore.getState().reset();
      editor.clear();
      // Submit closed the active draft + reset the live mirror, so the sent
      // image's hashes may now be orphaned — reclaim them (debounced).
      scheduleLandingImageReconcile();
      navigateToTabIntent(
        navigate,
        existingEpicTabIntent({ epicId, tabId, focus: undefined }),
      );

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
      if (initialMessage !== null) {
        // Anchor the chat-title spinner on the empty store (mirrors the epic
        // spinner above and `dispatchTerminalAgent`): the chat is created with
        // an empty title, so the expected pre-generation value is `""`. The
        // spinner shows while the projected title is still empty and clears once
        // a non-empty AI title is projected (or the 30s backstop fires).
        useEpicCanvasStore.getState().markChatTitlePending(chatId, "");
      }

      void createLandingEpic({
        epicId,
        title: epicTitle,
        initialUserPrompt: text,
        workspaceFolders: workspaceContext.workspaceFolders,
        workspaceFolderInfoByPath: workspaceContext.workspaceFolderInfoByPath,
        now,
        chat: {
          chatId,
          parentId: null,
          hostId: activeHostId,
          // Stored untitled; the "Untitled chat" / first-message fallback is a
          // render concern, never baked into the stored title.
          title: "",
          worktreeIntent: workspaceContext.worktreeIntent,
          initialMessage,
        },
      })
        .then((response) => {
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
        })
        .catch(() => {
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
        });
    },
    [client, createLandingEpic, navigate],
  );

  const dispatchSubmission = useCallback(
    (
      args: LandingComposerSubmitArgs,
      workspaceContext: LandingWorkspaceContext,
    ) => {
      const { editor } = args;
      if (editor === null) return;

      const editorContent = normalizeComposerContent(editor.getJSON());
      const text = extractPlainTextFromComposerJSONContent(editorContent);
      const hasImages = containsImageAtoms(editorContent);
      if (text.trim().length === 0 && !hasImages) return;

      // The live editor content is hash-only (landing pastes hashes, never
      // base64). Re-inline each image hash back to base64 so the host ingests it
      // exactly like a fresh paste. Fast path: every hash is in the session cache
      // (the common "you just typed it" case) → resolve synchronously and keep
      // the optimistic local-state + navigation block synchronous. Slow path: a
      // restored (session-cold) draft → await IndexedDB BEFORE that block; a hash
      // with no bytes (manual wipe) blocks the send with a toast.
      const hashes = imageHashesFromContent(editorContent);
      if (hashes.length === 0) {
        finalizeSubmission(editorContent, text, args, workspaceContext);
        return;
      }
      const sessionBytes = readSessionImageBytes(hashes);
      if (sessionBytes !== null) {
        finalizeSubmission(
          inlineImageHashes(editorContent, sessionBytes),
          text,
          args,
          workspaceContext,
        );
        return;
      }
      // Async (session-cold / restored draft) path only — the sync paths above
      // finalize in-stack and clear the editor before any re-entry is possible, so
      // they need no guard. `.catch` surfaces an IndexedDB read failure (private
      // browsing, quota exceeded, corrupt DB) instead of failing silently; `.finally`
      // clears the flag on success, missing-bytes, and a rejected read alike, so the
      // guard can never get stuck.
      if (submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      void resolveImageBytes(hashes)
        .then((bytesByHash) => {
          const missing = hashes.filter((hash) => !bytesByHash.has(hash));
          if (missing.length > 0) {
            toast.error("Couldn't attach an image.", {
              description: "Re-add the image and try sending again.",
            });
            return;
          }
          finalizeSubmission(
            inlineImageHashes(editorContent, bytesByHash),
            text,
            args,
            workspaceContext,
          );
        })
        .catch(() => {
          toast.error("Couldn't attach an image.", {
            description: "Image storage is unavailable. Please try again.",
          });
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
    ) => {
      const {
        harnessId,
        agentMode,
        model,
        reasoningEffort,
        terminalAgentArgs,
      } = launch;
      const workspaces = buildWorkspaceAssociations(
        workspaceContext.workspaceFolders,
        workspaceContext.workspaceFolderInfoByPath,
      );
      if (workspaces.length === 0) {
        toast.error("Couldn't create epic.", {
          description:
            "Select at least one workspace folder to create an epic.",
        });
        return;
      }

      const epicId = uuidv4();
      const now = Date.now();
      rememberLandingWorktreeIntent(
        epicId,
        workspaceContext.worktreeIntent,
        now,
      );
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
      const tabId = useEpicCanvasStore
        .getState()
        .openEpicTab(epicId, epicTitle);
      // Terminal-agent create registers no initial-chat handoff, so this
      // synchronous marker is what keeps the existence reconciler from
      // force-closing the tab before `epic.listTasks` reflects the new epic.
      markEpicCreatedThisSession(epicId);
      const activeDraftId = useLandingDraftStore.getState().activeDraftId;
      if (activeDraftId !== null) {
        useLandingDraftStore.getState().closeDraft(activeDraftId);
      }
      useLandingComposerStore.getState().reset();
      navigateToTabIntent(
        navigate,
        existingEpicTabIntent({ epicId, tabId, focus: undefined }),
      );

      // Create the epic, then the tui-agent off the navigation critical
      // path. Chaining preserves the host ordering the blocking flow
      // relied on (`epic.create` → `agent.tui.prepareLaunch` →
      // `epic.createTuiAgent`); errors surface via each mutation hook's
      // `onError` toast.
      // Terminal agents are epic-only at create time (`chat: null`); the
      // tui-agent is created by the chained `terminalAgentCreateFn` below.
      void createLandingEpic({
        epicId,
        title: epicTitle,
        initialUserPrompt: "",
        workspaceFolders: workspaceContext.workspaceFolders,
        workspaceFolderInfoByPath: workspaceContext.workspaceFolderInfoByPath,
        now,
        chat: null,
      })
        .then(
          () =>
            terminalAgentCreateFn({
              epicId,
              tabId,
              parentId: null,
              title: "",
              placement: { kind: "active-tile" },
              harnessId,
              model,
              reasoningEffort,
              agentMode,
              forkSourceHarnessSessionId: null,
              onStatusChange: null,
              worktreeIntent: workspaceContext.worktreeIntent,
              terminalAgentArgs,
            }),
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

  const submit = useCallback(
    (args: LandingComposerSubmitArgs) => {
      const workspaceContext = readLandingWorkspaceContext();
      dispatchSubmission(args, workspaceContext);
      clearConsumedLandingWorktreeIntent(workspaceContext);
    },
    [dispatchSubmission],
  );

  const selectTerminalAgent = useCallback(
    (launch: TerminalAgentLaunch) => {
      const workspaceContext = readLandingWorkspaceContext();
      dispatchTerminalAgent(launch, workspaceContext);
      clearConsumedLandingWorktreeIntent(workspaceContext);
    },
    [dispatchTerminalAgent],
  );

  return useMemo(
    () => ({
      submit,
      selectTerminalAgent,
    }),
    [selectTerminalAgent, submit],
  );
}

interface LandingWorkspaceContext {
  readonly workspaceFolders: ReadonlyArray<string>;
  readonly workspaceFolderInfoByPath: Readonly<
    Record<string, WorkspaceFolderInfo>
  >;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly activeDraftId: string | null;
}

function readLandingWorkspaceContext(): LandingWorkspaceContext {
  const draftState = useLandingDraftStore.getState();
  const activeDraft =
    draftState.activeDraftId === null
      ? null
      : (draftState.drafts.find(
          (draft) => draft.id === draftState.activeDraftId,
        ) ?? null);
  const activeDraftId = activeDraft?.id ?? null;
  const worktreeIntent = readStagedWorktreeIntent({
    surface: "landing",
    draftId: activeDraftId,
  });
  if (activeDraft !== null) {
    return {
      workspaceFolders: activeDraft.workspace.folders,
      workspaceFolderInfoByPath: activeDraft.workspace.folderInfoByPath,
      worktreeIntent,
      activeDraftId,
    };
  }
  return {
    workspaceFolders: useWorkspaceFoldersStore.getState().folders,
    workspaceFolderInfoByPath:
      useWorkspaceFoldersStore.getState().folderInfoByPath,
    worktreeIntent,
    activeDraftId: null,
  };
}

function rememberLandingWorktreeIntent(
  epicId: string,
  worktreeIntent: WorktreeIntent | null,
  now: number,
): void {
  // Restores the exact branches next time the epic opens. The per-folder default
  // memory is persisted eagerly on each selection, so send only writes the
  // per-epic tier.
  if (worktreeIntent === null) return;
  useWorktreeIntentMemoryStore
    .getState()
    .setEpicIntent(epicId, worktreeIntent, now);
}

function clearConsumedLandingWorktreeIntent(
  workspaceContext: LandingWorkspaceContext,
): void {
  if (workspaceContext.worktreeIntent === null) return;
  const stagingKey: WorktreeStagingKey = {
    surface: "landing",
    draftId: workspaceContext.activeDraftId,
  };
  useWorktreeIntentStagingStore.getState().clear(stagingKey);
}

// Distinct image hashes referenced by the (hash-only) editor content. Base64
// nodes carry no hash and are left out — they pass through `inlineImageHashes`
// untouched and reach the host as-is.
function imageHashesFromContent(content: JsonContent): string[] {
  return Array.from(
    new Set(
      collectImageAtoms(content).flatMap((atom) =>
        atom.hash !== null ? [atom.hash] : [],
      ),
    ),
  );
}

// Synchronous resolve of every hash from the session cache. Returns null if any
// hash is missing, signalling the caller to fall back to the async IndexedDB
// path; a complete map keeps the submit fully synchronous.
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

// Replace each resolvable `imageAttachment` hash with inline base64, matching a
// fresh base64 paste's node shape (`b64content` set, `hash` cleared) so the host
// ingests it identically. Nodes without resolvable bytes are left unchanged.
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

// Chunked so a multi-MB image's byte array never overflows the call stack via a
// single spread into `String.fromCharCode`.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK_SIZE = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }
  return btoa(binary);
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
): WorktreeBindingSelectorRow[] {
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
