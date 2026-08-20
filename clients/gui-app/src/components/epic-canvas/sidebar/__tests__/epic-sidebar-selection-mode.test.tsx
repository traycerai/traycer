import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domMax, LazyMotion } from "motion/react";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import type { ProviderId } from "@/components/home/data/landing-options";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";

interface TestTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly type:
    "spec" | "ticket" | "story" | "review" | "chat" | "terminal-agent";
  readonly status: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface TestRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: TestTreeNode["type"];
  readonly status: number | null;
  readonly hostId: string;
}

interface TestIndicatorState {
  readonly unreadFailure: boolean;
  readonly pendingFork: boolean;
  readonly pendingApproval: boolean;
  readonly pendingInterview: boolean;
  readonly unreadDone: boolean;
}

interface TestState {
  readonly createChatMutate: Mock;
  readonly createArtifactMutate: Mock;
  readonly deleteArtifactMutateAsync: Mock;
  readonly deleteChatMutateAsync: Mock;
  readonly deleteTuiAgentMutateAsync: Mock;
  readonly exportArtifactsMutate: Mock;
  readonly localDeleteArtifact: Mock;
  readonly closeCanvasTab: Mock;
  readonly markArtifactSelfDeleted: Mock;
  readonly unmarkArtifactSelfDeleted: Mock;
  sessionReady: boolean;
  snapshotLoaded: boolean;
  activeArtifactId: string | null;
  openTileContentIds: ReadonlySet<string>;
  activePanelId: "chats" | "artifacts";
  artifactFilterKinds: ReadonlyArray<string>;
  chatFilterOrigin: "all" | "gui" | "tui";
  chatFilterOwnership: "all" | "mine" | "others";
  collapsedPanelIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  unreadArtifactIds: ReadonlySet<string>;
  tree: {
    readonly rootIds: readonly string[];
    readonly childrenByParent: Readonly<Record<string, readonly string[]>>;
    readonly nodeById: Readonly<Record<string, TestTreeNode | undefined>>;
  };
  records: readonly TestRecord[];
  indicatorChats: Readonly<Record<string, TestIndicatorState>>;
  activeAgentIds: ReadonlySet<string>;
  activityTierById: Map<string, "turn" | "background">;
  chatHarnessIds: Readonly<Partial<Record<string, ProviderId>>>;
  tuiHarnessIds: Readonly<Partial<Record<string, ProviderId>>>;
  /**
   * Optional TUI agent projection fields for the leading harness mark. When a
   * node is missing here, the row still renders the harness (via
   * `tuiHarnessIds`) but without a managed-profile accent.
   */
  tuiAgentById: Readonly<
    Partial<
      Record<
        string,
        {
          readonly hostId: string;
          readonly profileId: string | null;
        }
      >
    >
  >;
  tuiProviderProfiles: ReadonlyArray<{
    readonly profileId: string;
    readonly kind: "ambient" | "managed";
    readonly label: string;
  }>;
  permissionRole: "owner" | "editor" | "viewer" | null;
  /**
   * The host's `epic.setChatArchived` support, as the registry reports it:
   * `true` advertised, `false` known absent, `null` no handshake yet. One knob
   * for both consumers - affordances read the fail-closed boolean derived from
   * it, and archive HIDING reads the tri-state - so a test can never put the
   * two into a combination the real registry could not produce.
   */
  archiveSupport: boolean | null;
  archiveVisibility: "unarchived" | "archived" | "all";
  /** Ids whose record carries a non-null `archivedAt`. */
  archivedIds: readonly string[];
  archiveMutate: Mock;
  archiveBatchPending: boolean;
  /**
   * `useEpicArchiveChat().isPending` - the PER-ROW mutation. Distinct from
   * `archiveBatchPending`, which drives the bulk `useEpicArchiveChats` hook
   * only; a row's own hard-disabled-while-in-flight state is unreachable
   * through that one.
   */
  archiveRowPending: boolean;
  archiveMutateAsync: Mock<
    (input: {
      readonly epicId: string;
      readonly chatId: string;
      readonly archived: boolean;
    }) => Promise<unknown>
  >;
  rowHostId: string | null;
  rowHostReachability: "reachable" | "unreachable";
  preparedOpenRefs: Array<{ type: string; id: string; hostId: string }>;
  rowHostEntry: unknown;
  rowHostClient: unknown;
  activeHostClient: unknown;
  sessionHandleByChatId: Readonly<
    Record<string, ChatSessionStoreHandle | null>
  >;
}

const EMPTY_WORKSPACE_FOLDERS = vi.hoisted<readonly string[]>(() =>
  Object.freeze([]),
);

const testState = vi.hoisted<TestState>(() => ({
  createChatMutate: vi.fn(),
  createArtifactMutate: vi.fn(),
  deleteArtifactMutateAsync: vi.fn(),
  deleteChatMutateAsync: vi.fn(),
  deleteTuiAgentMutateAsync: vi.fn(),
  exportArtifactsMutate: vi.fn(),
  localDeleteArtifact: vi.fn(),
  closeCanvasTab: vi.fn(),
  markArtifactSelfDeleted: vi.fn(),
  unmarkArtifactSelfDeleted: vi.fn(),
  sessionReady: true,
  snapshotLoaded: true,
  activeArtifactId: null,
  openTileContentIds: new Set<string>(),
  activePanelId: "chats",
  artifactFilterKinds: [],
  chatFilterOrigin: "all",
  chatFilterOwnership: "all",
  collapsedPanelIds: new Set<string>(),
  expandedIds: new Set<string>(),
  unreadArtifactIds: new Set<string>(),
  tree: {
    rootIds: [],
    childrenByParent: {},
    nodeById: {},
  },
  records: [],
  indicatorChats: {},
  activeAgentIds: new Set<string>(),
  activityTierById: new Map<string, "turn" | "background">(),
  chatHarnessIds: {},
  tuiHarnessIds: {},
  tuiAgentById: {},
  tuiProviderProfiles: [],
  permissionRole: "owner",
  archiveSupport: true,
  archiveVisibility: "unarchived",
  archivedIds: [],
  archiveMutate: vi.fn(),
  archiveBatchPending: false,
  archiveRowPending: false,
  archiveMutateAsync: vi.fn(),
  rowHostId: "host-1",
  rowHostReachability: "reachable",
  preparedOpenRefs: [],
  rowHostEntry: { hostId: "host-1" },
  rowHostClient: { getActiveHostId: () => "host-1" },
  activeHostClient: { getActiveHostId: () => "host-1" },
  sessionHandleByChatId: {},
}));

// The panel re-provides its own `StreamRuntimeContext` for the host its pin
// resolved to. `null` is that hook's FOLLOWING answer, so the panel falls back
// to the ambient binding this suite supplies - the client every assertion here
// is about. Which transport the pin resolves to is a different question, and
// it has its own suite: `use-surface-host-stream-binding.test.tsx`.
// The hook returns the value to PROVIDE: the ambient binding while following
// (this suite's), the pin's own once built, null while pending. Following here.
vi.mock("@/hooks/host/use-surface-host-stream-binding", async () => {
  const { use } = await import("react");
  const { StreamRuntimeContext } =
    await import("@/lib/host/stream-runtime-context");
  return { useSurfaceHostStreamBinding: () => use(StreamRuntimeContext) };
});

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/registries/chat-session-registry")
    >();
  return {
    ...actual,
    useExistingChatSessionHandle: (_epicId: string, chatId: string) =>
      testState.sessionHandleByChatId[chatId] ?? null,
  };
});

// The artifact panel now hosts a search box; keep its host query inert so these
// tree-focused tests need no QueryClient. An empty query renders no results.
vi.mock("@/hooks/epic/use-epic-search-artifacts-query", () => ({
  useEpicSearchArtifacts: () => ({
    isSuccess: false,
    isError: false,
    isFetching: false,
    data: undefined,
    error: null,
    refetch: () => undefined,
  }),
}));

vi.mock("@/components/epic-canvas/dnd/epic-canvas-dnd-context-value", () => ({
  useEpicCanvasDnd: () => ({
    activeSource: null,
    dropPreview: null,
    interactionLocked: false,
    clearDropPreview: () => undefined,
  }),
}));

vi.mock("@/components/epic-canvas/snapshots/snapshot-loading-context", () => ({
  SnapshotGate: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/epic-canvas/add-node-dropdown", () => ({
  AddNodeDropdown: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/epic-canvas/add-node-options", () => ({
  CHAT_PANEL_EXCLUDED_TYPES: [],
  ARTIFACT_PANEL_EXCLUDED_TYPES: [],
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-filter-menu", () => ({
  ChatFilterMenu: (props: { readonly onCollapseAll: () => void }) => (
    <>
      <button type="button">Chat filter</button>
      <button
        type="button"
        data-testid="epic-sidebar-collapse-all-chats"
        onClick={props.onCollapseAll}
      >
        Collapse all agents
      </button>
    </>
  ),
  ArtifactFilterMenu: (props: {
    readonly onCollapseAll: () => void;
    readonly onMarkAllRead: () => void;
    readonly markAllReadDisabled: boolean;
  }) => (
    <>
      <button type="button">Artifact filter</button>
      <button
        type="button"
        data-testid="epic-sidebar-collapse-all-artifacts"
        onClick={props.onCollapseAll}
      >
        Collapse all artifacts
      </button>
      <button
        type="button"
        disabled={props.markAllReadDisabled}
        onClick={props.onMarkAllRead}
      >
        Mark all unread artifacts as read
      </button>
    </>
  ),
}));

vi.mock("@/components/epic-canvas/sidebar/epic-terminal-sidebar", () => ({
  TerminalsPanelActions: () => null,
  TerminalsPanelBody: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-panel-body-live", () => ({
  GitDiffPanelBodyLive: () => null,
}));

vi.mock("@/components/epic-canvas/git-diff/git-diff-panel-actions", () => ({
  GitDiffPanelActions: () => null,
}));

vi.mock(
  "@/components/epic-canvas/hooks/use-terminal-agent-worktree-gate",
  () => ({
    useTerminalAgentWorktreeGate: () => ({
      isPending: false,
      requestCreate: vi.fn(),
    }),
  }),
);

vi.mock("@/components/worktree/worktree-owner-metadata", () => ({
  WorktreeOwnerMetadataTooltip: (props: { readonly trigger: ReactNode }) =>
    props.trigger,
}));

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: testState.indicatorChats },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { readonly children: ReactNode }) => props.children,
  DropdownMenuTrigger: (props: { readonly children: ReactNode }) =>
    props.children,
  DropdownMenuContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  // Forwards `aria-disabled` as well as `disabled`: real Radix renders a
  // `<div role="menuitem" aria-disabled>`, and an entry that carries a
  // disabled-reason is soft-disabled through ARIA alone (so it stays
  // keyboard-reachable). A mock that dropped it would report every such entry
  // as ENABLED and quietly invert the assertions that depend on it.
  DropdownMenuItem: (props: {
    readonly children: ReactNode;
    readonly onSelect: () => void;
    readonly "data-testid": string;
    readonly disabled: boolean;
    // `undefined` is not padding: a HARD-disabled entry OMITS the key entirely
    // so Radix's own derived `aria-disabled` survives, and only a soft-disabled
    // one spreads `true`. Declaring it as a required boolean would describe a
    // shape the production component never emits.
    readonly "aria-disabled": boolean | undefined;
    readonly "aria-describedby": string | undefined;
  }) => (
    <button
      type="button"
      role="menuitem"
      data-testid={props["data-testid"]}
      disabled={props.disabled}
      aria-disabled={props["aria-disabled"]}
      aria-describedby={props["aria-describedby"]}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: (props: { readonly children: ReactNode }) => props.children,
  TooltipTrigger: (props: { readonly children: ReactNode }) => props.children,
  // `role="tooltip"` so `tooltipTextIn` can find the label this mock renders
  // eagerly (the real content only exists while the tooltip is open).
  TooltipContent: (props: { readonly children: ReactNode }) => (
    <div role="tooltip">{props.children}</div>
  ),
}));

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: (props: {
    readonly children: ReactNode;
    readonly "data-testid": string;
    readonly "data-left-panel-id": string;
  }) => (
    <aside
      data-testid={props["data-testid"]}
      data-left-panel-id={props["data-left-panel-id"]}
    >
      {props.children}
    </aside>
  ),
  SidebarContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SidebarGroup: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  SidebarGroupContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

// The row's unreachable-owner lock reads the host directory through
// `useHostReachability`; this harness mounts no HostRuntimeProvider, so mock
// at the hook boundary. "reachable" everywhere = the pre-lock rendering, so
// every existing assertion is exercised unchanged; the lock's own behavior is
// pinned where the directory is faked per-entry (host-binding.test.ts).
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: testState.rowHostReachability,
    hostLabel: hostId,
  }),
}));

vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: () => null,
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({
    data: { binding: null, missingWorktreePaths: [] },
    isError: false,
    isPending: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicArchiveChats: () => ({
    isPending: testState.archiveBatchPending,
    mutate: (
      variables: {
        readonly epicId: string;
        readonly chatIds: readonly string[];
        readonly archived: boolean;
      },
      options: {
        readonly onSuccess: (
          results: readonly PromiseSettledResult<unknown>[],
        ) => void;
      },
    ) => {
      testState.archiveBatchPending = true;
      void Promise.allSettled(
        variables.chatIds.map((chatId) =>
          testState.archiveMutateAsync({
            epicId: variables.epicId,
            chatId,
            archived: variables.archived,
          }),
        ),
      ).then((results) => {
        testState.archiveBatchPending = false;
        options.onSuccess(results);
      });
    },
  }),
  useEpicArchiveChat: () => ({
    mutate: testState.archiveMutate,
    mutateAsync: testState.archiveMutateAsync,
    isPending: testState.archiveRowPending,
  }),
  useEpicCreateChatForHostClient: () => ({
    mutate: testState.createChatMutate,
    isPending: false,
  }),
  useEpicDeleteChat: () => ({
    mutate: vi.fn(),
    mutateAsync: testState.deleteChatMutateAsync,
    isPending: false,
  }),
  useEpicRenameChat: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    create: vi.fn(() => Promise.resolve(null)),
    isPending: false,
  }),
}));

/**
 * The two host queries behind the unified list's cloud rows, stubbed to
 * "nothing to add".
 *
 * The chat panel reads both directly now that the "other devices" section is
 * gone, and both are ordinary host queries - so leaving them real would need
 * this suite to supply a `QueryClientProvider` and a host-client stub complete
 * enough for `useReactiveHostReadiness`, for rows that do not render here
 * either way. The fold and the interleave they feed are asserted without a
 * renderer in `unified-chat-list.test.ts`.
 */
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/chats/use-cloud-chat-queries")
    >();
  return {
    ...actual,
    useCloudChatList: () => ({
      data: undefined,
      isError: false,
      isPending: true,
      isFetching: false,
      // DISABLED, which is what this harness would really produce: it mounts no
      // host client and no signed-in viewer, and the real hook gates on both. It
      // matters to the assertions below - the panel's empty state waits for the
      // list to have answered, and "it will never run" is an answer, while a
      // request still in flight is not.
      isEnabled: false,
    }),
    useCloudChatPayload: () => ({ data: undefined, isError: false }),
    useCloudChatViewerId: () => "",
    // The real predicate rather than a constant, so the stub above actually
    // decides: a hard-coded `true` here would hide the difference between "this
    // query will never run" and "its answer has not arrived yet", which is the
    // one distinction the panel's empty state depends on.
    isCloudChatListSettled: (query: {
      readonly isEnabled: boolean;
      readonly isSuccess: boolean;
      readonly isError: boolean;
    }) => !query.isEnabled || query.isSuccess || query.isError,
  };
});

