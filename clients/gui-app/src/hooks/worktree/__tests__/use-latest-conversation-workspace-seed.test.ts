import { describe, expect, it } from "vitest";
import type {
  ChatProjection,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";
import { latestCreatedConversationOwner } from "@/hooks/worktree/use-latest-conversation-workspace-seed";

function chat(
  id: string,
  createdAt: number,
  updatedAt: number,
): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt,
    updatedAt,
    userId: null,
    hostId: "host-1",
    chatKind: "conversation",
    isTitleEditedByUser: false,
    // Ordinary registry-backed chat - this suite exercises workspace-seed
    // ordering, not doc residency.
    docResident: false,
    archivedAt: null,
    settings: null,
  };
}

function terminalAgent(
  id: string,
  createdAt: number,
  updatedAt: number,
): TuiAgentProjection {
  return {
    id,
    // An ordinary registry-backed agent - this suite exercises workspace-seed
    // ordering, not doc residency.
    docResident: false,
    origin: "registry",
    harnessId: "claude",
    title: id,
    parentId: null,
    createdAt,
    updatedAt,
    userId: null,
    hostId: "host-1",
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
    sessionState: null,
    lastExit: null,
  };
}

function evolutionChat(id: string, createdAt: number): ChatProjection {
  return { ...chat(id, createdAt, createdAt), chatKind: "evolution" };
}

describe("latestCreatedConversationOwner", () => {
  it("skips a newer identity evolution chat, so the older conversation seeds the workspace", () => {
    const projectChat = chat("project-chat", 1, 1);
    const evolutionPass = evolutionChat("evolution-pass", 2);

    expect(
      latestCreatedConversationOwner({
        chats: {
          allIds: [projectChat.id, evolutionPass.id],
          byId: {
            [projectChat.id]: projectChat,
            [evolutionPass.id]: evolutionPass,
          },
        },
        tuiAgents: { allIds: [], byId: {} },
      }),
    ).toEqual({
      id: projectChat.id,
      ownerKind: "chat",
      createdAt: projectChat.createdAt,
      hostId: projectChat.hostId,
    });
  });

  it("keeps an older terminal agent as the owner (and so the terminal composer mode) over a newer evolution chat", () => {
    const olderTerminalAgent = terminalAgent("older-terminal-agent", 1, 1);
    const evolutionPass = evolutionChat("evolution-pass", 2);

    expect(
      latestCreatedConversationOwner({
        chats: {
          allIds: [evolutionPass.id],
          byId: { [evolutionPass.id]: evolutionPass },
        },
        tuiAgents: {
          allIds: [olderTerminalAgent.id],
          byId: { [olderTerminalAgent.id]: olderTerminalAgent },
        },
      }),
    ).toMatchObject({
      id: olderTerminalAgent.id,
      ownerKind: "terminal-agent",
    });
  });

  it("returns null when the epic has no chats or terminal agents", () => {
    expect(
      latestCreatedConversationOwner({
        chats: { allIds: [], byId: {} },
        tuiAgents: { allIds: [], byId: {} },
      }),
    ).toBeNull();
  });

  it("selects the most recently created owner across chats and terminal agents", () => {
    const olderUpdatedChat = chat("older-updated-chat", 1, 99);
    const newerTerminalAgent = terminalAgent("newer-terminal-agent", 2, 2);

    expect(
      latestCreatedConversationOwner({
        chats: {
          allIds: [olderUpdatedChat.id],
          byId: { [olderUpdatedChat.id]: olderUpdatedChat },
        },
        tuiAgents: {
          allIds: [newerTerminalAgent.id],
          byId: { [newerTerminalAgent.id]: newerTerminalAgent },
        },
      }),
    ).toEqual({
      id: newerTerminalAgent.id,
      ownerKind: "terminal-agent",
      createdAt: newerTerminalAgent.createdAt,
      hostId: newerTerminalAgent.hostId,
    });
  });

  it("selects a newer chat when it is newer than terminal agents", () => {
    const olderTerminalAgent = terminalAgent("older-terminal-agent", 1, 99);
    const newerChat = chat("newer-chat", 2, 2);

    expect(
      latestCreatedConversationOwner({
        chats: {
          allIds: [newerChat.id],
          byId: { [newerChat.id]: newerChat },
        },
        tuiAgents: {
          allIds: [olderTerminalAgent.id],
          byId: { [olderTerminalAgent.id]: olderTerminalAgent },
        },
      }),
    ).toEqual({
      id: newerChat.id,
      ownerKind: "chat",
      createdAt: newerChat.createdAt,
      hostId: newerChat.hostId,
    });
  });

  it("breaks equal createdAt ties deterministically by owner kind and id", () => {
    const chatOwner = chat("same-time", 1, 1);
    const terminalAgentOwner = terminalAgent("same-time", 1, 1);

    expect(
      latestCreatedConversationOwner({
        chats: {
          allIds: [chatOwner.id],
          byId: { [chatOwner.id]: chatOwner },
        },
        tuiAgents: {
          allIds: [terminalAgentOwner.id],
          byId: { [terminalAgentOwner.id]: terminalAgentOwner },
        },
      }),
    ).toEqual({
      id: terminalAgentOwner.id,
      ownerKind: "terminal-agent",
      createdAt: terminalAgentOwner.createdAt,
      hostId: terminalAgentOwner.hostId,
    });
  });
});
