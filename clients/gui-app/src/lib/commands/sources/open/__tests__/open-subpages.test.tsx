import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  WorktreeBindingSelectorRowV12,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { OpenTileIntoTargetGroupArgs } from "@/lib/commands/actions/open-into-target";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import {
  EMPTY_PROJECTED_SLICES,
  type ArtifactProjection,
  type ChatProjection,
  type EpicProjectedSlices,
  type TuiAgentProjection,
} from "@/stores/epics/open-epic/types";

const spies = vi.hoisted(() => ({
  openTileIntoTargetGroup: vi.fn<(args: OpenTileIntoTargetGroupArgs) => void>(),
  createChatMutate: vi.fn(),
  createTuiAgent: vi.fn(),
  refreshHostDirectory: vi.fn(() => Promise.resolve([])),
}));
const activeHostIdMock = vi.hoisted<{ current: string | null }>(() => ({
  current: "default-host",
}));
const remoteHostAvailableMock = vi.hoisted<{ current: boolean }>(() => ({
  current: true,
}));
const ACTIVE_ROWS = vi.hoisted<WorktreeBindingSelectorRowV12[]>(() => [
  {
    hostId: "default-host",
    runningDir: "/work/active-repo",
    workspacePath: "/work/active-repo",
    worktreePath: null,
    mode: "local",
    isGitRepo: true,
    repoIdentifier: null,
    branch: null,
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
  },
]);
type TerminalBindingsFixture = {
  active: {
    data: {
      rows: WorktreeBindingSelectorRowV12[];
      folderlessCwd: string | null;
    };
    isPending: boolean;
    isError: boolean;
  };
  remote: {
    data: {
      rows: WorktreeBindingSelectorRowV12[];
      folderlessCwd: string | null;
    };
    isPending: boolean;
    isError: boolean;
  };
};
const terminalBindingsMock = vi.hoisted<TerminalBindingsFixture>(() => ({
  active: {
    data: {
      rows: ACTIVE_ROWS,
      folderlessCwd: "/work/default-cwd",
    },
    isPending: false,
    isError: false,
  },
  remote: {
    data: {
      rows: [
        {
          hostId: "terminal-host",
          runningDir: "/remote/feature-worktree",
          workspacePath: "/remote/repo",
          worktreePath: "/remote/feature-worktree",
          mode: "worktree" as const,
          isGitRepo: true,
          repoIdentifier: null,
          branch: "feature",
          isPrimary: false,
          isImported: false,
          setupState: "not_required" as const,
          disabledReason: null,
          sources: [],
          isGitResolvePending: false,
        },
      ] satisfies WorktreeBindingSelectorRowV12[],
      folderlessCwd: "/remote/default-cwd",
    },
    isPending: false,
    isError: false,
  },
}));
const latestConversationWorkspaceSeedMock = vi.hoisted(() => ({
  intent: {
    entries: [
      {
        kind: "local",
        workspacePath: "/repo-seeded",
        repoIdentifier: { owner: "traycerai", repo: "seeded" },
        isPrimary: true,
      },
    ],
  } satisfies WorktreeIntent,
  seed: {
    intent: null as WorktreeIntent | null,
    workspace: { folders: [], folderInfoByPath: {} },
    sourceOwnerId: "c1",
    sourceOwnerKind: "chat",
  },
}));
latestConversationWorkspaceSeedMock.seed.intent =
  latestConversationWorkspaceSeedMock.intent;

function chat(
  id: string,
  title: string,
  hostId: string | null,
): ChatProjection {
  return {
    id,
    title,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId,
    isTitleEditedByUser: false,
    archivedAt: null,
    settings: null,
  };
}
function agent(id: string, title: string): TuiAgentProjection {
  return {
    id,
    harnessId: "claude",
    title,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "agent-host",
    workspaceFolders: [],
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    archivedAt: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
  };
}
function artifact(id: string, title: string): ArtifactProjection {
  return {
    id,
    kind: "spec",
    title,
    folderName: "",
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
  };
}