// The fold's mapping. Stubbed alongside the list rather than left real for the
// same reason, and to `undefined` deliberately: that is the shape an older host
// (or an in-flight request) produces, so this suite exercises the degraded
// path the fold is specified to tolerate.
vi.mock("@/hooks/chats/use-chat-publication-targets", () => ({
  useChatPublicationTargets: () => ({ data: undefined, isError: false }),
  publicationTargetMap: () => new Map<string, string>(),
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => testState.activeHostClient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => testState.activeHostClient,
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => testState.rowHostClient,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => testState.rowHostEntry,
}));

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicCreateArtifact: () => ({
    mutate: testState.createArtifactMutate,
    isPending: false,
  }),
  useEpicDeleteArtifact: () => ({
    mutate: vi.fn(),
    mutateAsync: testState.deleteArtifactMutateAsync,
    isPending: false,
  }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/epic/use-epic-export-artifacts-mutation", () => ({
  useEpicExportArtifacts: () => ({
    mutate: testState.exportArtifactsMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicDeleteTuiAgent: () => ({
    mutate: vi.fn(),
    mutateAsync: testState.deleteTuiAgentMutateAsync,
    isPending: false,
  }),
  useEpicRenameTuiAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => {
    if (!testState.sessionReady) {
      throw new Error(
        "useOpenEpicHandle must be called inside <EpicSessionProvider>.",
      );
    }
    return {
      epicId: "epic-1",
      store: {
        getState: () => ({
          deleteArtifact: testState.localDeleteArtifact,
          renameArtifact: vi.fn(),
        }),
        subscribe: () => () => undefined,
      },
    };
  },
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  findOpenArtifactInTab: () => null,
  useActiveEpicArtifactId: () => testState.activeArtifactId,
  useEpicCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({
      closeCanvasTab: testState.closeCanvasTab,
      markArtifactSelfDeleted: testState.markArtifactSelfDeleted,
      openTileInTab: vi.fn(),
      openTilePreviewInTab: vi.fn(),
      prepareOpenTilePreviewInTabFocusTarget: (
        _tabId: string,
        ref: { type: string; id: string; hostId: string },
      ) => {
        testState.preparedOpenRefs.push({
          type: ref.type,
          id: ref.id,
          hostId: ref.hostId,
        });
        return null;
      },
      prepareOpenTileInTabFocusTarget: (
        _tabId: string,
        ref: { type: string; id: string; hostId: string },
      ) => {
        testState.preparedOpenRefs.push({
          type: ref.type,
          id: ref.id,
          hostId: ref.hostId,
        });
        return null;
      },
      pendingRootCreatesByEpic: {},
      preAckRootCreatesByEpic: {},
      promotePreviewInTab: vi.fn(),
      renameArtifactInTab: vi.fn(),
      unmarkArtifactSelfDeleted: testState.unmarkArtifactSelfDeleted,
    }),
  useIsActiveEpicArtifact: () => false,
  useOpenTileContentIds: () => testState.openTileContentIds,
}));

vi.mock("@/stores/epics/epic-sidebar-expansion-store", () => ({
  useEpicSidebarEffectiveExpanded: () => testState.expandedIds,
  useEpicSidebarExpansionStore: (selector: (state: unknown) => unknown) =>
    selector({
      collapse: vi.fn(),
      collapseAll: vi.fn(),
      expand: vi.fn(),
    }),
}));

vi.mock("@/stores/epics/left-panel-store", () => ({
  CHAT_ARCHIVE_VISIBILITY: {
    Unarchived: "unarchived",
    Archived: "archived",
    All: "all",
  },
  CHAT_OWNERSHIP: {
    All: "all",
    Mine: "mine",
    Others: "others",
  },
  CHAT_ORIGIN: {
    All: "all",
    Gui: "gui",
    Tui: "tui",
  },
  DEFAULT_LEFT_PANEL_ID: "chats",
  isArtifactFilterActive: () => testState.artifactFilterKinds.length > 0,
  isChatFilterActive: () =>
    testState.chatFilterOrigin !== "all" ||
    testState.chatFilterOwnership !== "all",
  matchesChatOwnershipFilter: (
    isOwnedByViewer: boolean,
    ownership: "all" | "mine" | "others",
  ) =>
    ownership === "all" ||
    (ownership === "mine" ? isOwnedByViewer : !isOwnedByViewer),
  useAcknowledgedRootCreatePending: () => null,
  useActiveLeftPanelId: () => testState.activePanelId,
  useArtifactFilter: () => ({
    statuses: [],
    kinds: testState.artifactFilterKinds,
    read: "all",
  }),
  useArtifactSort: () => ({ field: "updated", direction: "desc" }),
  useChatFilter: () => ({
    origin: testState.chatFilterOrigin,
    ownership: testState.chatFilterOwnership,
  }),
  useChatArchiveVisibility: () => testState.archiveVisibility,
  useChatSort: () => ({ field: "updated", direction: "desc" }),
  useCommentsPanelRevealed: () => false,
  usePanelVisibilityOverrides: () => ({}),
  useEpicLeftPanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      clearAcknowledgedRootCreatePending: vi.fn(),
      clearLocalRootCreatePending: vi.fn(),
      panelSectionCollapsedByPanelId: {},
      setAcknowledgedRootCreatePending: vi.fn(),
      setActivePanelId: vi.fn(),
      setLocalRootCreatePending: vi.fn(),
      setPanelSectionWeights: vi.fn(),
      togglePanelSectionCollapsed: vi.fn(),
    }),
  useLeftPanelGroups: () => [{ panelIds: [testState.activePanelId] }],
  useLeftPanelSectionCollapsed: (panelId: string) =>
    testState.collapsedPanelIds.has(panelId),
  useLocalRootCreatePending: () => null,
}));

vi.mock("@/hooks/epic/use-chat-archive-support", () => ({
  SET_CHAT_ARCHIVED_METHOD: "epic.setChatArchived",
  useChatArchiveSupported: () => testState.archiveSupport === true,
  useChatArchiveSupportState: () => testState.archiveSupport,
}));

vi.mock("@/hooks/epic/use-chat-sharing-support", () => ({
  SET_CLOUD_CHAT_VISIBILITY_METHOD: "epic.setCloudChatVisibility",
  SET_CHAT_SHARING_DEFAULT_METHOD: "epic.setChatSharingDefault",
  useCloudChatVisibilitySupported: () => false,
  useChatSharingDefaultSupported: () => false,
}));

vi.mock("@/hooks/epic/use-epic-chat-visibility-mutations", () => ({
  useEpicSetCloudChatVisibility: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useEpicSetChatSharingDefault: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/epics/use-epic-collaborators-query", () => ({
  EPIC_COLLABORATORS_OPEN_REFRESH_MS: 5 * 60_000,
  useEpicCollaboratorsQuery: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    query: { dataUpdatedAt: 0, refetch: vi.fn() },
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useAncestorIds: () => new Set<string>(),
  useChildIds: (parentId: string) =>
    testState.tree.childrenByParent[parentId] ?? [],
  useEpicActiveAgentIds: () => testState.activeAgentIds,
  useEpicAgentRoleClaims: () => [],
  // Awareness reports a tier per working agent. An agent whose host did not
  // classify it reads as "turn", so tests that only set `activeAgentIds` keep
  // their pre-tier behaviour.
  useEpicAgentActivityTiers: () =>
    new Map(
      [...testState.activeAgentIds].map((id) => [
        id,
        testState.activityTierById.get(id) ?? "turn",
      ]),
    ),
  useEpicArtifact: (artifactId: string | null) => {
    if (artifactId === null) return null;
    const node = testState.tree.nodeById[artifactId];
    if (node === undefined) return null;
    return {
      id: node.id,
      kind: node.type,
      title: node.title,
      updatedAt: node.updatedAt,
    };
  },
  useEpicArchivedNodeIds: () => testState.archivedIds,
  useEpicArtifactRecords: () => testState.records,
  // Dedup input for the cloud-chat section. Empty: this suite is about the
  // LOCAL tree, and the section hides itself when the cloud list has nothing
  // to add - which, with no host client bound here, it never does.
  useEpicChatIds: () => [],
  useEpicArtifactStatus: (artifactId: string) =>
    testState.tree.nodeById[artifactId]?.status ?? null,
  useEpicChatHarnessId: (nodeId: string) =>
    testState.chatHarnessIds[nodeId] ?? null,
  useEpicConnectionStatus: () => "open",
  useEpicNodeArchived: (nodeId: string) =>
    testState.archivedIds.includes(nodeId),
  useEpicNodeHostId: () => testState.rowHostId,
  useEpicNodeOwnerUserId: () => "user-1",
  useEpicNodeOwnerKind: () => "chat",
  // The row's last-activity time. Production reads the chat/TUI PROJECTION
  // rather than the tree node (the node's copy lags - see the selector's doc),
  // but these fixtures only ever set it on the node, so the fake sources it
  // from there. Rows without one read 0, which the row renders as no time.
  useEpicNodeUpdatedAt: (nodeId: string) =>
    testState.tree.nodeById[nodeId]?.updatedAt ?? 0,
  // Stable empty array (reference-stable across renders) so the chat-row seed
  // effect's dependency never changes and it never seeds in these tests.
  useEpicNodeWorkspaceFolders: () => EMPTY_WORKSPACE_FOLDERS,
  useEpicPermissionRole: () => testState.permissionRole,
  useEpicSnapshotMeta: () => ({ epicLight: { title: "Test epic" } }),
  useEpicTreeIndex: () => testState.tree,
  useEpicTreeNode: (nodeId: string) => testState.tree.nodeById[nodeId] ?? null,
  useMaybeEpicTuiAgentHarnessId: (nodeId: string) =>
    testState.tuiHarnessIds[nodeId] ?? null,
  useRootIds: () => testState.tree.rootIds,
}));

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshotLoaded: testState.snapshotLoaded,
      artifacts: {
        allIds: testState.records
          .filter((record) => record.type !== "chat")
          .filter((record) => record.type !== "terminal-agent")
          .map((record) => record.id),
        byId: Object.fromEntries(
          testState.records.map((record) => [
            record.id,
            {
              id: record.id,
              kind: record.type,
              status: record.status,
              title: record.name,
              updatedAt: 1,
            },
          ]),
        ),
      },
      tuiAgents: {
        byId: Object.fromEntries(
          Object.entries(testState.tuiAgentById).flatMap(([id, agent]) => {
            if (agent === undefined) return [];
            return [
              [
                id,
                {
                  id,
                  hostId: agent.hostId,
                  profileId: agent.profileId,
                },
              ],
            ];
          }),
        ),
      },
    }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => testState.rowHostClient,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: {
      providers: [
        {
          // Wire id for the `claude` / `codex` harnesses used in identity tests.
          // Codex is not multi-profile here; claude-code carries the profiles
          // the managed-badge case resolves against.
          providerId: "claude-code",
          profiles: testState.tuiProviderProfiles.map((entry) => ({
            profileId: entry.profileId,
            kind: entry.kind,
            authType: "oauth",
            label: entry.label,
            auth: {
              status: "authenticated",
              badgeText: null,
              label: null,
              detail: null,
            },
            identity: null,
            usageUpdatedAt: null,
            rateLimitStatus: "unknown",
            rateLimitLimitedScopes: null,
            duplicateOfProfileId: null,
            accentColor: null,
            ambientDriftNotice: null,
          })),
        },
      ],
    },
  }),
}));

const seedEpicArtifacts = vi.hoisted(() => vi.fn());
const markRead = vi.hoisted(() => vi.fn());
const useArtifactReadStateStoreMock = vi.hoisted(() => {
  const store = Object.assign(
    vi.fn((selector: (state: unknown) => unknown) =>
      selector({
        lastSeenByArtifact: {},
        markRead,
        seedAtByEpic: {},
        seedEpicArtifacts,
      }),
    ),
    {
      getState: () => ({
        lastSeenByArtifact: {},
        markRead,
        seedAtByEpic: {},
        seedEpicArtifacts,
      }),
    },
  );
  return store;
});

vi.mock("@/stores/epics/artifact-read-state-store", () => ({
  isArtifactUnread: (args: { readonly artifactId: string }) =>
    testState.unreadArtifactIds.has(args.artifactId),
  useArtifactReadStateStore: useArtifactReadStateStoreMock,
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      artifactIconColorMode: "none",
      artifactIconColors: {
        chat: undefined,
        review: undefined,
        spec: undefined,
        story: undefined,
        ticket: undefined,
        "terminal-agent": undefined,
      },
    }),
}));

