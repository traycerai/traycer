import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { v4 as uuidv4 } from "uuid";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { useCreateTuiAgentForClient } from "@/hooks/agent/use-create-tui-agent";
import type { TerminalAgentWorktreeCreateInput } from "@/components/epic-canvas/hooks/use-terminal-agent-worktree-gate";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { buildFixedHostWorkspaceControlsScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { dialableHostEndpoint } from "@/lib/host/transport-key";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  useEpicCreateChatForHostClient,
  type CreateChatMutationInput,
} from "@/hooks/epic/use-epic-chat-mutations";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useHostClient } from "@/lib/host/runtime";
import { displayTitle } from "@/lib/display-title";
import {
  useEpicNodeHostId,
  useEpicNodeOwnerKind,
  useEpicNodeWorkspaceFolders,
} from "@/lib/epic-selectors";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import { useOwnerWorkspaceInheritanceSeed } from "@/hooks/worktree/use-owner-workspace-inheritance-seed";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import {
  pendingChildTerminalAgentStagingKey,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { openProjectedSidebarNodeInTabWhenAvailable } from "./open-projected-sidebar-node";
import { computeArtifactNodeAddChildPending } from "./epic-sidebar-tree-shared";
import { resolveRowChildHost } from "./chat-row-child-host";

export interface ChatRowChildCreate {
  readonly onAddChild: (type: EpicNodeKind) => void;
  readonly onAddTerminalAgent:
    ((input: TerminalAgentWorktreeCreateInput) => void) | undefined;
  readonly addMenuOpen: boolean;
  readonly onAddMenuOpenChange: (open: boolean) => void;
  readonly terminalAgentWorkspaceSeed: ForkWorkspaceSeed | null;
  readonly terminalAgentHostScope: HostWorkspaceControlsHostScope;
  readonly terminalAgentStagingKey: WorktreeStagingKey;
  readonly pendingChildName: string | null;
  readonly addChildIsPending: boolean;
  readonly tuiAgentPending: boolean;
  readonly hostUnavailable: boolean;
  readonly workspaceInheritanceBlocked: boolean;
}

export function buildChildChatCreateInput(input: {
  readonly epicId: string;
  readonly parentId: string;
  readonly chatId: string;
  readonly workspaceSeed: ForkWorkspaceSeed | null;
}): CreateChatMutationInput {
  return {
    epicId: input.epicId,
    parentId: input.parentId,
    title: "",
    chatId: input.chatId,
    worktreeIntent: input.workspaceSeed?.intent ?? null,
  };
}

export function useChatRowChildCreate(args: {
  readonly epicId: string;
  readonly tabId: string;
  readonly nodeId: string;
  readonly canMutate: boolean;
  readonly ensureExpanded: (id: string) => void;
}): ChatRowChildCreate {
  const { epicId, tabId, nodeId, canMutate, ensureExpanded } = args;
  const epicHandle = useOpenEpicHandle();
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const [addMenuOpen, onAddMenuOpenChange] = useState(false);
  const rowHostId = useEpicNodeHostId(nodeId);
  const parentOwnerKind = useEpicNodeOwnerKind(nodeId);
  const activeHostId = useReactiveActiveHostId();
  const activeHostClient = useHostClient();
  const remoteHostLookupId =
    rowHostId !== null && rowHostId !== activeHostId ? rowHostId : "";
  const remoteHostEntry = useHostDirectoryEntry(remoteHostLookupId);
  const remoteHostClient = useHostClientFor(remoteHostEntry);
  // `useHostClientFor` builds a transient client whenever the entry carries a
  // `websocketUrl`, even for one the directory has marked `unavailable` (a
  // remote host that went offline but still advertises a URL). Mirror the
  // canonical dialability rule so an offline host resolves to
  // `unavailable-remote` and keeps the row "+" disabled instead of issuing RPCs
  // against a dead host.
  const dialableRemoteClient =
    dialableHostEndpoint(remoteHostEntry) === null ? null : remoteHostClient;
  const hostResolution = resolveRowChildHost({
    rowHostId,
    activeHostId,
    activeClient: activeHostClient,
    remoteClient: dialableRemoteClient,
  });
  const createHostClient = hostResolution.client;
  const createHostId = hostResolution.hostId;
  const hostUnavailable = hostResolution.isUnavailable;
  const terminalAgentHostScope = useMemo(
    () =>
      buildFixedHostWorkspaceControlsScope({
        hostId: createHostId,
        hostClient: createHostClient,
      }),
    [createHostClient, createHostId],
  );
  const createChild = useEpicCreateChatForHostClient(createHostClient);
  const terminalAgentCreate = useCreateTuiAgentForClient(
    createHostClient,
    createHostId ?? UNKNOWN_HOST_PLACEHOLDER,
  );
  const terminalAgentStagingKey = useMemo(
    () => pendingChildTerminalAgentStagingKey(epicId, nodeId),
    [epicId, nodeId],
  );
  const parentWorkspaceFolders = useEpicNodeWorkspaceFolders(nodeId);
  const childWorkspace = useOwnerWorkspaceInheritanceSeed({
    client: createHostClient,
    epicId,
    ownerId: nodeId,
    ownerKind: parentOwnerKind,
    enabled: addMenuOpen && !hostUnavailable,
    fallbackWorkspaceFolders: parentWorkspaceFolders,
  });
  const parentBindingPending = childWorkspace.pending;
  const workspaceInheritanceUnavailable = childWorkspace.unavailable;
  const parentBindingBlocked =
    parentBindingPending || workspaceInheritanceUnavailable;
  const [pendingChildName, setPendingChildName] = useState<string | null>(null);
  const pendingProjectedOpenCancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const cancelRef = pendingProjectedOpenCancelRef;
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, []);

  const clearPendingChildCreate = useCallback(() => {
    pendingProjectedOpenCancelRef.current?.();
    pendingProjectedOpenCancelRef.current = null;
    startTransition(() => {
      setPendingChildName(null);
    });
  }, []);

  const openProjectedChildInTab = useCallback(
    (
      projectedNodeId: string,
      onBeforeOpen: ((node: EpicNodeRef) => void) | null,
    ) => {
      pendingProjectedOpenCancelRef.current?.();
      pendingProjectedOpenCancelRef.current =
        openProjectedSidebarNodeInTabWhenAvailable({
          epicHandle,
          tabId,
          nodeId: projectedNodeId,
          fallbackHostId: createHostId ?? UNKNOWN_HOST_PLACEHOLDER,
          openTileInTab,
          onBeforeOpen,
          onOpened: () => {
            pendingProjectedOpenCancelRef.current = null;
            startTransition(() => {
              setPendingChildName(null);
            });
          },
          onUnavailable: () => {
            pendingProjectedOpenCancelRef.current = null;
            startTransition(() => {
              setPendingChildName(null);
            });
          },
          onCleanup: null,
        });
    },
    [createHostId, epicHandle, openTileInTab, tabId],
  );

  const onAddChild = useCallback(
    (type: EpicNodeKind) => {
      if (!canMutate || hostUnavailable || parentBindingBlocked) return;
      if (type !== "chat") return;
      ensureExpanded(nodeId);
      setPendingChildName(displayTitle("", "chat"));
      createChild.mutate(
        buildChildChatCreateInput({
          epicId,
          chatId: uuidv4(),
          parentId: nodeId,
          workspaceSeed: childWorkspace.seed,
        }),
        {
          onSuccess: (result) => {
            openProjectedChildInTab(result.chatId, null);
          },
          onError: () => {
            clearPendingChildCreate();
          },
        },
      );
    },
    [
      canMutate,
      clearPendingChildCreate,
      createChild,
      childWorkspace.seed,
      hostUnavailable,
      parentBindingBlocked,
      ensureExpanded,
      epicId,
      nodeId,
      openProjectedChildInTab,
    ],
  );

  const onAddTerminalAgent = useCallback(
    (input: TerminalAgentWorktreeCreateInput) => {
      if (
        !canMutate ||
        hostUnavailable ||
        (input.worktreeIntent === null && parentBindingBlocked)
      ) {
        return;
      }
      ensureExpanded(nodeId);
      const { worktreeIntent } = input;
      if (worktreeIntent !== null && worktreeIntent.entries.length > 0) {
        useWorktreeIntentMemoryStore
          .getState()
          .setEpicIntent(epicId, worktreeIntent, Date.now());
      }
      useWorktreeIntentStagingStore.getState().clear(terminalAgentStagingKey);
      // `create` propagates errors from every step (startSession /
      // createTuiAgent / worktree.create); the underlying mutation hooks already
      // surface user-facing toasts via their `onError`. Swallow the rejection
      // here only so this fire-and-forget call never becomes an unhandled
      // promise rejection.
      void terminalAgentCreate
        .create({
          epicId,
          tabId,
          parentId: nodeId,
          title: "",
          placement: { kind: "active-tile" },
          harnessId: input.harnessId,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          agentMode: input.agentMode,
          forkSourceHarnessSessionId: null,
          onStatusChange: null,
          worktreeIntent,
          terminalAgentArgs: input.terminalAgentArgs,
        })
        .catch(() => {});
    },
    [
      canMutate,
      hostUnavailable,
      ensureExpanded,
      epicId,
      nodeId,
      tabId,
      terminalAgentCreate,
      terminalAgentStagingKey,
      parentBindingBlocked,
    ],
  );

  const addChildIsPending = computeArtifactNodeAddChildPending({
    pendingChildName,
    pendingChildRealId: null,
    createArtifactPending: createChild.isPending,
  });

  return {
    onAddChild,
    onAddTerminalAgent,
    addMenuOpen,
    onAddMenuOpenChange,
    terminalAgentWorkspaceSeed: childWorkspace.seed,
    terminalAgentHostScope,
    terminalAgentStagingKey,
    pendingChildName,
    addChildIsPending,
    tuiAgentPending: terminalAgentCreate.isPending,
    hostUnavailable,
    workspaceInheritanceBlocked: parentBindingBlocked,
  };
}