const FAKE_PROJECTION: EpicProjectedSlices = {
  ...EMPTY_PROJECTED_SLICES,
  chats: {
    allIds: ["c1", "c2", "c3"],
    byId: {
      // Lives on a different host than the active one ("default-host") -
      // should carry a host badge.
      c1: chat("c1", "Chat One", "chat-host"),
      // Lives on the active host - no badge.
      c2: chat("c2", "Chat Two", "default-host"),
      // Lives on a directory-listed host whose label is blank - the badge
      // must fall back to the raw hostId, not render an empty chip.
      c3: chat("c3", "Chat Three", "blank-label-host"),
    },
  },
  tuiAgents: { allIds: ["a1"], byId: { a1: agent("a1", "Agent One") } },
  artifacts: { allIds: ["s1"], byId: { s1: artifact("s1", "Spec One") } },
};

vi.mock("@/lib/commands/actions", () => ({
  openTileIntoTargetGroup: spies.openTileIntoTargetGroup,
  openCreatedChatWhenProjected: vi.fn(),
}));
vi.mock("@/lib/commands/sources/open/use-active-epic-projection", () => ({
  useActiveEpicProjection: () => FAKE_PROJECTION,
}));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => activeHostIdMock.current,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string) => ({ mockHostId: hostId }),
}));
vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => terminalBindingsMock.active,
  useWorktreeListBindingsForEpicForClient: (args: {
    readonly client: { readonly mockHostId: string } | null;
  }) =>
    args.client?.mockHostId === "terminal-host"
      ? terminalBindingsMock.remote
      : terminalBindingsMock.active,
}));
// terminals-subpage reads the host client (passed to the mocked useTerminalList
// below); stub it so the hook does not require a <HostRuntimeProvider>.
vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: { refresh: spies.refreshHostDirectory },
  }),
  useHostClient: () => ({
    request: () => new Promise(() => {}),
    resolveHostById: (hostId: string) => {
      if (hostId === "default-host") {
        return {
          hostId,
          label: "Default Mac",
          kind: "local",
          websocketUrl: "ws://default-host.test",
          version: null,
          transportDialability: "dialable",
        };
      }
      if (hostId === "terminal-host") {
        return {
          hostId,
          label: "Remote Terminal Mac",
          kind: "remote",
          websocketUrl: remoteHostAvailableMock.current
            ? "ws://terminal-host.test"
            : null,
          version: null,
          transportDialability: remoteHostAvailableMock.current
            ? "dialable"
            : "not-dialable",
        };
      }
      return null;
    },
    getActiveHostId: () => "default-host",
    getRequestContextUserId: () => "user-test",
    onChange: () => () => undefined,
  }),
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChat: () => ({ mutate: spies.createChatMutate }),
}));
vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: () =>
    latestConversationWorkspaceSeedMock.seed,
}));
// chats-subpage resolves a mismatched chat's hostId to a friendly label; a
// host id absent from this list (e.g. an unlisted/offline host) falls back to
// the raw id in the badge.
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "chat-host",
        label: "Other Mac",
        kind: "remote",
        websocketUrl: null,
        version: null,
        transportDialability: "dialable",
      },
      {
        hostId: "blank-label-host",
        label: "",
        kind: "remote",
        websocketUrl: null,
        version: null,
        transportDialability: "dialable",
      },
      {
        hostId: "terminal-host",
        label: "Remote Terminal Mac",
        kind: "remote",
        websocketUrl: "ws://terminal-host.test",
        version: null,
        transportDialability: "dialable",
      },
    ],
  }),
}));
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: {
      sessions: [
        {
          sessionId: "term-1",
          scope: { kind: "epic", epicId: "epic-1" },
          sessionKind: "terminal",
          status: "running",
          title: "shell one",
          cwd: "/work/repo",
        },
        {
          sessionId: "term-signin",
          scope: { kind: "epic", epicId: "epic-1" },
          sessionKind: "terminal",
          status: "running",
          title: "Copilot sign-in",
          cwd: "~",
        },
        {
          sessionId: "term-setup",
          scope: { kind: "epic", epicId: "epic-1" },
          sessionKind: "terminal",
          status: "running",
          title: "Setup: traycer feature",
          cwd: "/work/repo",
        },
      ],
    },
  }),
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalog: () => ({
    harnesses: [
      {
        id: "claude",
        label: "Claude",
        available: true,
        models: [{ harnessId: "claude", slug: "sonnet", label: "Sonnet" }],
      },
      // GUI-only provider must be filtered out of the TUI harness picker.
      { id: "traycer", label: "Traycer", available: true, models: [] },
    ],
  }),
}));
vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({ create: spies.createTuiAgent, isPending: false }),
}));