import {
  EpicLeftPanelHost,
  EpicLeftPanelLoadingHost,
} from "@/components/epic-canvas/sidebar/epic-sidebar";
import {
  BASE_PAD_LEFT,
  INDENT_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";

const TAB_ID = "tab-1";
const EPIC_ID = "epic-1";

describe("epic sidebar selection mode", () => {
  beforeEach(() => {
    testState.archiveMutateAsync.mockResolvedValue({ updated: true });
    testState.deleteArtifactMutateAsync.mockResolvedValue({});
    testState.deleteChatMutateAsync.mockResolvedValue({});
    testState.deleteTuiAgentMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.sessionReady = true;
    testState.snapshotLoaded = true;
    testState.activeArtifactId = null;
    testState.openTileContentIds = new Set<string>();
    testState.activePanelId = "chats";
    testState.artifactFilterKinds = [];
    testState.chatFilterOrigin = "all";
    testState.chatFilterOwnership = "all";
    testState.collapsedPanelIds = new Set<string>();
    testState.expandedIds = new Set<string>();
    testState.unreadArtifactIds = new Set<string>();
    testState.tree = {
      rootIds: [],
      childrenByParent: {},
      nodeById: {},
    };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.chatHarnessIds = {};
    testState.tuiHarnessIds = {};
    testState.permissionRole = "owner";
    testState.archiveSupport = true;
    testState.archiveVisibility = "unarchived";
    testState.archivedIds = [];
    testState.archiveMutate = vi.fn();
    testState.archiveBatchPending = false;
    testState.archiveRowPending = false;
    testState.archiveMutateAsync = vi.fn();
    testState.rowHostId = "host-1";
    testState.rowHostReachability = "reachable";
    testState.preparedOpenRefs = [];
    testState.rowHostEntry = { hostId: "host-1" };
    testState.rowHostClient = { getActiveHostId: () => "host-1" };
    testState.activeHostClient = { getActiveHostId: () => "host-1" };
    testState.sessionHandleByChatId = {};
    useNewConversationModalStore.getState().resetForTests();
    useNewConversationModalOpenStore.getState().close();
    useAppDialogStore.getState().closeDialog();
  });

  it("selects chat rows explicitly and bulk-deletes topmost selected chat roots", async () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const startSelectionButton = screen.getByRole("menuitem", {
      name: "Select agents",
    });
    expect(startSelectionButton.textContent).toBe("Select agents");
    expect(screen.queryByTestId("epic-sidebar-select-chat-root")).toBeNull();

    fireEvent.click(startSelectionButton);
    const chatCheckbox = screen.getByTestId("epic-sidebar-select-chat-root");
    expect(
      screen.getByTestId("epic-sidebar-item-chat-root").style.paddingLeft,
    ).toBe(`${BASE_PAD_LEFT}px`);
    expect(
      screen.getByTestId("epic-sidebar-item-chat-child").style.paddingLeft,
    ).toBe(`${INDENT_PX + BASE_PAD_LEFT}px`);
    expect(chatCheckbox.matches(":checked")).toBe(false);
    fireEvent.click(chatCheckbox);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-chats")
        .matches(":disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => checkbox.matches(":checked")),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("epic-sidebar-delete-selected-chats"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteChatMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        chatId: "chat-root",
      });
    });
    expect(testState.deleteChatMutateAsync).not.toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: "chat-child",
    });
    expect(testState.deleteTuiAgentMutateAsync).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      tuiAgentId: "agent-root",
    });
  });

  it("archives the topmost selected agents and exits selection mode", async () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-archive-selected-chats"));

    await waitFor(() => {
      expect(testState.archiveMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        chatId: "chat-root",
        archived: true,
      });
      expect(testState.archiveMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        chatId: "agent-root",
        archived: true,
      });
    });
    expect(testState.archiveMutateAsync).not.toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: "chat-child",
      archived: true,
    });
    expect(
      screen.queryByRole("button", { name: "Cancel selection" }),
    ).toBeNull();
  });

  it("exits selection after projection prunes archived rows before the batch settles", async () => {
    let resolveArchive: (value: { readonly updated: boolean }) => void = () => {
      throw new Error("Archive resolver is unavailable");
    };
    const archivePromise = new Promise<{ readonly updated: boolean }>(
      (resolve) => {
        resolveArchive = resolve;
      },
    );
    testState.archiveMutateAsync.mockReturnValue(archivePromise);
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    fireEvent.click(screen.getByTestId("epic-sidebar-archive-selected-chats"));

    testState.archivedIds = ["chat-root"];
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Cancel selection" }),
      ).toBeTruthy();
    });

    resolveArchive({ updated: true });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Cancel selection" }),
      ).toBeNull();
    });
  });

  it("preserves agents selected while an archive batch is pending", async () => {
    let resolveArchive: (value: { readonly updated: boolean }) => void = () => {
      throw new Error("Archive resolver is unavailable");
    };
    const archivePromise = new Promise<{ readonly updated: boolean }>(
      (resolve) => {
        resolveArchive = resolve;
      },
    );
    testState.archiveMutateAsync.mockReturnValue(archivePromise);
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    fireEvent.click(screen.getByTestId("epic-sidebar-archive-selected-chats"));
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByRole("button", { name: "Select all" }).matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Cancel selection" })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-chats")
        .matches(":disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("epic-sidebar-select-agent-root"));

    resolveArchive({ updated: true });

    await waitFor(() => {
      expect(
        screen.getByTestId("epic-sidebar-select-chat-root").matches(":checked"),
      ).toBe(false);
      expect(
        screen
          .getByTestId("epic-sidebar-select-agent-root")
          .matches(":checked"),
      ).toBe(true);
    });
    expect(
      screen.getByRole("button", { name: "Cancel selection" }),
    ).toBeTruthy();
  });

  it("clears descendants selected before an archive response whose projection lands later", async () => {
    let resolveArchive: (value: { readonly updated: boolean }) => void = () => {
      throw new Error("Archive resolver is unavailable");
    };
    const archivePromise = new Promise<{ readonly updated: boolean }>(
      (resolve) => {
        resolveArchive = resolve;
      },
    );
    testState.archiveMutateAsync.mockReturnValue(archivePromise);
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    fireEvent.click(screen.getByTestId("epic-sidebar-archive-selected-chats"));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-child"));

    resolveArchive({ updated: true });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Cancel selection" }),
      ).toBeNull();
    });

    testState.archivedIds = ["chat-root"];
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Cancel selection" }),
      ).toBeNull();
    });
  });

  it("clears descendants added while an archive request is pending", async () => {
    let resolveArchive: (value: { readonly updated: boolean }) => void = () => {
      throw new Error("Archive resolver is unavailable");
    };
    const archivePromise = new Promise<{ readonly updated: boolean }>(
      (resolve) => {
        resolveArchive = resolve;
      },
    );
    testState.archiveMutateAsync.mockReturnValue(archivePromise);
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    fireEvent.click(screen.getByTestId("epic-sidebar-archive-selected-chats"));

    const addedChild = treeNode(
      "chat-added-child",
      "chat-root",
      "Added child",
      "chat",
    );
    testState.tree = {
      rootIds: testState.tree.rootIds,
      childrenByParent: {
        ...testState.tree.childrenByParent,
        "chat-root": ["chat-child", addedChild.id],
      },
      nodeById: {
        ...testState.tree.nodeById,
        [addedChild.id]: addedChild,
      },
    };
    testState.records = [...testState.records, recordFromNode(addedChild)];
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    fireEvent.click(screen.getByTestId(`epic-sidebar-select-${addedChild.id}`));

    resolveArchive({ updated: true });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Cancel selection" }),
      ).toBeNull();
    });

    testState.archivedIds = ["chat-root"];
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByRole("button", { name: "Cancel selection" }),
    ).toBeNull();
  });

  it("preserves selected descendants reparented out of an archive request", async () => {
    let resolveArchive: (value: { readonly updated: boolean }) => void = () => {
      throw new Error("Archive resolver is unavailable");
    };
    const archivePromise = new Promise<{ readonly updated: boolean }>(
      (resolve) => {
        resolveArchive = resolve;
      },
    );
    testState.archiveMutateAsync.mockReturnValue(archivePromise);
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    fireEvent.click(screen.getByTestId("epic-sidebar-archive-selected-chats"));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-child"));

    const reparentedChild = treeNode("chat-child", null, "Child chat", "chat");
    testState.tree = {
      rootIds: ["chat-root", reparentedChild.id, "agent-root"],
      childrenByParent: { "chat-root": [] },
      nodeById: {
        ...testState.tree.nodeById,
        [reparentedChild.id]: reparentedChild,
      },
    };
    testState.records = testState.records.map((record) =>
      record.id === reparentedChild.id
        ? recordFromNode(reparentedChild)
        : record,
    );
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    resolveArchive({ updated: true });

    await waitFor(() => {
      expect(
        screen.getByTestId("epic-sidebar-select-chat-root").matches(":checked"),
      ).toBe(false);
      expect(
        screen
          .getByTestId("epic-sidebar-select-chat-child")
          .matches(":checked"),
      ).toBe(true);
    });
    expect(
      screen.getByRole("button", { name: "Cancel selection" }),
    ).toBeTruthy();

    testState.archivedIds = ["chat-root"];
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
    expect(
      screen.getByTestId("epic-sidebar-select-chat-child").matches(":checked"),
    ).toBe(true);
  });

  it("hides the bulk archive action when the host lacks archive support", () => {
    seedChatTree();
    testState.archiveSupport = false;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));

    expect(
      screen.queryByTestId("epic-sidebar-archive-selected-chats"),
    ).toBeNull();
  });

  it("keeps bulk archive disabled while a selected agent is working", () => {
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-root"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));

    expect(
      screen
        .getByTestId("epic-sidebar-archive-selected-chats")
        .matches(":disabled"),
    ).toBe(true);
  });

  it("keeps bulk archive disabled for an active collapsed descendant", () => {
    seedChatTree();
    testState.expandedIds = new Set<string>();
    testState.activeAgentIds = new Set(["chat-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));

    expect(screen.queryByTestId("epic-sidebar-select-chat-child")).toBeNull();
    expect(
      screen
        .getByTestId("epic-sidebar-archive-selected-chats")
        .matches(":disabled"),
    ).toBe(true);
  });

  it("toggles the Select all button to Deselect all once everything is selected", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));

    // Nothing selected yet: the button offers "Select all".
    expect(screen.queryByRole("button", { name: "Deselect all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => checkbox.matches(":checked")),
    ).toBe(true);
    // All selected: the button flips to "Deselect all".
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));

    // Back to nothing selected, but still in selection mode (checkboxes stay
    // rendered) and the button reverts to "Select all".
    expect(
      screen
        .getAllByRole("checkbox")
        .every((checkbox) => !checkbox.matches(":checked")),
    ).toBe(true);
    expect(
      screen.queryByTestId("epic-sidebar-select-chat-root"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Select all" })).not.toBeNull();
  });

  it("gives selection controls the full header row without changing its height", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const section = screen.getByTestId("epic-left-panel-section-chats");
    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));

    const selectionHeader = section.querySelector(
      '[data-panel-header-mode="selection"]',
    );
    expect(selectionHeader).not.toBeNull();
    expect(selectionHeader?.className).toContain("h-9");
    expect(
      screen.getByRole("button", { name: "Cancel selection" }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel selection" }));
    expect(
      section.querySelector('[data-panel-header-mode="selection"]'),
    ).toBeNull();
    expect(screen.getByText("Agents")).not.toBeNull();
  });

  it("keeps artifact header actions in stable create, more, filter order", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const section = screen.getByTestId("epic-left-panel-section-artifacts");
    expect(section.firstElementChild?.className).toContain("@container");
    const add = screen.getByRole("button", { name: "Add artifact" });
    const more = screen.getByTestId("epic-sidebar-more-artifacts");
    const filter = screen.getByRole("button", { name: "Artifact filter" });
    expect(add.compareDocumentPosition(more)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(more.compareDocumentPosition(filter)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(more.className).not.toContain("hidden");

    fireEvent.click(screen.getByRole("menuitem", { name: "Select artifacts" }));
    expect(
      screen.getByTestId("epic-sidebar-artifact-selection-count").className,
    ).toContain("@max-[21rem]:hidden");
    expect(
      section.querySelector('[data-panel-header-mode="selection"]'),
    ).not.toBeNull();
  });

  it("keeps the communication graph available in the Agents overflow", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.getByRole("menuitem", { name: "Open communication graph" }),
    ).not.toBeNull();
  });

  it("renders loading chat and artifact panels before the epic session handle exists", () => {
    testState.sessionReady = false;

    render(
      <EpicLeftPanelLoadingHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    expect(screen.getByTestId("epic-sidebar")).not.toBeNull();
  });

  it("names the primary panel Agents and offers an interface choice when empty", () => {
    testState.activePanelId = "chats";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByText("Agents")).not.toBeNull();
    expect(screen.getByTestId("epic-chat-sidebar-empty")).not.toBeNull();
    expect(screen.getByText("No agents yet.")).not.toBeNull();
    expect(
      screen.getByText("Add an agent and choose a Chat or Terminal interface."),
    ).not.toBeNull();
    expect(screen.queryByText("No agents use this interface.")).toBeNull();
  });

  it("exposes each full agent title on hover without worktree metadata", () => {
    seedChatTree();
    testState.rowHostId = null;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByRole("tooltip", { name: "Root chat" })).toBeTruthy();
    expect(
      screen.getByRole("tooltip", { name: "Terminal agent" }),
    ).toBeTruthy();
  });

  it("blames the interface filter, not the Task, when a filter hides every agent", () => {
    seedGuiChatTree();
    testState.chatFilterOrigin = "tui";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-chat-sidebar-filter-empty")).not.toBeNull();
    // The Task HAS agents - they just use the other interface. The empty state
    // must not read as "this Task has no agents".
    expect(
      screen.getByText("No matches for the current filters."),
    ).not.toBeNull();
    expect(
      screen.getByText("The Interface filter is hiding the other agents."),
    ).not.toBeNull();
    expect(screen.queryByText("No agents yet.")).toBeNull();
  });

  it("hides local agents as Mine when the Ownership filter selects Others", () => {
    seedChatTree();
    testState.chatFilterOwnership = "others";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-item-agent-root")).toBeNull();
    expect(screen.getByTestId("epic-chat-sidebar-filter-empty")).toBeTruthy();
    expect(
      screen.getByText("The Ownership filter is hiding the other agents."),
    ).toBeTruthy();
  });

  it("shows the empty artifact panel state when there are no artifacts", () => {
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-artifact-sidebar-empty")).not.toBeNull();
    expect(screen.getByText("No artifacts yet.")).not.toBeNull();
    expect(screen.queryByText("No artifacts match the filter.")).toBeNull();
  });

  it("shows the filtered artifact empty state when no artifacts match the filter", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.artifactFilterKinds = ["review"];

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.getByTestId("epic-artifact-sidebar-filter-empty"),
    ).not.toBeNull();
    expect(
      screen.getByText("No matches for the current filters."),
    ).not.toBeNull();
    expect(screen.queryByText("No artifacts yet.")).toBeNull();
  });

  it("hides sidebar bulk selection for viewer roles", () => {
    seedChatTree();
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.queryByRole("menuitem", { name: "Select agents" }),
    ).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-select-chat-root")).toBeNull();
  });

  it("uses the shared chat menu for terminal-agent row actions", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-more-agent-root")).not.toBeNull();
    expect(screen.getByTestId("epic-sidebar-rename-agent-root")).not.toBeNull();
    expect(screen.getByTestId("epic-sidebar-delete-agent-root")).not.toBeNull();
    expect(screen.getByTestId("epic-sidebar-more-chat-root")).not.toBeNull();
  });

  it("renders chat glyph (never harness brand) on chat rows and harness brand on idle TUI rows", () => {
    seedChatTree();
    testState.chatHarnessIds = {
      "chat-root": "codex",
      "chat-child": "claude",
    };
    testState.tuiHarnessIds = { "agent-root": "codex" };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // Chat rows deliberately keep the plain chat glyph even when a harness id
    // is known - brand marks are a TUI-only leading-icon affordance.
    const chatRow = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(chatRow.querySelector(".lucide-message-square")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-agent-harness-chat-root")).toBeNull();
    expect(screen.queryByTestId("sidebar-agent-surface-chat-root")).toBeNull();

    // Idle TUI rows wear the harness brand + terminal surface subscript.
    expect(
      screen.getByTestId("sidebar-agent-harness-agent-root"),
    ).not.toBeNull();
    expect(
      screen.getByTestId("sidebar-agent-surface-agent-root"),
    ).not.toBeNull();
  });

  it("consolidates row actions into one menu with 'New child agent' first, reachable from both the ⋯ dropdown and right-click", async () => {
    seedChatTree();
    useNewConversationModalStore
      .getState()
      .setComposerMode(EPIC_ID, "terminal");

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // The standalone hover "+" is gone; "New child agent" now lives in the
    // consolidated row menu, reachable via the ⋯ dropdown...
    const chatRow = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(
      chatRow.parentElement?.querySelector('[aria-label="Add child agent"]'),
    ).toBeNull();
    expect(
      screen.getByTestId("epic-sidebar-new-child-chat-root"),
    ).not.toBeNull();

    // ...and via the right-click context menu, both seeded with this row as
    // parent.
    fireEvent.contextMenu(chatRow);
    expect(
      await screen.findByTestId("epic-sidebar-context-new-child-chat-root"),
    ).not.toBeNull();
    const newChildAgent = screen.getByRole("menuitem", {
      name: "New child agent",
    });
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete" })).not.toBeNull();

    fireEvent.click(newChildAgent);

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID]
        ?.composerMode,
    ).toBe("terminal");
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      parentId: "chat-root",
    });
  });

  it("keeps artifact add inline and exposes ellipsis actions on right-click", async () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-add-spec-root")).not.toBeNull();
    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-spec-root"));

    expect(
      await screen.findByRole("menuitem", { name: "Export as Markdown" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Rename" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete" })).not.toBeNull();
  });

  it("enters chat selection mode from cmd-click on a row", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-select-chat-root")).toBeNull();

    fireEvent.click(screen.getByTestId("epic-sidebar-item-chat-root"), {
      metaKey: true,
    });

    expect(
      screen.getByTestId("epic-sidebar-select-chat-root").matches(":checked"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-chats")
        .matches(":disabled"),
    ).toBe(false);
  });

  it("clears chat selection when the section collapses", async () => {
    seedChatTree();

    const { rerender } = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-chats")
        .matches(":disabled"),
    ).toBe(false);

    testState.collapsedPanelIds = new Set(["chats"]);
    rerender(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("epic-sidebar-delete-selected-chats"),
      ).toBeNull();
    });
    expect(
      screen
        .getByRole("menuitem", { name: "Select agents" })
        .matches(":disabled"),
    ).toBe(true);
  });

  it("keeps collapsed chat header entry points available", () => {
    seedChatTree();
    testState.collapsedPanelIds = new Set(["chats"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.getByRole("button", { name: "Chat filter" }).matches(":disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "More agent actions" })
        .matches(":disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Add agent" }).matches(":disabled"),
    ).toBe(false);
  });

  it("keeps collapsed artifact header entry points available", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.collapsedPanelIds = new Set(["artifacts"]);
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByRole("button", { name: "Artifact filter" })
        .matches(":disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "More artifact actions" })
        .matches(":disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Add artifact" }).matches(":disabled"),
    ).toBe(false);
  });

  it("hides artifact selection when there are no artifacts to select", () => {
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByRole("menuitem", { name: "Select artifacts" })
        .matches(":disabled"),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Add artifact" }),
    ).not.toBeNull();
  });

  it("disables mark-all-read when no artifacts are unread", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    const { rerender } = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    const markAllReadButton = screen.getByRole("button", {
      name: "Mark all unread artifacts as read",
    });

    expect(markAllReadButton.matches(":disabled")).toBe(true);

    testState.unreadArtifactIds = new Set(["ticket-child"]);
    rerender(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByRole("button", {
          name: "Mark all unread artifacts as read",
        })
        .matches(":disabled"),
    ).toBe(false);

    testState.unreadArtifactIds = new Set<string>();
    rerender(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen
        .getByRole("button", {
          name: "Mark all unread artifacts as read",
        })
        .matches(":disabled"),
    ).toBe(true);
  });

  it("marks every unread artifact read from the artifact header action", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.unreadArtifactIds = new Set(["spec-root", "ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Mark all unread artifacts as read",
      }),
    );

    expect(markRead).toHaveBeenCalledWith(EPIC_ID, "spec-root", 2);
    expect(markRead).toHaveBeenCalledWith(EPIC_ID, "ticket-child", 2);
  });

  it("exports one artifact from its row actions for viewers", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(
      screen.getByTestId("epic-sidebar-export-markdown-spec-root"),
    );

    expect(testState.exportArtifactsMutate).toHaveBeenCalledWith({
      archive: false,
      archiveTitle: null,
      artifacts: [{ id: "spec-root", title: "Root spec" }],
      format: "markdown",
    });
    expect(
      screen.getByTestId("epic-sidebar-rename-spec-root").matches(":disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("epic-sidebar-delete-spec-root").matches(":disabled"),
    ).toBe(true);
  });

  it("bulk-exports every selected visible artifact, including descendants", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select artifacts" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-spec-root"));
    expect(
      screen
        .getByTestId("epic-sidebar-export-selected-markdown")
        .matches(":disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("epic-sidebar-select-ticket-child"));
    expect(
      screen
        .getByTestId("epic-sidebar-export-selected-markdown")
        .matches(":disabled"),
    ).toBe(false);
    fireEvent.click(
      screen.getByTestId("epic-sidebar-export-selected-markdown"),
    );

    expect(testState.exportArtifactsMutate).toHaveBeenCalledWith({
      archive: true,
      archiveTitle: "Test epic",
      artifacts: [
        { id: "spec-root", title: "Root spec" },
        { id: "ticket-child", title: "Child ticket" },
      ],
      format: "markdown",
    });
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-artifacts")
        .matches(":disabled"),
    ).toBe(true);
  });

  it("selects artifact rows explicitly and bulk-deletes topmost selected artifacts", async () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select artifacts" }));
    expect(
      screen.getByTestId("epic-sidebar-item-ticket-child").style.paddingLeft,
    ).toBe(`${INDENT_PX + BASE_PAD_LEFT}px`);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-artifacts")
        .matches(":disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(
      screen.getByTestId("epic-sidebar-delete-selected-artifacts"),
    );
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteArtifactMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        artifactId: "spec-root",
      });
    });
    expect(testState.deleteArtifactMutateAsync).not.toHaveBeenCalledWith({
      epicId: EPIC_ID,
      artifactId: "ticket-child",
    });
  });

  it("enters artifact selection mode from cmd-click on a row", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-select-spec-root")).toBeNull();

    fireEvent.click(screen.getByTestId("epic-sidebar-item-spec-root"), {
      metaKey: true,
    });

    expect(
      screen.getByTestId("epic-sidebar-select-spec-root").matches(":checked"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("epic-sidebar-delete-selected-artifacts")
        .matches(":disabled"),
    ).toBe(false);
  });

  it("renders nested unread markers inside the artifact row title area", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const row = screen.getByTestId("epic-sidebar-item-ticket-child");
    const marker = screen.getByTestId("epic-sidebar-unread-ticket-child");
    expect(row.contains(marker)).toBe(true);
    expect(marker.className).not.toContain("absolute");
    expect(marker.getAttribute("data-unread-marker")).toBe("self");
    // Solid bar (exact token, not the muted `bg-blue-500/50` descendant class)
    // for the artifact's own unread state.
    expect(marker.classList.contains("bg-blue-500")).toBe(true);
    // An expanded, read parent shows no marker (its child carries its own bar).
    expect(screen.queryByTestId("epic-sidebar-unread-spec-root")).toBeNull();
  });

  it("shows a descendant unread marker on a collapsed parent artifact", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.expandedIds = new Set<string>();
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-item-ticket-child")).toBeNull();
    const marker = screen.getByTestId("epic-sidebar-unread-spec-root");
    expect(
      screen.getByTestId("epic-sidebar-item-spec-root").contains(marker),
    ).toBe(true);
    expect(marker.getAttribute("data-unread-marker")).toBe("descendant");
    // A muted (not full-opacity) bar distinguishes "contains unread" from "is unread".
    expect(marker.className).toContain("bg-blue-500/50");
  });

  it("hides the descendant marker once the parent is expanded", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.expandedIds = new Set(["spec-root"]);
    testState.unreadArtifactIds = new Set(["ticket-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // Expanded: the child is visible with its own marker and the parent shows
    // none (no double-signal of the same unread artifact).
    expect(
      screen.getByTestId("epic-sidebar-unread-ticket-child"),
    ).not.toBeNull();
    expect(screen.queryByTestId("epic-sidebar-unread-spec-root")).toBeNull();
  });

  it("seeds the artifact read baseline once the snapshot is loaded", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(seedEpicArtifacts).toHaveBeenCalledWith(
      EPIC_ID,
      expect.arrayContaining([
        expect.objectContaining({ id: "spec-root" }),
        expect.objectContaining({ id: "ticket-child" }),
      ]),
    );
  });

  it("does not seed the read baseline before the snapshot is loaded", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.snapshotLoaded = false;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(seedEpicArtifacts).not.toHaveBeenCalled();
  });

  it("marks the active artifact read when it is the active tile", () => {
    seedArtifactTree();
    testState.activePanelId = "artifacts";
    testState.activeArtifactId = "ticket-child";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(markRead).toHaveBeenCalledWith(EPIC_ID, "ticket-child", 1);
  });

  it("does not mark read when the active tile is not an artifact", () => {
    seedChatTree();
    testState.activePanelId = "chats";
    testState.activeArtifactId = "chat-root";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(markRead).not.toHaveBeenCalled();
  });
});

