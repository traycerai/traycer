import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import type { OpenTileIntoTargetGroupArgs } from "@/lib/commands/actions/open-into-target";
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

const terminalBindingsMock = vi.hoisted(() => ({
  rows: [
    {
      hostId: "host-2",
      runningDir: "/work/traycer-wt/feature-x",
      workspacePath: "/work/traycer",
      worktreePath: "/work/traycer-wt/feature-x",
      mode: "worktree",
      isGitRepo: true,
      repoIdentifier: { owner: "traycer", repo: "traycer" },
      branch: "feature-x",
      isPrimary: false,
      isImported: false,
      setupState: "not_required",
      disabledReason: null,
      sources: [],
    },
  ] satisfies WorktreeBindingSelectorRow[],
}));

function chat(id: string, title: string): ChatProjection {
  return {
    id,
    title,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "chat-host",
    isTitleEditedByUser: false,
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
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
  };
}

const FAKE_PROJECTION: EpicProjectedSlices = {
  ...EMPTY_PROJECTED_SLICES,
  chats: { allIds: ["c1"], byId: { c1: chat("c1", "Chat One") } },
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
  useReactiveActiveHostId: () => "default-host",
}));
// terminals-subpage reads the host client (passed to the mocked useTerminalList
// below); stub it so the hook does not require a <HostRuntimeProvider>.
vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: () => new Promise(() => {}),
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
vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: { rows: terminalBindingsMock.rows },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: {
      sessions: [
        {
          sessionId: "term-1",
          sessionKind: "terminal",
          status: "running",
          title: "shell one",
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

import { useChatsOpenerItems } from "@/lib/commands/sources/open/chats-subpage";
import { useTuiOpenerItems } from "@/lib/commands/sources/open/tui-subpage";
import { useTerminalsOpenerItems } from "@/lib/commands/sources/open/terminals-subpage";
import { useArtifactsOpenerItems } from "@/lib/commands/sources/open/artifacts-subpage";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

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

function renderSubpageItems(item: CommandItem): ReadonlyArray<CommandItem> {
  if (item.subpage === null) throw new Error(`${item.id} has no subpage`);
  const subpage = item.subpage;
  return renderHook<ReadonlyArray<CommandItem>, unknown>(() =>
    subpage.useItems(CTX),
  ).result.current;
}

function lastTileOpen(): OpenTileIntoTargetGroupArgs {
  const call = spies.openTileIntoTargetGroup.mock.calls.at(-1);
  if (call === undefined) throw new Error("openTileIntoTargetGroup not called");
  return call[0];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useNewConversationModalOpenStore.getState().close();
  useNewConversationModalStore.getState().resetForTests();
});

describe("Chats opener sub-page", () => {
  it("pins New chat first, then lists existing chats", () => {
    const items = renderItems(useChatsOpenerItems);
    expect(items[0].id).toBe("open:chats:new");
    expect(items[0].label).toBe("Create new chat");
    expect(items.map((i) => i.id)).toContain("open:chats:c1");
  });

  it("New chat opens the modal in chat mode into the target; existing opens into the target", () => {
    const items = renderItems(useChatsOpenerItems);
    runById(items, "open:chats:new");
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: { kind: "target-group", groupId: "group-1" },
      parentId: null,
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
  });
});

describe("Terminals opener sub-page", () => {
  it("pins New terminal first, then opens a picked folder into the target", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    expect(newTerminal.id).toBe("open:terminals:new");
    expect(newTerminal.subpage).not.toBeNull();
    const folderItems = renderSubpageItems(newTerminal);
    runById(
      folderItems,
      "open:terminals:new:host-2:%2Fwork%2Ftraycer-wt%2Ffeature-x",
    );
    const created = lastTileOpen();
    expect(created.groupId).toBe("group-1");
    expect(created.ref.type).toBe("terminal");
    if (created.ref.type !== "terminal") throw new Error("expected terminal");
    expect(created.ref.hostId).toBe("host-2");
    expect(created.ref.cwd).toBe("/work/traycer-wt/feature-x");
    expect(created.ref.name).toBe("New Terminal");
    runById(items, "open:terminals:term-1");
    const existing = lastTileOpen();
    expect(existing.ref.id).toBe("term-1");
    expect(existing.ref.type).toBe("terminal");
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
  });
});

describe("TUI opener sub-page", () => {
  it("pins Create new TUI agent first (no sub-page), then existing agents", () => {
    const items = renderItems(useTuiOpenerItems);
    expect(items[0].id).toBe("open:tui:new");
    expect(items[0].label).toBe("Create new TUI agent");
    expect(items[0].subpage).toBeNull();
    expect(items.map((i) => i.id)).toContain("open:tui:a1");
  });

  it("existing agent opens into the target group", () => {
    const items = renderItems(useTuiOpenerItems);
    runById(items, "open:tui:a1");
    const opened = lastTileOpen();
    expect(opened.groupId).toBe("group-1");
    expect(opened.ref.id).toBe("a1");
    expect(opened.ref.type).toBe("terminal-agent");
  });

  it("Create new TUI agent opens the modal in terminal mode into the target", () => {
    const items = renderItems(useTuiOpenerItems);
    runById(items, "open:tui:new");
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: { kind: "target-group", groupId: "group-1" },
      parentId: null,
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.composerMode,
    ).toBe("terminal");
  });
});
