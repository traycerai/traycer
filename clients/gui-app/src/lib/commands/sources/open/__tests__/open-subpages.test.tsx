import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
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
}));
const activeHostIdMock = vi.hoisted<{ current: string | null }>(() => ({
  current: "default-host",
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
        status: "available",
      },
      {
        hostId: "blank-label-host",
        label: "",
        kind: "remote",
        websocketUrl: null,
        version: null,
        status: "available",
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
import { useNewTerminalModalOpenStore } from "@/stores/epics/new-terminal-modal-open-store";

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  activeHostIdMock.current = "default-host";
  useNewConversationModalOpenStore.getState().close();
  useNewConversationModalStore.getState().resetForTests();
  useNewTerminalModalOpenStore.getState().close();
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
    // Proves the "existing" opener leaf threads the ctx.router navigation
    // seam through instead of bypassing it.
    expect(opened.navigateNestedFocus).toBe(navigateNestedFocusSpy);
  });

  it("badges a chat whose hostId differs from the active host, using the directory label", () => {
    const items = renderItems(useChatsOpenerItems);
    const mismatched = items.find((i) => i.id === "open:chats:c1");
    expect(mismatched?.hostBadge).toBe("Other Mac");
  });

  it("does not badge a chat whose hostId matches the active host", () => {
    const items = renderItems(useChatsOpenerItems);
    const matched = items.find((i) => i.id === "open:chats:c2");
    expect(matched?.hostBadge).toBeUndefined();
  });

  it("falls back to the raw hostId when the directory-listed label is blank", () => {
    const items = renderItems(useChatsOpenerItems);
    const blankLabel = items.find((i) => i.id === "open:chats:c3");
    expect(blankLabel?.hostBadge).toBe("blank-label-host");
  });

  it("does not badge any chat while the active host id is still unresolved", () => {
    activeHostIdMock.current = null;
    const items = renderItems(useChatsOpenerItems);
    const c1 = items.find((i) => i.id === "open:chats:c1");
    const c2 = items.find((i) => i.id === "open:chats:c2");
    const c3 = items.find((i) => i.id === "open:chats:c3");
    expect(c1?.hostBadge).toBeUndefined();
    expect(c2?.hostBadge).toBeUndefined();
    expect(c3?.hostBadge).toBeUndefined();
  });
});

describe("Terminals opener sub-page", () => {
  it("Create new terminal opens the palette's terminal-creation dialog for the target group, instead of a folder sub-page", () => {
    const items = renderItems(useTerminalsOpenerItems);
    const newTerminal = items[0];
    expect(newTerminal.id).toBe("open:terminals:new");
    expect(newTerminal.label).toBe("Create new terminal");
    expect(newTerminal.subpage).toBeNull();

    runById(items, "open:terminals:new");

    expect(useNewTerminalModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      groupId: "group-1",
    });
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
    expect(opened.navigateNestedFocus).toBe(navigateNestedFocusSpy);
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