/**
 * The leading icon's status kinds, in the lattice's own precedence order.
 *
 * Status lives on the LEADING icon: the row's trailing slot was a status chip
 * until the single-line redesign removed it, leaving that slot to the relative
 * last-activity time and the archive/menu controls that replace it on hover.
 * These ids are `ChatProgressIcon`'s (`chat-sidebar-spinner` prefix + the tone
 * / activity id from `NotificationIndicatorIcon`).
 */
const LEADING_STATUS_KINDS = [
  "failure",
  "interview",
  "approval",
  "activity",
  "background-activity",
  "done",
] as const;

/**
 * Which of those kinds a chat row is currently showing.
 *
 * Returned as a LIST rather than asserted one at a time so a precedence step
 * proves the losing kinds are gone, not merely that the winner arrived - and so
 * an idle row is `[]` rather than a pile of separate `queryByTestId` nulls.
 */
function leadingStatusKinds(nodeId: string): readonly string[] {
  return LEADING_STATUS_KINDS.filter(
    (kind) =>
      screen.queryByTestId(`chat-sidebar-spinner-${kind}-${nodeId}`) !== null,
  );
}

/**
 * A row's read-only lock, which `ChatProgressIcon` renders in the IDLE slot -
 * so it appears only once no attention tone, activity tier or unread completion
 * has claimed the icon. Scoped to the row so a sibling's lock cannot satisfy it.
 */
/**
 * The hover label attached to `el`. The real `TooltipContent` is portalled and
 * open-only, but this file's `@/components/ui/tooltip` mock renders it inline -
 * as a sibling of the trigger, since the mocked `Tooltip`/`TooltipTrigger` both
 * render their children directly.
 */
function tooltipTextIn(el: HTMLElement): string | null {
  const tip = el.parentElement?.querySelector('[role="tooltip"]') ?? null;
  return tip === null ? null : tip.textContent;
}

function readOnlyLock(nodeId: string): HTMLElement | null {
  const row = screen.queryByTestId(`epic-sidebar-item-${nodeId}`);
  if (row === null) return null;
  return within(row).queryByRole("status", { name: "Read-only agent" });
}

/** The row's trailing relative last-activity time. */
function idleTime(nodeId: string): HTMLElement | null {
  const row = screen.queryByTestId(`epic-sidebar-item-${nodeId}`);
  if (row === null) return null;
  return within(row).queryByTestId("chat-row-idle-time");
}