import { useAgentsOpenerItems } from "@/lib/commands/sources/open/agents-subpage";
import { useTerminalsOpenerItems } from "@/lib/commands/sources/open/terminals-subpage";
import { useArtifactsOpenerItems } from "@/lib/commands/sources/open/artifacts-subpage";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  recordProviderLoginTerminal,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";
import {
  recordSetupTerminal,
  useSetupTerminalsStore,
} from "@/stores/worktree/setup-terminals";
import { isHostEpicTerminalRef } from "@/stores/epics/canvas/types";

const navigateNestedFocusSpy = vi.fn<NavigateNestedFocus>();

function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
    navigateNestedFocus: navigateNestedFocusSpy,
  };
}

const CTX: CommandContext = {
  pathname: "/",
  router: noopRouter(),
  activeTabId: "tab-1",
  activeEpicId: "epic-1",
  focusedComposerKind: null,
  targetGroupId: "group-1",
};

function renderItems(
  hook: (ctx: CommandContext) => ReadonlyArray<CommandItem>,
): ReadonlyArray<CommandItem> {
  return renderHook<ReadonlyArray<CommandItem>, unknown>(() => hook(CTX)).result
    .current;
}

function runById(items: ReadonlyArray<CommandItem>, id: string): void {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no opener item ${id}`);
  void item.run(CTX);
}

function lastTileOpen(): OpenTileIntoTargetGroupArgs {
  const call = spies.openTileIntoTargetGroup.mock.calls.at(-1);
  if (call === undefined) throw new Error("openTileIntoTargetGroup not called");
  return call[0];
}

function launchedTerminalCwd(
  ref: OpenTileIntoTargetGroupArgs["ref"],
): string | undefined {
  if (ref.type !== "terminal" || !isHostEpicTerminalRef(ref)) {
    return undefined;
  }
  return ref.legacyFallback.cwd;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  activeHostIdMock.current = "default-host";
  remoteHostAvailableMock.current = true;
  terminalBindingsMock.active.data.rows = ACTIVE_ROWS;
  terminalBindingsMock.active.data.folderlessCwd = "/work/default-cwd";
  terminalBindingsMock.active.isPending = false;
  terminalBindingsMock.active.isError = false;
  terminalBindingsMock.remote.isPending = false;
  terminalBindingsMock.remote.isError = false;
  useNewConversationModalOpenStore.getState().close();
  useNewConversationModalStore.getState().resetForTests();
  useProviderLoginTerminalsStore.setState(
    useProviderLoginTerminalsStore.getInitialState(),
    true,
  );
  useSetupTerminalsStore.setState(
    useSetupTerminalsStore.getInitialState(),
    true,
  );
});

describe("Agents opener sub-page", () => {
  it("leads with both interfaces' creation leaves, then every Agent record", () => {
    const items = renderItems(useAgentsOpenerItems);
    // Creation for both interfaces sits at the top; records follow as one list
    // rather than two interface-grouped collections.
    expect(items.slice(0, 2).map((i) => i.id)).toEqual([
      "open:chats:new",
      "open:tui:new",
    ]);
    expect(items[0].label).toBe("New agent (Chat)");
    expect(items[1].label).toBe("New agent (Terminal)");
    expect(items[1].subpage).toBeNull();
    const ids = items.map((i) => i.id);
    expect(ids).toContain("open:chats:c1");
    expect(ids).toContain("open:tui:a1");
  });

  it("preserves the leaf id prefixes the palette keys analytics off", () => {
    const items = renderItems(useAgentsOpenerItems);
    // `palette-cmdk-controller` maps `open:chats:*` -> open_chat and
    // `open:tui:*` -> open_terminal. Merging the visible category must not
    // renumber the leaves out from under that routing.
    expect(items.every((i) => /^open:(chats|tui):/.test(i.id))).toBe(true);
  });

  it("starts a Chat-interface agent and opens an existing one into the target", () => {
    const items = renderItems(useAgentsOpenerItems);
    runById(items, "open:chats:new");
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: { kind: "target-group", groupId: "group-1" },
      parentId: null,
      hostId: null,
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.composerMode,
    ).toBe("chat");
    runById(items, "open:chats:c1");
    const opened = lastTileOpen();
    expect(opened.groupId).toBe("group-1");
    expect(opened.tabId).toBe("tab-1");
    expect(opened.ref.id).toBe("c1");
    expect(opened.ref.type).toBe("chat");
    // Proves the "existing" opener leaf threads the ctx.router navigation
    // seam through instead of bypassing it.
    expect(opened.navigateNestedFocus).toBe(navigateNestedFocusSpy);
  });

  // Chat leaves reach these assertions through the merged Agents sub-page:
  // `useChatsOpenerItems` now returns `{ create, existing }`, while
  // `useAgentsOpenerItems` is the flat list the palette actually renders.
  it("badges a chat whose hostId differs from the active host, using the directory label", () => {
    const items = renderItems(useAgentsOpenerItems);
    const mismatched = items.find((i) => i.id === "open:chats:c1");
    expect(mismatched?.hostBadge).toBe("Other Mac");
  });

  it("does not badge a chat whose hostId matches the active host", () => {
    const items = renderItems(useAgentsOpenerItems);
    const matched = items.find((i) => i.id === "open:chats:c2");
    expect(matched?.hostBadge).toBeUndefined();
  });

  it("falls back to the raw hostId when the directory-listed label is blank", () => {
    const items = renderItems(useAgentsOpenerItems);
    const blankLabel = items.find((i) => i.id === "open:chats:c3");
    expect(blankLabel?.hostBadge).toBe("blank-label-host");
  });

  it("does not badge any chat while the active host id is still unresolved", () => {
    activeHostIdMock.current = null;
    const items = renderItems(useAgentsOpenerItems);
    const c1 = items.find((i) => i.id === "open:chats:c1");
    const c2 = items.find((i) => i.id === "open:chats:c2");
    const c3 = items.find((i) => i.id === "open:chats:c3");
    expect(c1?.hostBadge).toBeUndefined();
    expect(c2?.hostBadge).toBeUndefined();
    expect(c3?.hostBadge).toBeUndefined();
  });

  it("starts a Terminal-interface agent from the same category", () => {
    const items = renderItems(useAgentsOpenerItems);
    runById(items, "open:tui:new");
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: { kind: "target-group", groupId: "group-1" },
      parentId: null,
      hostId: null,
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.composerMode,
    ).toBe("terminal");
  });

  it("opens an existing Terminal-interface agent into the target group", () => {
    const items = renderItems(useAgentsOpenerItems);
    runById(items, "open:tui:a1");
    const opened = lastTileOpen();
    expect(opened.groupId).toBe("group-1");
    expect(opened.ref.id).toBe("a1");
    expect(opened.ref.type).toBe("terminal-agent");
    expect(opened.navigateNestedFocus).toBe(navigateNestedFocusSpy);
  });
});

describe("Terminals opener sub-page", () => {
  it("keeps new-terminal creation in cmdk and launches from the selected active-host workspace", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    expect(newTerminal.id).toBe("open:terminals:new");
    expect(newTerminal.label).toBe("Create new terminal");
    expect(newTerminal.subpage?.title).toBe("Create terminal in workspace");
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }

    const workspaces = renderItems(newTerminal.subpage.useItems);
    expect(spies.refreshHostDirectory).toHaveBeenCalledTimes(1);
    const activeWorkspace = workspaces.find(
      (item) => item.label === "/work/active-repo",
    );
    expect(activeWorkspace?.subpage).toBeNull();
    runById(workspaces, activeWorkspace?.id ?? "missing");
    runById(workspaces, activeWorkspace?.id ?? "missing");
    expect(spies.openTileIntoTargetGroup).toHaveBeenCalledTimes(1);

    const opened = lastTileOpen();
    expect(opened.tabId).toBe("tab-1");
    expect(opened.groupId).toBe("group-1");
    expect(opened.ref.type).toBe("terminal");
    expect(opened.ref.hostId).toBe("default-host");
    if (opened.ref.type !== "terminal") {
      throw new Error("expected terminal ref");
    }
    expect(isHostEpicTerminalRef(opened.ref)).toBe(true);
    expect(launchedTerminalCwd(opened.ref)).toBe("/work/active-repo");
  });

  it("offers other hosts as fuzzy subpages and launches through their transient client", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }
    const workspaces = renderItems(newTerminal.subpage.useItems);
    const remoteHost = workspaces.find(
      (item) => item.label === "Remote Terminal Mac",
    );
    expect(remoteHost?.subpage?.title).toBe(
      "Create terminal on Remote Terminal Mac",
    );
    if (remoteHost?.subpage === null || remoteHost?.subpage === undefined) {
      throw new Error("expected remote-host workspace subpage");
    }

    const remoteWorkspaces = renderItems(remoteHost.subpage.useItems);
    const remoteWorkspace = remoteWorkspaces.find(
      (item) => item.label === "/remote/feature-worktree",
    );
    runById(remoteWorkspaces, remoteWorkspace?.id ?? "missing");

    const opened = lastTileOpen();
    expect(opened.ref.type).toBe("terminal");
    expect(opened.ref.hostId).toBe("terminal-host");
    if (opened.ref.type !== "terminal") {
      throw new Error("expected terminal ref");
    }
    expect(isHostEpicTerminalRef(opened.ref)).toBe(true);
    expect(launchedTerminalCwd(opened.ref)).toBe("/remote/feature-worktree");
  });

  it("rechecks remote host reachability when a workspace leaf is invoked", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }
    const workspaces = renderItems(newTerminal.subpage.useItems);
    const remoteHost = workspaces.find(
      (item) => item.label === "Remote Terminal Mac",
    );
    if (remoteHost?.subpage === null || remoteHost?.subpage === undefined) {
      throw new Error("expected remote-host workspace subpage");
    }
    const remoteWorkspaces = renderItems(remoteHost.subpage.useItems);
    const remoteWorkspace = remoteWorkspaces.find(
      (item) => item.label === "/remote/feature-worktree",
    );

    // The row remains mounted with cached workspace data while the live host
    // directory changes underneath it. Invocation must use that live state.
    remoteHostAvailableMock.current = false;
    runById(remoteWorkspaces, remoteWorkspace?.id ?? "missing");

    expect(spies.openTileIntoTargetGroup).not.toHaveBeenCalled();
  });

  it("keeps reachable remote hosts selectable while no active host is resolved", () => {
    activeHostIdMock.current = null;
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }

    const workspaces = renderItems(newTerminal.subpage.useItems);
    expect(workspaces.map((item) => item.label)).toEqual([
      "Remote Terminal Mac",
    ]);
  });

  it("shows a loading hint while a remote host's workspaces are loading", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }
    const remoteHost = renderItems(newTerminal.subpage.useItems).find(
      (item) => item.label === "Remote Terminal Mac",
    );
    if (remoteHost?.subpage === null || remoteHost?.subpage === undefined) {
      throw new Error("expected remote-host workspace subpage");
    }

    terminalBindingsMock.remote.isPending = true;
    const remoteWorkspaces = renderItems(remoteHost.subpage.useItems);
    expect(remoteWorkspaces.map((item) => item.label)).toEqual([
      "Loading workspaces…",
    ]);
  });

  it("shows an error hint when a remote host's workspace query fails", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }
    const remoteHost = renderItems(newTerminal.subpage.useItems).find(
      (item) => item.label === "Remote Terminal Mac",
    );
    if (remoteHost?.subpage === null || remoteHost?.subpage === undefined) {
      throw new Error("expected remote-host workspace subpage");
    }

    terminalBindingsMock.remote.isError = true;
    const remoteWorkspaces = renderItems(remoteHost.subpage.useItems);
    expect(remoteWorkspaces.map((item) => item.label)).toEqual([
      "Couldn't load workspaces",
    ]);
  });

  it("does not offer the folderless fallback when another host owns a workspace", () => {
    terminalBindingsMock.active.data.rows = [
      { ...ACTIVE_ROWS[0], hostId: "other-host" },
    ];
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }

    const workspaces = renderItems(newTerminal.subpage.useItems);
    expect(workspaces.map((item) => item.label)).toEqual([
      "Remote Terminal Mac",
    ]);
  });

  it("keeps an unresolved workspace visible as a non-actionable checking row", () => {
    terminalBindingsMock.active.data.rows = [
      {
        ...ACTIVE_ROWS[0],
        disabledReason: "missing_worktree_path",
        isGitResolvePending: true,
      },
    ];
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }

    const checking = renderItems(newTerminal.subpage.useItems).find(
      (item) => item.label === "/work/active-repo",
    );
    if (checking === undefined) {
      throw new Error("expected checking workspace row");
    }
    expect(checking.description).toBe("Checking workspace…");
    expect(checking.statusBadge).toBe("Checking workspace…");
    expect(checking.disabled).toBe(true);
    void checking.run(CTX);
    expect(spies.openTileIntoTargetGroup).not.toHaveBeenCalled();
  });

  it("keeps setup-disabled workspaces visible as non-actionable rows", () => {
    terminalBindingsMock.active.data.rows = [
      { ...ACTIVE_ROWS[0], disabledReason: "setup_failed" },
    ];
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }

    const disabled = renderItems(newTerminal.subpage.useItems).find(
      (item) => item.label === "/work/active-repo",
    );
    if (disabled === undefined) {
      throw new Error("expected disabled workspace row");
    }
    expect(disabled.description).toBe("Workspace unavailable: failed");
    expect(disabled.statusBadge).toBe("Unavailable: failed");
    expect(disabled.disabled).toBe(true);
    void disabled.run(CTX);
    expect(spies.openTileIntoTargetGroup).not.toHaveBeenCalled();
  });

  it("shows an error when a folderless terminal directory cannot be resolved", () => {
    terminalBindingsMock.active.data.rows = [];
    terminalBindingsMock.active.data.folderlessCwd = null;
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    if (newTerminal.subpage === null) {
      throw new Error("expected terminal workspace subpage");
    }

    const error = renderItems(newTerminal.subpage.useItems).find(
      (item) => item.label === "Couldn't resolve terminal directory",
    );
    if (error === undefined) {
      throw new Error("expected folderless directory error");
    }
    void error.run(CTX);
    expect(spies.openTileIntoTargetGroup).not.toHaveBeenCalled();
  });

  it("opens an existing terminal into the target group, with no host badge", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const existingItem = items.find((i) => i.id === "open:terminals:term-1");
    // `terminal.list` is only ever queried against the active host, so every
    // listed session is already on it - never mismatched, never badged.
    expect(existingItem?.hostBadge).toBeUndefined();

    runById(items, "open:terminals:term-1");
    const existing = lastTileOpen();
    expect(existing.ref.id).toBe("term-1");
    expect(existing.ref.type).toBe("terminal");
    expect(existing.navigateNestedFocus).toBe(navigateNestedFocusSpy);
  });

  // A sign-in terminal reopened from the palette must carry its origin too -
  // `terminal.list` cannot say who created a session, so without this the
  // eviction-recreate path (correct for an ordinary shell) would spawn a bare
  // prompt under the sign-in session's id once the host lost the PTY.
  it("carries provider-login origin for a recorded sign-in session, and leaves an unrecorded one plain", () => {
    recordProviderLoginTerminal({
      hostId: "default-host",
      sessionId: "term-signin",
      providerId: "copilot",
    });
    const items = renderItems(useTerminalsOpenerItems);

    runById(items, "open:terminals:term-signin");
    const signInOpened = lastTileOpen();
    if (signInOpened.ref.type !== "terminal") {
      throw new Error("expected terminal");
    }
    expect(signInOpened.ref.origin).toBe("provider-login");
    expect(signInOpened.ref.originProviderId).toBe("copilot");

    runById(items, "open:terminals:term-1");
    const plainOpened = lastTileOpen();
    if (plainOpened.ref.type !== "terminal") {
      throw new Error("expected terminal");
    }
    expect(plainOpened.ref.origin).toBeUndefined();
  });

  it("carries setup origin for a recorded setup session, and leaves an unrecorded one plain", () => {
    recordSetupTerminal({
      hostId: "default-host",
      sessionId: "term-setup",
    });
    const items = renderItems(useTerminalsOpenerItems);

    runById(items, "open:terminals:term-setup");
    const setupOpened = lastTileOpen();
    if (setupOpened.ref.type !== "terminal") {
      throw new Error("expected terminal");
    }
    expect(setupOpened.ref.origin).toBe("setup");

    runById(items, "open:terminals:term-1");
    const plainOpened = lastTileOpen();
    if (plainOpened.ref.type !== "terminal") {
      throw new Error("expected terminal");
    }
    expect(plainOpened.ref.origin).toBeUndefined();
  });
});

describe("Artifacts opener sub-page", () => {
  it("lists existing artifacts and opens them into the target", () => {
    const items = renderItems(useArtifactsOpenerItems);
    expect(items.map((i) => i.id)).toEqual(["open:artifacts:s1"]);
    runById(items, "open:artifacts:s1");
    const opened = lastTileOpen();
    expect(opened.groupId).toBe("group-1");
    expect(opened.ref.id).toBe("s1");
    expect(opened.ref.type).toBe("spec");
    expect(opened.navigateNestedFocus).toBe(navigateNestedFocusSpy);
  });
});