describe("chat descendant status rollup", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = {
      rootIds: [],
      childrenByParent: {},
      nodeById: {},
    };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.chatFilterOrigin = "all";
  });

  function seedNestedChatTree(): void {
    const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
    const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
    const chatGrandchild = treeNode(
      "chat-grandchild",
      "chat-child",
      "Grandchild chat",
      "chat",
    );
    const agentChild = treeNode(
      "agent-child",
      "chat-root",
      "Terminal agent",
      "terminal-agent",
    );
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = {
      rootIds: ["chat-root"],
      childrenByParent: {
        "chat-root": ["chat-child", "agent-child"],
        "chat-child": ["chat-grandchild"],
      },
      nodeById: {
        "chat-root": chatRoot,
        "chat-child": chatChild,
        "chat-grandchild": chatGrandchild,
        "agent-child": agentChild,
      },
    };
    testState.records = [chatRoot, chatChild, chatGrandchild, agentChild].map(
      recordFromNode,
    );
  }

  function indicator(
    overrides: Partial<TestIndicatorState>,
  ): TestIndicatorState {
    return {
      unreadFailure: false,
      pendingFork: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
      ...overrides,
    };
  }

  // The fork indicator is an OBSERVATION now, not an entry point: a
  // publication fork resolves itself and the user is told afterwards by a
  // notification, so clicking the glyph opens nothing. Pinned as a click that
  // selects the row like any other part of it, because the previous behaviour
  // (swallow the click, open an arbitration dialog) is exactly what the
  // demolition removed and a silent no-op glyph would read as a bug.
  it("shows the fork glyph as a status, with no arbitration to click into", () => {
    seedNestedChatTree();
    testState.indicatorChats = {
      "chat-root": indicator({ pendingFork: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const glyph = screen.getByTestId("chat-sidebar-spinner-fork-chat-root");
    // The indicator survives - an open episode is real state and worth showing
    // while it lasts - but it is an OBSERVATION now. The affordance that made
    // it an entry point into the fork dialog is gone, and both halves of that
    // are asserted structurally rather than through a click: the delegation
    // hook the row used to read, and the pointer affordance that advertised
    // it. A click assertion alone would pass against a handler that silently
    // did nothing.
    const span = glyph.parentElement;
    expect(span?.getAttribute("data-notification-indicator-action")).toBeNull();
    expect(span?.className).not.toContain("cursor-pointer");

    fireEvent.click(glyph);
    expect(useAppDialogStore.getState().activeDialog).toBeNull();
  });

  it("bubbles a hidden grandchild's needs-attention status onto the collapsed root", () => {
    seedNestedChatTree();
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    // The grandchild's row is not even mounted, yet its status reaches the
    // collapsed root as the rollup badge.
    expect(
      screen.queryByTestId("epic-sidebar-item-chat-grandchild"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();

    // Expanding the root moves the rollup down to the still-collapsed child.
    testState.expandedIds = new Set(["chat-root"]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeTruthy();

    // Fully expanded: the grandchild presents its own status, no rollups left.
    testState.expandedIds = new Set(["chat-root", "chat-child"]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeNull();
    expect(
      screen.getByTestId("epic-sidebar-item-chat-grandchild"),
    ).toBeTruthy();
  });

  it("rolls an active terminal-agent descendant up as running, outranked by failure", () => {
    seedNestedChatTree();
    testState.activeAgentIds = new Set(["agent-child"]);
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadDone: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    // Running outranks unread completion...
    expect(
      screen.getByTestId("chat-descendant-status-running-chat-root"),
    ).toBeTruthy();

    // ...and a failure anywhere below outranks running.
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadDone: true }),
      "chat-child": indicator({ unreadFailure: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();
  });

  it("surfaces a terminal-agent's chat-scoped unread-done: rollup while collapsed, own row indicator when expanded", () => {
    seedNestedChatTree();
    testState.tuiHarnessIds = { "agent-child": "codex" };
    // TUI `agent.stopped` rows are chat-scoped to the agent id, so the
    // indicator entry lands under the terminal-agent's own id.
    testState.indicatorChats = {
      "agent-child": indicator({ unreadDone: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    // Hidden behind the collapsed root, the agent's completion rolls up.
    expect(
      screen.getByTestId("chat-descendant-status-done-chat-root"),
    ).toBeTruthy();

    // Expanded, the agent row wears its own done indicator instead of the
    // harness brand mark.
    testState.expandedIds = new Set(["chat-root"]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-done-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("terminal-agent-sidebar-done-agent-child"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("sidebar-agent-harness-agent-child"),
    ).toBeNull();
  });

  it("lets a hidden failure take the slot from a merely-running parent, with a breakdown tooltip", () => {
    seedNestedChatTree();
    testState.activeAgentIds = new Set(["chat-root", "agent-child"]);
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
      "chat-child": indicator({ unreadDone: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // The parent is running (rank below failure), so the nested failure owns
    // the icon slot - rendered as the muted variant in place of the parent's
    // own icon, with the tooltip carrying the full nested breakdown.
    const nested = screen.getByTestId(
      "chat-descendant-status-failure-chat-root",
    );
    expect(tooltipTextIn(nested)).toBe(
      "Nested: 1 needs attention · 1 running · 1 completed",
    );
    // The nested rollup owns the slot, so the parent's own spinner is absent.
    expect(leadingStatusKinds("chat-root")).toEqual([]);
  });

  it("keeps the slot with the parent when its own status is at least as urgent", () => {
    seedNestedChatTree();
    // Parent's own failure vs a nested running agent: parent outranks.
    testState.activeAgentIds = new Set(["agent-child"]);
    testState.indicatorChats = {
      "chat-root": indicator({ unreadFailure: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();
    expect(leadingStatusKinds("chat-root")).toEqual(["failure"]);

    // Equal tiers: the tie goes to the parent's own (solid) presentation.
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.indicatorChats = {
      "chat-root": indicator({ pendingApproval: true }),
      "chat-grandchild": indicator({ pendingApproval: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-approval-chat-root"),
    ).toBeNull();
    expect(leadingStatusKinds("chat-root")).toEqual(["approval"]);
  });

  it("distinguishes a background-only descendant from one mid-turn", () => {
    seedNestedChatTree();
    // The grandchild is non-idle, but only because a background task
    // (run_in_background / Monitor / a scheduled wakeup) is keeping it alive -
    // the agent itself is not executing. Before the awareness tier existed
    // this was indistinguishable from a live turn.
    testState.activeAgentIds = new Set(["chat-grandchild"]);
    testState.activityTierById = new Map([["chat-grandchild", "background"]]);

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    const backgroundIcon = screen.getByTestId(
      "chat-descendant-status-background-chat-root",
    );
    expect(backgroundIcon).toBeTruthy();
    expect(backgroundIcon.getAttribute("class")).toContain("opacity-60");
    expect(
      backgroundIcon.querySelector(".lucide-message-square-clock"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();

    // Same descendant, now genuinely mid-turn: the busier tier takes the slot.
    testState.activityTierById = new Map([["chat-grandchild", "turn"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("chat-descendant-status-running-chat-root"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("chat-descendant-status-background-chat-root"),
    ).toBeNull();
  });

  it("ranks a descendant's turn above a descendant's background work", () => {
    seedNestedChatTree();
    testState.activeAgentIds = new Set(["chat-child", "chat-grandchild"]);
    testState.activityTierById = new Map([
      ["chat-child", "background"],
      ["chat-grandchild", "turn"],
    ]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    const icon = screen.getByTestId("chat-descendant-status-running-chat-root");
    expect(icon).toBeTruthy();
    // The tooltip breaks the aggregate down across both tiers.
    expect(tooltipTextIn(icon)).toContain("1 running");
    expect(tooltipTextIn(icon)).toContain("1 in background");
  });

  it("lets a descendant's turn outrank the parent's own background work", () => {
    seedNestedChatTree();
    // Parent is non-idle but only in background; a hidden descendant is
    // actually mid-turn, so the busier nested tier must win the slot rather
    // than being masked by the parent's own (lower) tier.
    testState.activeAgentIds = new Set(["chat-root", "chat-grandchild"]);
    testState.activityTierById = new Map([
      ["chat-root", "background"],
      ["chat-grandchild", "turn"],
    ]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expect(
      screen.getByTestId("chat-descendant-status-running-chat-root"),
    ).toBeTruthy();
  });

  it("shows an unread-done rollup and nothing when descendants are idle", () => {
    seedNestedChatTree();
    testState.indicatorChats = {
      "chat-child": indicator({ unreadDone: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("chat-descendant-status-done-chat-root"),
    ).toBeTruthy();

    testState.indicatorChats = {};
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-done-chat-root"),
    ).toBeNull();
  });

  it("ranks interview above approval, both outranked by failure", () => {
    seedNestedChatTree();
    testState.indicatorChats = {
      "chat-child": indicator({ pendingApproval: true }),
      "chat-grandchild": indicator({ pendingInterview: true }),
    };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("chat-descendant-status-interview-chat-root"),
    ).toBeTruthy();

    testState.indicatorChats = {
      ...testState.indicatorChats,
      "chat-child": indicator({ unreadFailure: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.queryByTestId("chat-descendant-status-interview-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();
  });

  it("excludes a filter-hidden subtree from the rollup while keeping a visible descendant's status", () => {
    seedNestedChatTree();
    // GUI-only origin filter hides the terminal-agent descendant entirely -
    // its active-run state must not leak into the rollup as "running" - while
    // the chat subtree (still reachable under the filter) keeps surfacing.
    testState.chatFilterOrigin = "gui";
    testState.activeAgentIds = new Set(["agent-child"]);
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expect(
      screen.queryByTestId("chat-descendant-status-running-chat-root"),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();
  });
});

describe("chat row leading status icon", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
  });

  function indicator(
    overrides: Partial<TestIndicatorState>,
  ): TestIndicatorState {
    return {
      unreadFailure: false,
      pendingFork: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
      ...overrides,
    };
  }

  it("walks a leaf chat row through every leading status icon in precedence order", () => {
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    // Idle: no attention state, no activity tier - the icon falls back to the
    // plain chat glyph and the trailing slot carries the relative time.
    expect(leadingStatusKinds("chat-child")).toEqual([]);
    expect(idleTime("chat-child")).toBeTruthy();

    // Unread-done outranks idle.
    testState.indicatorChats = {
      "chat-child": indicator({ unreadDone: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["done"]);

    // Background activity outranks unread-done.
    testState.activeAgentIds = new Set(["chat-child"]);
    testState.activityTierById = new Map([["chat-child", "background"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["background-activity"]);

    // A running turn outranks background activity.
    testState.activityTierById = new Map([["chat-child", "turn"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["activity"]);

    // A pending approval outranks a running turn.
    testState.indicatorChats = {
      "chat-child": indicator({ pendingApproval: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["approval"]);

    // A pending interview outranks a pending approval.
    testState.indicatorChats = {
      "chat-child": indicator({
        pendingApproval: true,
        pendingInterview: true,
      }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["interview"]);

    // A failure outranks everything, including a pending interview.
    testState.indicatorChats = {
      "chat-child": indicator({
        pendingInterview: true,
        unreadFailure: true,
      }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["failure"]);

    // Through all of it the trailing slot keeps the relative time: the icon
    // carries status, the slot carries time, and neither displaces the other.
    expect(idleTime("chat-child")).toBeTruthy();
  });

  it("splits a TUI terminal-agent row's own icon by activity tier, as the rollup already does", () => {
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    // With no notification state for this agent the icon only reaches the
    // tier / idle arms: idle wears the harness brand.
    const agentRow = screen.getByTestId("epic-sidebar-item-agent-root");
    expect(
      within(agentRow).queryByTestId(
        "terminal-agent-sidebar-activity-agent-root",
      ),
    ).toBeNull();
    expect(idleTime("agent-root")).toBeTruthy();

    testState.activeAgentIds = new Set(["agent-root"]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("terminal-agent-sidebar-activity-agent-root"),
    ).toBeTruthy();

    // Background-only work reads calm, not busy. Without this split the agent's
    // own row wore the turn spinner while its collapsed parent rendered the
    // background glyph for that same agent - two surfaces disagreeing about one
    // fact. The trailing chip used to carry the tier; the icon carries it now.
    testState.activityTierById = new Map([["agent-root", "background"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId(
        "terminal-agent-sidebar-background-activity-agent-root",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("terminal-agent-sidebar-activity-agent-root"),
    ).toBeNull();
  });
});

describe("unreachable-owner chat rows (tree lock + published-copy routing)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.permissionRole = "owner";
    testState.rowHostId = "host-1";
    testState.rowHostReachability = "reachable";
    testState.preparedOpenRefs = [];
  });

  it("locks a chat row whose owner host is unreachable, matching the cloud rows", () => {
    seedChatTree();
    testState.rowHostId = "host-dead";
    testState.rowHostReachability = "unreachable";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-tree-lock-chat-root")).toBeTruthy();
  });

  it("keeps reachable-owner rows lock-free", () => {
    seedChatTree();
    testState.rowHostId = "host-1";
    testState.rowHostReachability = "reachable";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-tree-lock-chat-root")).toBeNull();
  });

  it("routes an unreachable-owner row's click to the PUBLISHED COPY, not a live tab", () => {
    seedChatTree();
    testState.rowHostId = "host-dead";
    testState.rowHostReachability = "unreachable";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.click(screen.getByTestId("epic-sidebar-item-chat-root"));

    expect(testState.preparedOpenRefs).toHaveLength(1);
    expect(testState.preparedOpenRefs[0].type).toBe("published-chat");
  });

  it("routes a reachable-owner row's click to a LIVE tab bound to the owner", () => {
    seedChatTree();
    testState.rowHostId = "host-b";
    testState.rowHostReachability = "reachable";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.click(screen.getByTestId("epic-sidebar-item-chat-root"));

    expect(testState.preparedOpenRefs).toHaveLength(1);
    expect(testState.preparedOpenRefs[0].type).toBe("chat");
    expect(testState.preparedOpenRefs[0].hostId).toBe("host-b");
  });
});

describe("chat row read-only arm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.permissionRole = "owner";
  });

  function indicator(
    overrides: Partial<TestIndicatorState>,
  ): TestIndicatorState {
    return {
      unreadFailure: false,
      pendingFork: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
      ...overrides,
    };
  }

  it("shows the read-only lock in place of the chat glyph for a viewer's otherwise-idle chat row", () => {
    seedChatTree();
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const lock = readOnlyLock("chat-child");
    expect(lock).toBeTruthy();
    expect(lock === null ? null : tooltipTextIn(lock)).toBe("Read-only agent");
    // It replaces the IDLE GLYPH, not the trailing time: a viewer still sees
    // when the row last moved.
    const row = screen.getByTestId("epic-sidebar-item-chat-child");
    expect(row.querySelector(".lucide-message-square")).toBeNull();
    expect(idleTime("chat-child")).toBeTruthy();
  });

  it("keeps Working / Needs attention / Done ahead of the read-only lock for a viewer row", () => {
    seedChatTree();
    testState.permissionRole = "viewer";

    // A running turn outranks read-only.
    testState.activeAgentIds = new Set(["chat-child"]);
    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["activity"]);
    expect(readOnlyLock("chat-child")).toBeNull();

    // Needs attention outranks read-only.
    testState.activeAgentIds = new Set<string>();
    testState.indicatorChats = {
      "chat-child": indicator({ unreadFailure: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["failure"]);
    expect(readOnlyLock("chat-child")).toBeNull();

    // Done outranks read-only.
    testState.indicatorChats = {
      "chat-child": indicator({ unreadDone: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["done"]);
    expect(readOnlyLock("chat-child")).toBeNull();
  });

  it("never locks a TUI terminal-agent row for a viewer - terminal agents carry no chat session lock", () => {
    seedChatTree();
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(idleTime("agent-root")).toBeTruthy();
    expect(readOnlyLock("agent-root")).toBeNull();
  });
});

describe("status survives selection mode and rename", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
  });

  function indicator(
    overrides: Partial<TestIndicatorState>,
  ): TestIndicatorState {
    return {
      unreadFailure: false,
      pendingFork: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
      ...overrides,
    };
  }

  function seedSelectionParityTree(): void {
    const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
    const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
    const chatGrandchild = treeNode(
      "chat-grandchild",
      "chat-child",
      "Grandchild chat",
      "chat",
    );
    testState.tree = {
      rootIds: ["chat-root"],
      childrenByParent: {
        "chat-root": ["chat-child"],
        "chat-child": ["chat-grandchild"],
      },
      nodeById: {
        "chat-root": chatRoot,
        "chat-child": chatChild,
        "chat-grandchild": chatGrandchild,
      },
    };
    testState.records = [chatRoot, chatChild, chatGrandchild].map(
      recordFromNode,
    );
    // chat-root expanded (its own chip renders); chat-child collapsed (rolls
    // its hidden grandchild's status up instead).
    testState.expandedIds = new Set(["chat-root"]);
  }

  it("keeps a row's own status AND a collapsed parent's rollup visible in bulk-selection mode", () => {
    seedSelectionParityTree();
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    // Sanity check before entering selection mode: chat-root shows its own
    // turn spinner and chat-child shows the hidden grandchild's rollup.
    expect(leadingStatusKinds("chat-root")).toEqual(["activity"]);
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));

    // Both signals survive the switch to the selection-mode <label> row, which
    // grows a checkbox between the chevron and the leading icon.
    expect(leadingStatusKinds("chat-root")).toEqual(["activity"]);
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeTruthy();
  });

  it("shows only the row's own status while renaming, never the collapsed-parent rollup", () => {
    seedSelectionParityTree();
    testState.indicatorChats = {
      "chat-grandchild": indicator({ unreadFailure: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    // Sanity check: chat-child is collapsed and rolls the grandchild's
    // failure up while not being renamed.
    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("epic-sidebar-rename-chat-child"));

    const input = screen.getByTestId("epic-sidebar-rename-input-chat-child");
    // Renaming shows chat-child's OWN status - idle, since it has no attention
    // state of its own - so the plain chat glyph, not the nested rollup. The
    // rename row swaps the whole display row out, hence resolving it from the
    // input's known ancestry rather than from `epic-sidebar-item-*`.
    const renameRow = input.parentElement?.parentElement?.parentElement;
    expect(renameRow).toBeTruthy();
    expect(renameRow?.querySelector(".lucide-message-square")).toBeTruthy();
    expect(leadingStatusKinds("chat-child")).toEqual([]);
    expect(
      screen.queryByTestId("chat-descendant-status-failure-chat-child"),
    ).toBeNull();
  });
});

const createdSessionHandles: ChatSessionStoreHandle[] = [];

/**
 * A real chat session store, standing in for an OPEN chat. Module-scope because
 * two describes need one: the leading icon's authority order, and the archive
 * gate - which reads the same store and must agree with the icon.
 */
function createSessionHandle(chatId: string): ChatSessionStoreHandle {
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => false,
      close: () => undefined,
    }),
  });
  createdSessionHandles.push(handle);
  return handle;
}

function disposeCreatedSessionHandles(): void {
  for (const handle of createdSessionHandles.splice(0)) {
    handle.dispose();
  }
}

function runningShell(chatId: string): ManagedCommand {
  return {
    id: `${chatId}-shell`,
    monitoring: true,
    description: "dev server",
    command: "tail -f deploy.log",
    cwd: "/work/repo",
    cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
    status: { state: "running", pid: 4242, startedAtMs: 1 },
    chatId,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("chat status icon session authority (open session vs awareness)", () => {
  const MONITOR_ITEM = {
    taskId: "task-1",
    kind: "monitor" as const,
    title: "Monitor",
    blockId: "block-1",
    parentTaskId: null,
    scheduledFor: null,
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.sessionHandleByChatId = {};
    disposeCreatedSessionHandles();
  });

  it("lets an open session's background tri-state override an awareness tier of turn, then falls back to awareness once the session closes", () => {
    seedChatTree();
    // Awareness alone would read "turn" (the default tier for an active id) -
    // the scenario where the host doesn't publish the turn-awareness field
    // and only a background task keeps the chat non-idle.
    testState.activeAgentIds = new Set(["chat-child"]);

    const handle = createSessionHandle("chat-child");
    handle.store.setState({
      runStatus: "running",
      turnInProgress: undefined,
      activeTurn: null,
      backgroundItems: [MONITOR_ITEM],
    });
    testState.sessionHandleByChatId = { "chat-child": handle };

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    expect(leadingStatusKinds("chat-child")).toEqual(["background-activity"]);

    // No open session any more - falls back to the awareness tier ("turn").
    testState.sessionHandleByChatId = {};
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(leadingStatusKinds("chat-child")).toEqual(["activity"]);
  });

  it("stays neutral while the open session's access snapshot is unknown, so no read-only flash precedes it", () => {
    seedChatTree();
    const handle = createSessionHandle("chat-child");
    testState.sessionHandleByChatId = { "chat-child": handle };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    // Access snapshot not arrived yet (null) - must not flash the lock.
    expect(leadingStatusKinds("chat-child")).toEqual([]);
    expect(readOnlyLock("chat-child")).toBeNull();
    expect(
      screen
        .getByTestId("epic-sidebar-item-chat-child")
        .querySelector(".lucide-message-square"),
    ).toBeTruthy();
  });

  it("locks a chat row once the session's access snapshot resolves to a non-owner role", () => {
    seedChatTree();
    const handle = createSessionHandle("chat-child");
    handle.store.setState({
      access: { role: "viewer", ownerUserId: "owner-1", canAct: false },
    });
    testState.sessionHandleByChatId = { "chat-child": handle };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(readOnlyLock("chat-child")).toBeTruthy();
    // Exactly ONE announced read-only status in the whole tree. There used to
    // be two candidates - the leading icon's lock and a trailing status chip -
    // which is why the leading slot was `aria-hidden`. The chip is gone, the
    // slot is announced again, and this guards the count either way.
    expect(
      screen.getAllByRole("status", { name: "Read-only agent" }),
    ).toHaveLength(1);
  });
});

describe("chat row idle-time compact format", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
  });

  function seedIdleTimeTree(updatedAt: number): void {
    const chatRoot: TestTreeNode = {
      id: "chat-root",
      parentId: null,
      title: "Root chat",
      type: "chat",
      status: null,
      createdAt: 1,
      updatedAt,
    };
    testState.tree = {
      rootIds: ["chat-root"],
      childrenByParent: {},
      nodeById: { "chat-root": chatRoot },
    };
    testState.records = [chatRoot].map(recordFromNode);
  }

  it("renders the tight compact form ('now' / '23m' / '3h' / '6d' / short date) instead of the verbose 'ago' phrasing", () => {
    const now = Date.now();

    seedIdleTimeTree(now);
    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(idleTime("chat-root")?.textContent).toBe("now");

    seedIdleTimeTree(now - 23 * 60_000);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(idleTime("chat-root")?.textContent).toBe("23m");

    seedIdleTimeTree(now - 3 * 60 * 60_000);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(idleTime("chat-root")?.textContent).toBe("3h");

    seedIdleTimeTree(now - 6 * 24 * 60 * 60_000);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    const sixDays = idleTime("chat-root");
    expect(sixDays?.textContent).toBe("6d");
    expect(sixDays?.textContent).not.toContain("ago");

    const farPast = now - 40 * 24 * 60 * 60_000;
    seedIdleTimeTree(farPast);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    const shortDate = idleTime("chat-root");
    expect(shortDate?.textContent).toBe(
      new Date(farPast).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
    expect(shortDate?.textContent).not.toBe("Yesterday");
  });
});

/**
 * Leading identity icon on chat / terminal-agent sidebar rows.
 *
 * The row is a horizontal flex (`items-center`): chevron → leading icon slot →
 * text column → trailing time. Chat rows always wear the chat glyph (never a
 * harness brand); idle TUI rows wear the harness brand + surface subscript (or
 * bot fallback / spinner when active).
 *
 * This icon is also the row's ONLY status surface since the trailing chip was
 * removed, so the tests below cover both jobs it now holds: identity, and
 * being the single thing that announces status.
 */
describe("sidebar leading identity icon", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.activePanelId = "chats";
    testState.expandedIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.chatHarnessIds = {};
    testState.tuiHarnessIds = {};
    testState.tuiAgentById = {};
    testState.tuiProviderProfiles = [];
    testState.permissionRole = "owner";
  });

  function expectChatGlyphWithoutHarness(nodeId: string): void {
    // Display / selection rows expose epic-sidebar-item-*. Rename replaces that
    // surface, so resolve the rename row from the input's known ancestry -
    // input → row-1 flex → text column → the row itself, which is where the
    // leading slot sits as the column's sibling.
    //
    // Resolved by walking a FIXED number of parents rather than searching
    // upward for the glyph: an unbounded search escapes this row and would be
    // satisfied by a sibling row's chat glyph. Assertions use `toBeTruthy` so
    // an `undefined` from a broken ancestry chain fails instead of sliding
    // past `not.toBeNull()`.
    const item = screen.queryByTestId(`epic-sidebar-item-${nodeId}`);
    if (item !== null) {
      expect(item.querySelector(".lucide-message-square")).toBeTruthy();
    } else {
      const input = screen.getByTestId(`epic-sidebar-rename-input-${nodeId}`);
      const renameRow = input.parentElement?.parentElement?.parentElement;
      expect(renameRow).toBeTruthy();
      expect(renameRow?.querySelector(".lucide-message-square")).toBeTruthy();
    }
    expect(screen.queryByTestId(`sidebar-agent-harness-${nodeId}`)).toBeNull();
    expect(screen.queryByTestId(`sidebar-agent-surface-${nodeId}`)).toBeNull();
  }

  function expectTuiHarness(nodeId: string): void {
    expect(
      screen.getByTestId(`sidebar-agent-harness-${nodeId}`),
    ).not.toBeNull();
    expect(
      screen.getByTestId(`sidebar-agent-surface-${nodeId}`),
    ).not.toBeNull();
  }

  it("renders the chat glyph (never harness brand) in display, selection, and rename variants", () => {
    seedChatTree();
    testState.chatHarnessIds = {
      "chat-root": "codex",
      "chat-child": "claude",
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expectChatGlyphWithoutHarness("chat-root");

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    expectChatGlyphWithoutHarness("chat-root");

    cleanup();
    seedChatTree();
    testState.chatHarnessIds = {
      "chat-root": "codex",
      "chat-child": "claude",
    };
    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.click(screen.getByTestId("epic-sidebar-rename-chat-root"));
    expect(
      screen.getByTestId("epic-sidebar-rename-input-chat-root"),
    ).toBeTruthy();
    expectChatGlyphWithoutHarness("chat-root");
  });

  it("renders TUI harness brand + surface subscript in display, selection, and rename variants", () => {
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "codex" };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expectTuiHarness("agent-root");

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    expectTuiHarness("agent-root");

    cleanup();
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "codex" };
    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.click(screen.getByTestId("epic-sidebar-rename-agent-root"));
    expect(
      screen.getByTestId("epic-sidebar-rename-input-agent-root"),
    ).toBeTruthy();
    expectTuiHarness("agent-root");
  });

  it("badges a managed-profile TUI row while keeping the terminal surface glyph", () => {
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "claude" };
    testState.tuiAgentById = {
      "agent-root": { hostId: "host-1", profileId: "profile-1" },
    };
    testState.tuiProviderProfiles = [
      {
        profileId: "ambient",
        kind: "ambient",
        label: "Terminal account",
      },
      {
        profileId: "profile-1",
        kind: "managed",
        label: "Work account",
      },
    ];

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expectTuiHarness("agent-root");
    expect(
      screen.getByTestId("sidebar-agent-profile-mark-agent-root"),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "claude, Work account" }),
    ).toBeTruthy();
    // Terminal surface mark still marks the row as a TUI agent.
    expect(screen.getByTestId("sidebar-agent-surface-agent-root")).toBeTruthy();
  });

  it("keeps ambient TUI rows unbadged (bare harness + terminal glyph)", () => {
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "claude" };
    testState.tuiAgentById = {
      "agent-root": { hostId: "host-1", profileId: null },
    };
    testState.tuiProviderProfiles = [
      {
        profileId: "ambient",
        kind: "ambient",
        label: "Terminal account",
      },
      {
        profileId: "profile-1",
        kind: "managed",
        label: "Work account",
      },
    ];

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expectTuiHarness("agent-root");
    expect(screen.getByRole("img", { name: "claude" })).toBeTruthy();
    const mark = screen.getByTestId("sidebar-agent-profile-mark-agent-root");
    expect(mark.querySelector('span[style*="background-color"]')).toBeNull();
  });

  it("falls back to the bot glyph when a TUI row has no harness id", () => {
    seedChatTree();
    // tuiHarnessIds stays empty → useMaybeEpicTuiAgentHarnessId returns null.
    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const tuiRow = screen.getByTestId("epic-sidebar-item-agent-root");
    expect(tuiRow.querySelector(".lucide-bot")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-agent-harness-agent-root")).toBeNull();
    expect(screen.queryByTestId("sidebar-agent-surface-agent-root")).toBeNull();
  });

  it("swaps an active TUI row to the terminal spinner and hides the harness brand", () => {
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "codex" };
    testState.activeAgentIds = new Set(["agent-root"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.getByTestId("terminal-agent-sidebar-activity-agent-root"),
    ).not.toBeNull();
    expect(screen.queryByTestId("sidebar-agent-harness-agent-root")).toBeNull();
    expect(screen.queryByTestId("sidebar-agent-surface-agent-root")).toBeNull();
  });

  it("centers the leading icon via horizontal items-center siblings (no fixed row height)", () => {
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "codex" };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // jsdom has no layout, so assert the structural contract instead: the row
    // is a horizontal flex with items-center; the chevron and the leading icon
    // slot are direct children of the row and siblings of the text column, not
    // nested inside it; and nothing pins a fixed height, so a row whose title
    // wraps grows rather than clipping.
    const row = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(row.className).toContain("items-center");
    // Fixed height would be `h-N` / `h-[…]`; min-h is the allowed floor.
    expect(row.className).not.toMatch(/(?:^|\s)h-(?:\d|\[)/);
    expect(row.className).toContain("min-h-7");

    const title = within(row).getByText("Root chat");
    const textColumn = title.parentElement?.parentElement;
    expect(textColumn).toBeTruthy();
    expect(textColumn?.parentElement).toBe(row);

    const chatGlyph = row.querySelector(".lucide-message-square");
    expect(chatGlyph).not.toBeNull();
    // Leading icon must not live inside the text column.
    expect(textColumn?.contains(chatGlyph)).toBe(false);

    // Walk up from the glyph to the row's direct-child slot.
    let leadingSlot: Element | null = chatGlyph;
    while (
      leadingSlot !== null &&
      leadingSlot.parentElement !== null &&
      leadingSlot.parentElement !== row
    ) {
      leadingSlot = leadingSlot.parentElement;
    }
    expect(leadingSlot?.parentElement).toBe(row);
    // Slot is a sibling of the text column, not nested under it.
    expect(leadingSlot).not.toBe(textColumn);
    expect(Array.from(row.children)).toContain(leadingSlot);
    expect(Array.from(row.children)).toContain(textColumn);

    // Chevron is also a direct child of the row (before the leading slot).
    const chevronOrSpacer = row.children[0];
    expect(chevronOrSpacer).toBeDefined();
    expect(chevronOrSpacer).not.toBe(leadingSlot);
    expect(chevronOrSpacer).not.toBe(textColumn);
  });

  it("carries status on the leading icon while the trailing slot keeps the time", () => {
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "codex" };
    testState.activeAgentIds = new Set(["chat-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // Idle chat: leading chat glyph, trailing relative time.
    const chatRoot = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(chatRoot.querySelector(".lucide-message-square")).not.toBeNull();
    expect(idleTime("chat-root")).toBeTruthy();

    // Working chat: the glyph BECOMES the spinner - status replaces identity in
    // the leading slot rather than being added beside it - and the time stays.
    const chatChild = screen.getByTestId("epic-sidebar-item-chat-child");
    expect(
      chatChild.querySelector(
        '[data-testid="chat-sidebar-spinner-activity-chat-child"]',
      ),
    ).not.toBeNull();
    expect(chatChild.querySelector(".lucide-message-square")).toBeNull();
    expect(idleTime("chat-child")).toBeTruthy();

    // Idle TUI: leading harness brand, trailing relative time.
    expectTuiHarness("agent-root");
    expect(idleTime("agent-root")).toBeTruthy();
  });

  it("announces the leading icon, now that it is the row's only status surface", () => {
    seedChatTree();
    testState.tuiHarnessIds = { "agent-root": "codex" };
    testState.activeAgentIds = new Set(["chat-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // The slot was `aria-hidden` while a trailing status chip existed, because
    // the two said the same thing and a read-only row announced "Read-only
    // agent" twice. With the chip gone, hiding it would drop running, approval,
    // failure and read-only out of the a11y tree entirely - de-duplicating
    // nothing. So the running row must announce, from inside the slot.
    const chatChild = screen.getByTestId("epic-sidebar-item-chat-child");
    const running = within(chatChild).getByRole("status", {
      name: "Agent in progress",
    });
    expect(running.closest("[aria-hidden]")).toBeNull();

    // The row's own accessible name stays its TITLE: the explicit `aria-label`
    // keeps the status, badges and timestamp inside it from being concatenated
    // into the name.
    expect(chatChild.getAttribute("aria-label")).toBe("Child chat");

    // Identity-only icons carry no status role to announce in the first place.
    const harnessSlot = screen.getByTestId("sidebar-agent-harness-agent-root");
    expect(harnessSlot.getAttribute("role")).toBeNull();
  });
});

/**
 * Host-backed archive for Agents panel rows.
 *
 * Behaviours B1–B10 from the archive feature. The harness knobs
 * (`archiveSupport`, `archiveVisibility`, `archivedIds`, `archiveMutate`) drive
 * the gate, filter, and projected flags - these tests assert renderer
 * behaviour against those knobs, not production selector/RPC wiring.
 */
describe("chat row archive", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.sessionReady = true;
    testState.snapshotLoaded = true;
    testState.activeArtifactId = null;
    testState.openTileContentIds = new Set<string>();
    testState.activePanelId = "chats";
    testState.artifactFilterKinds = [];
    testState.chatFilterOrigin = "all";
    testState.collapsedPanelIds = new Set<string>();
    testState.expandedIds = new Set<string>();
    testState.unreadArtifactIds = new Set<string>();
    testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
    testState.records = [];
    testState.indicatorChats = {};
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.chatHarnessIds = {};
    testState.tuiHarnessIds = {};
    testState.permissionRole = "owner";
    testState.archiveSupport = true;
    testState.archiveVisibility = "unarchived";
    testState.archivedIds = [];
    testState.archiveMutate = vi.fn();
    testState.archiveBatchPending = false;
    // Leaking this one disables every later row's Archive for a reason no test
    // named, which reads as the gate under test firing.
    testState.archiveRowPending = false;
    testState.archiveMutateAsync = vi.fn();
    testState.rowHostId = "host-1";
    testState.rowHostReachability = "reachable";
    testState.preparedOpenRefs = [];
    testState.rowHostEntry = { hostId: "host-1" };
    testState.rowHostClient = { getActiveHostId: () => "host-1" };
    testState.activeHostClient = { getActiveHostId: () => "host-1" };
    testState.sessionHandleByChatId = {};
    disposeCreatedSessionHandles();
  });

  function indicator(
    overrides: Partial<TestIndicatorState>,
  ): TestIndicatorState {
    return {
      unreadFailure: false,
      pendingFork: false,
      pendingApproval: false,
      pendingInterview: false,
      unreadDone: false,
      ...overrides,
    };
  }

  /** Parent → child → grandchild for B1/B2 subtree hiding. */
  function seedArchiveSubtree(): void {
    const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
    const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
    const chatGrandchild = treeNode(
      "chat-grandchild",
      "chat-child",
      "Grandchild chat",
      "chat",
    );
    const agentRoot = treeNode(
      "agent-root",
      null,
      "Terminal agent",
      "terminal-agent",
    );
    testState.activePanelId = "chats";
    testState.expandedIds = new Set(["chat-root", "chat-child"]);
    testState.tree = {
      rootIds: ["chat-root", "agent-root"],
      childrenByParent: {
        "chat-root": ["chat-child"],
        "chat-child": ["chat-grandchild"],
      },
      nodeById: {
        "chat-root": chatRoot,
        "chat-child": chatChild,
        "chat-grandchild": chatGrandchild,
        "agent-root": agentRoot,
      },
    };
    testState.records = [chatRoot, chatChild, chatGrandchild, agentRoot].map(
      recordFromNode,
    );
  }

  // --- B1: subtree hiding -------------------------------------------------

  it("hides an archived node and its entire subtree without cascading archive flags (B1)", () => {
    seedArchiveSubtree();
    // Only the parent carries the flag - descendants are not in archivedIds.
    testState.archivedIds = ["chat-root"];

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-item-chat-child")).toBeNull();
    expect(
      screen.queryByTestId("epic-sidebar-item-chat-grandchild"),
    ).toBeNull();
    // Unrelated sibling root stays visible.
    expect(screen.getByTestId("epic-sidebar-item-agent-root")).toBeTruthy();
  });

  // --- B2: unarchive restores subtree minus individually-archived descendants

  it("unarchiving a parent restores the subtree except independently archived descendants (B2)", () => {
    seedArchiveSubtree();
    // Parent was archived (hiding everything under it); descendant was also
    // archived on its own. Unarchive parent → only the parent's own flag
    // clears; the descendant's flag keeps its subtree hidden.
    testState.archivedIds = ["chat-child"];

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-item-chat-root")).toBeTruthy();
    expect(screen.queryByTestId("epic-sidebar-item-chat-child")).toBeNull();
    expect(
      screen.queryByTestId("epic-sidebar-item-chat-grandchild"),
    ).toBeNull();
    expect(screen.getByTestId("epic-sidebar-item-agent-root")).toBeTruthy();
  });

  // --- B3: archive visibility modes ---------------------------------------

  it('hides archived rows by default and reveals them dimmed in "All chats" (B3)', () => {
    seedArchiveSubtree();
    testState.archivedIds = ["chat-root"];

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-item-chat-child")).toBeNull();

    testState.archiveVisibility = "all";
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    const rootRow = screen.getByTestId("epic-sidebar-item-chat-root");
    const childRow = screen.getByTestId("epic-sidebar-item-chat-child");
    // Only the row that carries archivedAt is dimmed. Descendants that were
    // hidden purely by the parent's flag reappear undimmed.
    expect(rootRow.className).toContain("opacity-55");
    expect(childRow.className).not.toContain("opacity-55");

    testState.archiveVisibility = "unarchived";
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-item-chat-child")).toBeNull();
  });

  it("shows only archived rows plus their ancestor path in archived-only mode", () => {
    seedArchiveSubtree();
    testState.archivedIds = ["chat-child"];
    testState.archiveVisibility = "archived";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const ancestor = screen.getByTestId("epic-sidebar-item-chat-root");
    const archived = screen.getByTestId("epic-sidebar-item-chat-child");
    expect(ancestor.className).not.toContain("opacity-55");
    expect(archived.className).toContain("opacity-55");
    expect(
      screen.queryByTestId("epic-sidebar-item-chat-grandchild"),
    ).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-item-agent-root")).toBeNull();
  });

  it("does not let open or busy unarchived rows leak into archived-only mode", () => {
    seedArchiveSubtree();
    testState.archivedIds = ["chat-child"];
    testState.archiveVisibility = "archived";
    testState.openTileContentIds = new Set(["agent-root"]);
    testState.activityTierById = new Map([["agent-root", "turn"]]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-item-chat-child")).toBeTruthy();
    expect(screen.queryByTestId("epic-sidebar-item-agent-root")).toBeNull();
  });

  // --- B4: capability gate ------------------------------------------------

  it("omits every archive affordance when the host does not advertise the method (B4)", () => {
    seedChatTree();
    testState.archiveSupport = false;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // Hover button absent (not disabled).
    expect(screen.queryByTestId("epic-sidebar-archive-chat-root")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-archive-agent-root")).toBeNull();
    // Dropdown entry absent (not disabled).
    expect(
      screen.queryByTestId("epic-sidebar-archive-item-chat-root"),
    ).toBeNull();
    expect(
      screen.queryByTestId("epic-sidebar-archive-item-agent-root"),
    ).toBeNull();

    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-chat-root"));
    expect(
      screen.queryByTestId("epic-sidebar-context-archive-chat-root"),
    ).toBeNull();
    // Non-archive menu still works so the gate did not blank the whole menu.
    expect(screen.getByTestId("epic-sidebar-rename-chat-root")).toBeTruthy();
  });

  it("offers archive affordances when the host supports the method (B4)", () => {
    seedChatTree();
    testState.archiveSupport = true;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-sidebar-archive-chat-root")).toBeTruthy();
    expect(
      screen.getByTestId("epic-sidebar-archive-item-chat-root"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Archive Root chat" }),
    ).toBeTruthy();

    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-chat-root"));
    expect(
      screen.getByTestId("epic-sidebar-context-archive-chat-root"),
    ).toBeTruthy();
  });

  // --- B5: hover button, idle rows only -----------------------------------

  it("shows the hover archive button only on idle rows (B5)", () => {
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(screen.getByTestId("epic-sidebar-archive-chat-child")).toBeTruthy();

    // Working (turn).
    testState.activeAgentIds = new Set(["chat-child"]);
    testState.activityTierById = new Map([["chat-child", "turn"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(screen.queryByTestId("epic-sidebar-archive-chat-child")).toBeNull();

    // Background activity.
    testState.activityTierById = new Map([["chat-child", "background"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(screen.queryByTestId("epic-sidebar-archive-chat-child")).toBeNull();

    // Attention states: failure / interview / approval / unread-done.
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    for (const attention of [
      { unreadFailure: true },
      { pendingInterview: true },
      { pendingApproval: true },
      { unreadDone: true },
    ] as const) {
      testState.indicatorChats = {
        "chat-child": indicator(attention),
      };
      view.rerender(
        <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
      );
      expect(
        screen.queryByTestId("epic-sidebar-archive-chat-child"),
      ).toBeNull();
    }

    // Back to idle: button returns.
    testState.indicatorChats = {};
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(screen.getByTestId("epic-sidebar-archive-chat-child")).toBeTruthy();
  });

  it("hides the hover archive button in bulk-selection mode and while renaming (B5)", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expect(screen.getByTestId("epic-sidebar-archive-chat-root")).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    expect(screen.queryByTestId("epic-sidebar-archive-chat-root")).toBeNull();

    // Leave selection mode via deselect all is still selection mode; re-render
    // fresh for the rename case.
    cleanup();
    seedChatTree();
    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.click(screen.getByTestId("epic-sidebar-rename-chat-root"));
    expect(
      screen.getByTestId("epic-sidebar-rename-input-chat-root"),
    ).toBeTruthy();
    expect(screen.queryByTestId("epic-sidebar-archive-chat-root")).toBeNull();
  });

  // --- B6: row menu entry -------------------------------------------------

  it("puts Archive/Unarchive in both the ⋯ menu and the right-click menu for non-running rows (B6)", async () => {
    seedChatTree();

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    const archiveItem = screen.getByTestId(
      "epic-sidebar-archive-item-chat-root",
    );
    expect(archiveItem.textContent).toContain("Archive");
    expect(archiveItem.matches(":disabled")).toBe(false);

    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-chat-root"));
    expect(
      await screen.findByTestId("epic-sidebar-context-archive-chat-root"),
    ).toBeTruthy();

    // Terminal-agent rows get the same entry.
    expect(
      screen.getByTestId("epic-sidebar-archive-item-agent-root").textContent,
    ).toContain("Archive");

    // Running row: entry present but unavailable. Soft-disabled (ARIA) rather
    // than hard-disabled, so it stays keyboard-reachable and can explain
    // itself - see the keyboard-reachability test below.
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "turn"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      isMenuItemUnavailable(
        screen.getByTestId("epic-sidebar-archive-item-chat-root"),
      ),
    ).toBe(true);

    // Archived row offers the action "Unarchive".
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.archivedIds = ["chat-root"];
    testState.archiveVisibility = "all";
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      screen.getByTestId("epic-sidebar-archive-item-chat-root").textContent,
    ).toContain("Unarchive");
    const unarchiveHover = screen.getByTestId("epic-sidebar-archive-chat-root");
    expect(unarchiveHover.getAttribute("aria-label")).toBe(
      "Unarchive Root chat",
    );
  });

  // --- B7: viewer role ----------------------------------------------------

  it("gives a viewer no archive affordance and still shows the read-only lock (B7)", () => {
    seedChatTree();
    testState.permissionRole = "viewer";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // Hover button absent for viewers (requires canMutate).
    expect(screen.queryByTestId("epic-sidebar-archive-chat-child")).toBeNull();
    // Chat row ⋯ menu is gated on canEdit, so Archive and Rename are both
    // absent for viewers - not present-but-disabled.
    expect(
      screen.queryByTestId("epic-sidebar-archive-item-chat-child"),
    ).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-rename-chat-child")).toBeNull();
    expect(screen.queryByTestId("epic-sidebar-more-chat-child")).toBeNull();
    // The read-only lock must still render - do not let "no archive" become
    // "no status". Scoped to the row, since several rows carry the same label.
    const lock = readOnlyLock("chat-child");
    expect(lock).toBeTruthy();
    expect(lock === null ? null : tooltipTextIn(lock)).toBe("Read-only agent");
  });

  // --- B8: status survives selection mode and rename (archive must not blank it)

  it("keeps the row's status icon in bulk-selection and rename after the archive work (B8)", () => {
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-child"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    expect(leadingStatusKinds("chat-child")).toEqual(["activity"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    expect(leadingStatusKinds("chat-child")).toEqual(["activity"]);

    cleanup();
    seedChatTree();
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.indicatorChats = {
      "chat-child": indicator({ unreadDone: true }),
    };
    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.click(screen.getByTestId("epic-sidebar-rename-chat-child"));
    expect(
      screen.getByTestId("epic-sidebar-rename-input-chat-child"),
    ).toBeTruthy();
    expect(leadingStatusKinds("chat-child")).toEqual(["done"]);
  });

  // --- B9: mutation contract (UI side - no optimistic hide, no tab close) -

  it("calls the archive mutation without optimistically hiding the row (B9)", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByTestId("epic-sidebar-archive-chat-root"));

    expect(testState.archiveMutate).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: "chat-root",
      archived: true,
    });
    // No optimistic write: archivedIds is still empty, so the row stays.
    expect(screen.getByTestId("epic-sidebar-item-chat-root")).toBeTruthy();
  });

  it("uses the same archive mutation for a terminal-agent row (B9)", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByTestId("epic-sidebar-archive-agent-root"));

    expect(testState.archiveMutate).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      chatId: "agent-root",
      archived: true,
    });
  });

  it("removes the idle-time slot from layout when row controls are revealed", () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const idleTimeSlot = idleTime("chat-root")?.parentElement;
    expect(idleTimeSlot).toBeTruthy();
    expect(idleTimeSlot?.className).toContain("group-hover/tree-item:hidden");
    expect(idleTimeSlot?.className).toContain(
      "group-focus-within/tree-item:hidden",
    );
    expect(idleTimeSlot?.className).toContain(
      "group-has-[[data-state=open]]/tree-item:hidden",
    );
    expect(idleTimeSlot?.className).not.toContain(
      "group-hover/tree-item:invisible",
    );
  });

  // --- B10: edge behaviour ------------------------------------------------

  it("does not close the open tab when archiving the active chat (B10)", () => {
    seedChatTree();
    testState.activeArtifactId = "chat-root";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByTestId("epic-sidebar-archive-chat-root"));

    expect(testState.archiveMutate).toHaveBeenCalled();
    expect(testState.closeCanvasTab).not.toHaveBeenCalled();
  });

  it("keeps an archived chat with an open canvas tab visible and marked", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];
    testState.openTileContentIds = new Set(["chat-root"]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const row = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(row.className).toContain("opacity-55");
    const archivedLabel = within(row).getByTestId("chat-row-archived-label");
    expect(archivedLabel.textContent).toBe("Archived·");
    expect(within(archivedLabel).getByText("Archived").className).toContain(
      "font-semibold",
    );
    // The exception is row-scoped, not an implicit "All chats": an idle
    // descendant hidden by the archived root stays out.
    expect(screen.queryByTestId("epic-sidebar-item-chat-child")).toBeNull();
  });

  it("always reveals an archived busy chat with its activity indicator", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "turn"]]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const row = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(within(row).getByTestId("chat-row-archived-label")).toBeTruthy();
    expect(leadingStatusKinds("chat-root")).toEqual(["activity"]);
  });

  it("always reveals an archived unread chat with its unread indicator", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];
    testState.indicatorChats = {
      "chat-root": indicator({ unreadDone: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const row = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(within(row).getByTestId("chat-row-archived-label")).toBeTruthy();
    expect(leadingStatusKinds("chat-root")).toEqual(["done"]);
  });

  it("keeps the final archived row mounted while its tree branch exits", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];
    testState.indicatorChats = {
      "chat-root": indicator({ unreadDone: true }),
    };
    const panel = () => (
      <LazyMotion features={domMax}>
        <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />
      </LazyMotion>
    );
    const view = render(panel());

    expect(screen.getByTestId("epic-sidebar-item-chat-root")).toBeTruthy();

    testState.indicatorChats = {};
    view.rerender(panel());

    // The archived-empty branch waits until Motion finishes the tree branch's
    // exit, so the final row cannot disappear in the same render.
    expect(screen.getByTestId("epic-sidebar-item-chat-root")).toBeTruthy();
    expect(screen.queryByTestId("epic-chat-sidebar-archived-empty")).toBeNull();
  });

  it("clears archived row styling when the unarchive projection arrives", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];
    testState.openTileContentIds = new Set(["chat-root"]);
    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    expect(screen.getByTestId("chat-row-archived-label")).toBeTruthy();

    testState.archivedIds = [];
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    const row = screen.getByTestId("epic-sidebar-item-chat-root");
    expect(within(row).queryByTestId("chat-row-archived-label")).toBeNull();
    expect(row.className).not.toContain("opacity-55");
  });

  it("leaves the bulk-selection delete flow intact alongside archive (B10)", async () => {
    seedChatTree();

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select agents" }));
    fireEvent.click(screen.getByTestId("epic-sidebar-select-chat-root"));
    fireEvent.click(screen.getByTestId("epic-sidebar-delete-selected-chats"));
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(testState.deleteChatMutateAsync).toHaveBeenCalledWith({
        epicId: EPIC_ID,
        chatId: "chat-root",
      });
    });
    // Archive hover control is not the delete path.
    expect(testState.archiveMutate).not.toHaveBeenCalled();
  });

  it("shows a distinct empty state when every visible agent is archived (B10)", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-chat-sidebar-archived-empty")).toBeTruthy();
    expect(screen.getByText("Every agent here is archived.")).toBeTruthy();
    expect(
      screen.getByText('Choose "Archived only" or "All chats" under Show.'),
    ).toBeTruthy();
    // Must not falsely claim the interface filter emptied the panel.
    expect(screen.queryByText("No agents use this interface.")).toBeNull();
    expect(screen.queryByText("No agents yet.")).toBeNull();
  });

  it("shows a distinct empty state when archived-only has no matches", () => {
    seedGuiChatTree();
    testState.archiveVisibility = "archived";

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.getByTestId("epic-chat-sidebar-archived-empty")).toBeTruthy();
    expect(
      screen.getByText("No archived agents match this view."),
    ).toBeTruthy();
    expect(
      screen.getByText('Choose "Unarchived only" or "All chats" under Show.'),
    ).toBeTruthy();
  });

  it("never lets the hover archive button displace a collapsed parent's descendant rollup (B5)", () => {
    seedGuiChatTree();
    // Parent COLLAPSED, so its trailing slot rolls the hidden child up. The
    // parent itself is idle; only the hidden child needs attention. That muted
    // rollup glyph is the sole signal those descendants have.
    testState.expandedIds = new Set<string>();
    testState.indicatorChats = {
      "chat-child": indicator({ unreadFailure: true }),
    };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(
      screen.getByTestId("chat-descendant-status-failure-chat-root"),
    ).toBeTruthy();
    // The button would take over that slot and hover would blank the glyph, so
    // one click could archive the whole subtree, failure and all. The row's own
    // status being idle is NOT sufficient - the slot must be the idle time.
    expect(screen.queryByTestId("epic-sidebar-archive-chat-root")).toBeNull();

    // The menu entry stays available: it does not touch the status slot.
    expect(
      screen.getByTestId("epic-sidebar-archive-item-chat-root"),
    ).toBeTruthy();
  });

  it("reveals archived rows instead of hiding them once the host is KNOWN to lack archive support (B4/B10)", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];
    testState.archiveSupport = false;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // The invariant: an archived record must never become unreachable. Every
    // route back to one - the archive visibility filter, Unarchive entry, the
    // empty-state hint - is capability-gated, so a host that is known to lack
    // the method must stop hiding. Otherwise a row archived on a newer host and
    // then viewed from an older one is invisible with nothing left to recover
    // it (a real path: hosts can be rolled back, and the default host can
    // simply be an older machine).
    expect(screen.getByTestId("epic-sidebar-item-chat-root")).toBeTruthy();
    expect(screen.queryByTestId("epic-chat-sidebar-archived-empty")).toBeNull();
    // ...and still no affordances, because the host genuinely cannot archive.
    expect(screen.queryByTestId("epic-sidebar-archive-chat-root")).toBeNull();
  });

  it("keeps hiding archived rows while the host's support is still UNKNOWN (B4)", () => {
    seedGuiChatTree();
    testState.archivedIds = ["chat-root"];
    // No handshake yet. Revealing here would flash archived rows on every cold
    // start and hide them again a moment later, so unknown keeps hiding - only
    // a positive "known absent" reveals.
    testState.archiveSupport = null;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(screen.queryByTestId("epic-sidebar-item-chat-root")).toBeNull();
  });

  // --- B11: busy rows cannot be archived, and say why ----------------------

  /**
   * The attention tones are the regression this pins. `chatOwnStatusKind` folds
   * failure/interview/approval AHEAD of the running tier, so gating archive on
   * the folded kind left the entry enabled on a chat that was genuinely
   * mid-turn - and a pending approval is raised from inside a running turn, so
   * that is the common case, not a rare interleaving.
   */
  it("keeps Archive disabled on a running row even under an attention tone (B11)", () => {
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "turn"]]);

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    for (const attention of [
      { pendingApproval: true },
      { pendingInterview: true },
      { unreadFailure: true },
      { unreadDone: true },
    ] as const) {
      testState.indicatorChats = { "chat-root": indicator(attention) };
      view.rerender(
        <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
      );
      expect(
        isMenuItemUnavailable(
          screen.getByTestId("epic-sidebar-archive-item-chat-root"),
        ),
      ).toBe(true);
    }

    // Control: the same tones on an IDLE row leave archive available, so the
    // assertion above is pinning "running", not "any notification at all".
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    testState.indicatorChats = {
      "chat-root": indicator({ pendingApproval: true }),
    };
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    expect(
      isMenuItemUnavailable(
        screen.getByTestId("epic-sidebar-archive-item-chat-root"),
      ),
    ).toBe(false);
  });

  /**
   * The tooltip's trigger sits on the menu ITEM, with no element in between.
   *
   * A soft-disabled entry is not Radix-`disabled`, so it carries no
   * `data-disabled` and takes hover itself - the wrapper that used to be needed
   * for that is gone. Keeping the item a direct child of the menu is what
   * preserves `menu` -> `menuitem` ownership: an intermediate
   * `role="presentation"` element could NOT, because ARIA ignores a
   * presentational role on any element carrying a global ARIA property, and
   * Radix Tooltip puts `aria-describedby` on its trigger while open. The
   * wrapper stopped being presentational exactly when a keyboard user focused
   * the busy entry and opened its tooltip.
   *
   * (The `pointer-events` rule itself is CSS, which jsdom does not evaluate;
   * the mocked tooltip here renders its content eagerly, as every other tooltip
   * assertion in this file does.)
   */
  it("explains the refusal, per activity tier (B11)", () => {
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "turn"]]);

    const view = render(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );

    const turnItem = screen.getByTestId("epic-sidebar-archive-item-chat-root");
    expect(isMenuItemUnavailable(turnItem)).toBe(true);
    expect(tooltipTextIn(turnItem)).toBe(
      "Can't archive while this agent is working. Stopping it ends a turn, but not a detached subagent or workflow. Wait for it to go idle, or stop it, then archive.",
    );
    // The `turn` TIER is not "a turn is running": `chatActivityIndicator` maps
    // a detached subagent or workflow outliving its turn into it, and
    // `resolvedTurnStatus` reports no active turn for that same state so no
    // Stop-turn affordance surfaces. An unhedged "stop it" would point at an
    // action the host early-returns from.
    expect(tooltipTextIn(turnItem)).toContain("not a detached subagent");

    testState.activityTierById = new Map([["chat-root", "background"]]);
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    const bgItem = screen.getByTestId("epic-sidebar-archive-item-chat-root");
    expect(tooltipTextIn(bgItem)).toBe(
      "Can't archive while this agent has background items running. Stopping the agent won't clear them — wait for them to finish, or stop them from its chat.",
    );
    // The background arm must never advertise stopping the AGENT as the
    // remedy. `stopActiveTurn()` early-returns with no turn running, and this
    // tooltip is the only message a soft-disabled entry produces - the host's
    // corrected refusal never fires because `onSelect` is prevented. Getting
    // this wrong sends the user round a loop with nothing to correct it.
    expect(tooltipTextIn(bgItem)).toContain("stop them from its chat");

    // No wrapper: a busy entry stays a direct sibling of the other entries, so
    // the menu owns it in every state. Nesting it under a presentational node
    // would have un-owned it the moment its tooltip opened.
    expect(bgItem.parentElement).toBe(
      screen.getByTestId("epic-sidebar-rename-chat-root").parentElement,
    );

    // On an idle row there is no tooltip at all: an available action must carry
    // no explanation. Scoped to the item's own menu container rather than the
    // whole row, because an idle row also renders the hover Archive button,
    // whose own ("Archive <name>") tooltip would satisfy a looser query and
    // make this pass for the wrong reason.
    testState.activeAgentIds = new Set<string>();
    testState.activityTierById = new Map();
    view.rerender(
      <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />,
    );
    const idleItem = screen.getByTestId("epic-sidebar-archive-item-chat-root");
    expect(isMenuItemUnavailable(idleItem)).toBe(false);
    expect(tooltipTextIn(idleItem)).toBeNull();
    expect(idleItem.parentElement).toBe(
      screen.getByTestId("epic-sidebar-rename-chat-root").parentElement,
    );
  });

  it("still offers Unarchive on a running archived row (B11)", () => {
    seedChatTree();
    testState.archivedIds = ["chat-root"];
    testState.archiveVisibility = "all";
    // An inbound message auto-unarchives and wakes the agent, so archived+busy
    // is a real state - and unarchiving is the direction the host allows.
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "turn"]]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const entry = screen.getByTestId("epic-sidebar-archive-item-chat-root");
    expect(entry.textContent).toContain("Unarchive");
    expect(isMenuItemUnavailable(entry)).toBe(false);
  });

  it("keeps a busy row's Archive entry keyboard-reachable (B11)", () => {
    // Radix renders a `disabled` item as non-focusable AND filters it out of
    // typeahead. Since the hover button is hidden while the row is busy, hard
    // -disabling here would make the action and its reason invisible to
    // keyboard/screen-reader users: Archive would simply vanish from the menu
    // with no signal it exists. `aria-disabled` keeps it announced and
    // focusable while still refusing selection.
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "turn"]]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const item = screen.getByTestId("epic-sidebar-archive-item-chat-root");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    // NOT the hard-disabled form, which is what removes it from the keyboard.
    expect(item.matches(":disabled")).toBe(false);
  });

  it("puts NOTHING between the menu and a busy item (B11)", () => {
    // Any element between `role="menu"` and `role="menuitem"` breaks the
    // owned-children relationship, so the item's announced position/count goes
    // wrong - and only on busy rows. `role="presentation"` does not rescue it
    // here: ARIA ignores a presentational role on an element carrying a global
    // ARIA property, and Radix Tooltip assigns `aria-describedby` to its
    // trigger while open. A wrapper would therefore un-presentation itself at
    // the exact moment a keyboard user focused the entry and opened its
    // tooltip - the one state it was added for.
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "turn"]]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const busyItem = screen.getByTestId("epic-sidebar-archive-item-chat-root");
    // Same parent as an entry that has no tooltip: no extra level was
    // introduced for the busy one.
    expect(busyItem.parentElement).toBe(
      screen.getByTestId("epic-sidebar-rename-chat-root").parentElement,
    );
  });

  it("applies the same refusal to the CONTEXT menu entry (B11)", () => {
    // The context menu is the one path that runs against unmocked Radix in
    // this file (`@/components/ui/dropdown-menu` is mocked,
    // `@/components/ui/context-menu` is not), so it is the only place a real
    // Radix regression in the wrapper could surface.
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "background"]]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-chat-root"));

    const item = screen.getByTestId("epic-sidebar-context-archive-chat-root");
    expect(isMenuItemUnavailable(item)).toBe(true);
    // Soft-disabled, so Radix `disabled` is false and no `data-disabled`
    // pointer-events trap applies - which is what lets the tooltip trigger sit
    // on the item and keeps the item directly under the menu.
    //
    // `data-disabled` carries the whole assertion. A `:disabled` check would
    // read like a second one but could never fail here: this item is real
    // Radix, so it is a `<div role="menuitem">`, and CSS `:disabled` matches
    // only form elements. See `isMenuItemUnavailable` below.
    expect(item.hasAttribute("data-disabled")).toBe(false);
    expect(item.parentElement).toBe(
      screen.getByTestId("epic-sidebar-context-rename-chat-root")
        .parentElement ?? null,
    );
  });

  it("describes the FOCUSED item with the reason, not just the wrapper (B11)", () => {
    // The tooltip alone does not reach a screen reader. `TooltipWrapper` uses
    // `asChild`, so Radix owns `aria-describedby` on the WRAPPER while keyboard
    // focus lands on the item inside it - and ARIA descriptions are not
    // inherited by descendants. Without the item's own description the user
    // hears "Archive, dimmed" and never the reason, which is the entire point
    // of keeping the entry reachable.
    //
    // Asserted on the context menu because it runs against unmocked Radix: a
    // mock could satisfy this by construction.
    seedChatTree();
    testState.activeAgentIds = new Set(["chat-root"]);
    testState.activityTierById = new Map([["chat-root", "background"]]);

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);
    fireEvent.contextMenu(screen.getByTestId("epic-sidebar-item-chat-root"));

    const item = screen.getByTestId("epic-sidebar-context-archive-chat-root");
    const describedBy = item.getAttribute("aria-describedby");
    if (describedBy === null) {
      throw new Error("expected the item itself to carry aria-describedby");
    }
    // Must RESOLVE - a dangling id reads to a screen reader as no description
    // at all, which is exactly the bug this guards, wearing the right attribute.
    const description = document.getElementById(describedBy);
    if (description === null) {
      throw new Error(`aria-describedby '${describedBy}' resolves to nothing`);
    }
    expect(description.textContent).toContain("background items running");
    expect(description.textContent).toContain("stop them from its chat");
    // Scoped to the item that owns it, so sibling rows cannot collide.
    expect(item.contains(description)).toBe(true);
  });

  it("leaves an unexplained disabled entry undescribed (B11)", () => {
    // A transient in-flight mutation is hard-disabled and carries no reason.
    // Pointing `aria-describedby` at an element that does not exist would be
    // worse than omitting it, so the id must be absent, not empty.
    //
    // Driven through `archiveRowPending`, the PER-ROW hook. Clearing
    // `activeAgentIds` alone would leave the entry fully ENABLED, so the
    // assertion would hold for a row that is not disabled at all - passing
    // without ever reaching the state named in the title.
    seedChatTree();
    testState.activeAgentIds = new Set();
    testState.archiveRowPending = true;

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    const item = screen.getByTestId("epic-sidebar-archive-item-chat-root");
    // Genuinely unavailable...
    expect(isMenuItemUnavailable(item)).toBe(true);
    // ...and hard-disabled, so Radix keeps its own ARIA rather than ours.
    expect(item.getAttribute("aria-describedby")).toBeNull();
  });

  /**
   * A running shell is the one activity `runStatus` cannot speak for: it
   * outlives the turn that started it, so the chat reads idle while a process
   * of its own is still printing. The host refuses to archive over one, so the
   * row must refuse too - both halves of the affordance, since the hover button
   * is offered only on an idle row.
   */
  it("refuses Archive while an open session owns a running shell (B11)", () => {
    seedChatTree();
    const handle = createSessionHandle("chat-child");
    handle.store.setState({ managedCommands: [runningShell("chat-child")] });
    testState.sessionHandleByChatId = { "chat-child": handle };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    // The leading icon has always read the shell; the gate must agree with it,
    // or the row shows "working" beside an Archive that says it is idle.
    expect(leadingStatusKinds("chat-child")).toEqual(["background-activity"]);
    const entry = screen.getByTestId("epic-sidebar-archive-item-chat-child");
    expect(isMenuItemUnavailable(entry)).toBe(true);
    expect(tooltipTextIn(entry)).toBe(
      "Can't archive while this agent has background items running. Stopping the agent won't clear them — wait for them to finish, or stop them from its chat.",
    );
    expect(screen.queryByTestId("epic-sidebar-archive-chat-child")).toBeNull();
  });

  it("returns both archive affordances once the shell exits (B11)", () => {
    // Only a RUNNING shell is activity. An exited one is a durable record, and
    // gating on it would strand the row's Archive forever.
    seedChatTree();
    const handle = createSessionHandle("chat-child");
    handle.store.setState({
      managedCommands: [
        {
          ...runningShell("chat-child"),
          status: {
            state: "exited",
            exitCode: 0,
            signal: null,
            exitedAtMs: 2,
          },
        },
      ],
    });
    testState.sessionHandleByChatId = { "chat-child": handle };

    render(<EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} side="left" />);

    expect(leadingStatusKinds("chat-child")).toEqual([]);
    const entry = screen.getByTestId("epic-sidebar-archive-item-chat-child");
    expect(isMenuItemUnavailable(entry)).toBe(false);
    expect(
      screen.getByTestId("epic-sidebar-archive-chat-child"),
    ).not.toBeNull();
  });
});

/**
 * "Unavailable" as the USER experiences it, across both disable mechanisms.
 *
 * An entry that carries an explanation is soft-disabled (`aria-disabled`) so it
 * stays keyboard-reachable and can still surface its tooltip; a transient one
 * is hard-disabled. Asserting `:disabled` alone would both miss the soft form
 * and, in this file, only ever be testing the tooltip MOCK - CSS `:disabled`
 * matches form elements, and real Radix renders
 * `<div role="menuitem" aria-disabled="true">`, which it can never match.
 */
function isMenuItemUnavailable(el: HTMLElement): boolean {
  return el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";
}

function seedChatTree(): void {
  const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
  const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
  const agentRoot = treeNode(
    "agent-root",
    null,
    "Terminal agent",
    "terminal-agent",
  );
  testState.activePanelId = "chats";
  testState.expandedIds = new Set(["chat-root"]);
  testState.tree = {
    rootIds: ["chat-root", "agent-root"],
    childrenByParent: { "chat-root": ["chat-child"] },
    nodeById: {
      "agent-root": agentRoot,
      "chat-child": chatChild,
      "chat-root": chatRoot,
    },
  };
  testState.records = [chatRoot, chatChild, agentRoot].map(recordFromNode);
}

function seedGuiChatTree(): void {
  const chatRoot = treeNode("chat-root", null, "Root chat", "chat");
  const chatChild = treeNode("chat-child", "chat-root", "Child chat", "chat");
  testState.activePanelId = "chats";
  testState.expandedIds = new Set(["chat-root"]);
  testState.tree = {
    rootIds: ["chat-root"],
    childrenByParent: { "chat-root": ["chat-child"] },
    nodeById: {
      "chat-child": chatChild,
      "chat-root": chatRoot,
    },
  };
  testState.records = [chatRoot, chatChild].map(recordFromNode);
}

function seedArtifactTree(): void {
  const specRoot = treeNode("spec-root", null, "Root spec", "spec");
  const ticketChild = treeNode(
    "ticket-child",
    "spec-root",
    "Child ticket",
    "ticket",
  );
  testState.expandedIds = new Set(["spec-root"]);
  testState.tree = {
    rootIds: ["spec-root"],
    childrenByParent: { "spec-root": ["ticket-child"] },
    nodeById: {
      "spec-root": specRoot,
      "ticket-child": ticketChild,
    },
  };
  testState.records = [specRoot, ticketChild].map(recordFromNode);
}

function treeNode(
  id: string,
  parentId: string | null,
  title: string,
  type: TestTreeNode["type"],
): TestTreeNode {
  return {
    id,
    parentId,
    title,
    type,
    status: type === "ticket" ? 0 : null,
    createdAt: 1,
    updatedAt: 2,
  };
}

function recordFromNode(node: TestTreeNode): TestRecord {
  return {
    id: node.id,
    parentId: node.parentId,
    name: node.title,
    type: node.type,
    status: node.status,
    hostId: "host-1",
  };
}
