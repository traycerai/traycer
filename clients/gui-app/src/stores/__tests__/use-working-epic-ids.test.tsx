/**
 * The list's "In progress" set must use the row icon's liveness rule: host
 * activity naming an agent a LIVE epic projection no longer holds is not work,
 * and dropping that agent from the projection has to notify the list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { epicActivityStatusFromSources } from "@/hooks/epic/use-epic-activity-status";
import type { ChatProjection } from "@/stores/epics/open-epic/types";
import { useOwnTurnEpicIds } from "@/stores/use-own-turn-epic-ids";
import {
  useTurnEpicIds,
  useWorkingEpicIds,
} from "@/stores/use-working-epic-ids";

// Spy only: the real rule still runs, so the assertions below are about HOW OFTEN
// the aggregate scan asks it, not about what it answers.
vi.mock("@/hooks/epic/use-epic-activity-status", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/epic/use-epic-activity-status")
    >();
  return {
    ...actual,
    epicActivityStatusFromSources: vi.fn(actual.epicActivityStatusFromSources),
  };
});

const EPIC_ID = "epic-working";
const AGENT_ID = "chat-1";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function registerSessionHoldingAgents(agentIds: readonly string[]) {
  const handle = __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
    openStoreForTest({
      epicId: EPIC_ID,
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    }),
  );
  handle.store.setState({ chats: { allIds: [...agentIds], byId: {} } });
  return handle;
}

function chatProjection(id: string, userId: string): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    userId,
    hostId: "host-a",
    isTitleEditedByUser: false,
    docResident: false,
    settings: null,
    archivedAt: null,
  };
}

function publishWorking(agentIds: readonly string[]): void {
  publishAgentActivity([
    {
      hostId: "host-a",
      byEpic: { [EPIC_ID]: { working: agentIds, turn: agentIds } },
    },
  ]);
}

function registerOwnedWarmChat(accessPending: boolean) {
  const handle = __getChatSessionRegistryForTests().acquire(
    {
      epicId: EPIC_ID,
      chatId: AGENT_ID,
      hostId: "host-a",
      scopeKey: "history-activity-test",
    },
    () =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: "host-a",
        epicId: EPIC_ID,
        chatId: AGENT_ID,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      }),
  );
  const shell: ManagedCommand = {
    id: "cmd-1",
    monitoring: false,
    description: "dev server",
    command: "tail -f deploy.log",
    cwd: "/work/repo",
    cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
    status: { state: "running", pid: 4242, startedAtMs: 1 },
    chatId: AGENT_ID,
    relaunchOnHostRestart: false,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  handle.store.setState({
    access: accessPending
      ? null
      : { role: "owner", ownerUserId: "viewer", canAct: true },
    managedCommands: [shell],
  });
  return handle;
}

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
  disposeAllChatSessions();
  resetAgentActivity();
});

describe("useWorkingEpicIds", () => {
  it("counts host-reported work for an epic this window has never opened", () => {
    const { result } = renderHook(() => useWorkingEpicIds());
    act(() => {
      publishWorking([AGENT_ID]);
    });
    expect([...result.current]).toEqual([EPIC_ID]);
  });

  it("excludes a host-reported working chat that the live projection no longer holds", () => {
    registerSessionHoldingAgents([]);
    const { result } = renderHook(() => useWorkingEpicIds());
    act(() => {
      publishWorking([AGENT_ID]);
    });
    expect(result.current.has(EPIC_ID)).toBe(false);
  });

  it("notifies when removing the agent from the projection ends the epic's work", () => {
    const handle = registerSessionHoldingAgents([AGENT_ID]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useWorkingEpicIds();
    });
    act(() => {
      publishWorking([AGENT_ID]);
    });
    expect(result.current.has(EPIC_ID)).toBe(true);
    const rendersBeforeRemoval = renders;

    act(() => {
      handle.store.setState({ chats: { allIds: [], byId: {} } });
    });

    expect(result.current.has(EPIC_ID)).toBe(false);
    expect(renders).toBeGreaterThan(rendersBeforeRemoval);
  });

  it("notifies when the agent joins the projection and the epic starts counting", () => {
    const handle = registerSessionHoldingAgents([]);
    const { result } = renderHook(() => useWorkingEpicIds());
    act(() => {
      publishWorking([AGENT_ID]);
    });
    expect(result.current.has(EPIC_ID)).toBe(false);

    act(() => {
      handle.store.setState({ chats: { allIds: [AGENT_ID], byId: {} } });
    });

    expect(result.current.has(EPIC_ID)).toBe(true);
  });
});

function publishBackgroundOnly(agentIds: readonly string[]): void {
  publishAgentActivity([
    {
      hostId: "host-a",
      byEpic: { [EPIC_ID]: { working: agentIds, turn: [] } },
    },
  ]);
}

describe("useTurnEpicIds", () => {
  it("counts an epic with an agent turn in progress", () => {
    const { result } = renderHook(() => useTurnEpicIds());
    act(() => {
      publishWorking([AGENT_ID]);
    });
    expect([...result.current]).toEqual([EPIC_ID]);
  });

  it("leaves out an epic whose only activity is background work, which useWorkingEpicIds still counts", () => {
    const turn = renderHook(() => useTurnEpicIds());
    const working = renderHook(() => useWorkingEpicIds());
    act(() => {
      publishBackgroundOnly([AGENT_ID]);
    });
    expect(turn.result.current.has(EPIC_ID)).toBe(false);
    expect(working.result.current.has(EPIC_ID)).toBe(true);
  });

  it("notifies when a background-only epic starts a turn", () => {
    const { result } = renderHook(() => useTurnEpicIds());
    act(() => {
      publishBackgroundOnly([AGENT_ID]);
    });
    expect(result.current.has(EPIC_ID)).toBe(false);

    act(() => {
      publishWorking([AGENT_ID]);
    });
    expect(result.current.has(EPIC_ID)).toBe(true);
  });
});

describe("useOwnTurnEpicIds", () => {
  it("does not treat a collaborator's turn as the viewer's Recent activity", () => {
    const handle = registerSessionHoldingAgents(["foreign", "mine"]);
    handle.store.setState({
      chats: {
        allIds: ["foreign", "mine"],
        byId: {
          foreign: chatProjection("foreign", "collaborator"),
          mine: chatProjection("mine", "viewer"),
        },
      },
    });
    const { result } = renderHook(() => useOwnTurnEpicIds("viewer"));

    act(() => publishWorking(["foreign"]));
    expect(result.current.has(EPIC_ID)).toBe(false);

    // The epic was already active; the owner-specific subscription must still
    // notice that one of this viewer's chats began a turn.
    act(() => publishWorking(["foreign", "mine"]));
    expect(result.current.has(EPIC_ID)).toBe(true);

    act(() => publishWorking(["foreign"]));
    expect(result.current.has(EPIC_ID)).toBe(false);
  });

  it("does not stamp a cold agent whose owner is unknown", () => {
    const { result } = renderHook(() => useOwnTurnEpicIds("viewer"));
    act(() => publishWorking([AGENT_ID]));
    expect(result.current.has(EPIC_ID)).toBe(false);
  });

  it("lets an owned warm background tier suppress an older host's unclassified turn", () => {
    const epic = registerSessionHoldingAgents([AGENT_ID]);
    epic.store.setState({
      chats: {
        allIds: [AGENT_ID],
        byId: { [AGENT_ID]: chatProjection(AGENT_ID, "viewer") },
      },
    });
    const chat = registerOwnedWarmChat(false);
    const { result } = renderHook(() => useOwnTurnEpicIds("viewer"));

    act(() => publishWorking([AGENT_ID]));
    expect(result.current.has(EPIC_ID)).toBe(false);

    act(() => {
      chat.store.setState({ runStatus: "running", turnInProgress: true });
    });
    expect(result.current.has(EPIC_ID)).toBe(true);
  });

  it("uses the owned epic projection while chat access is still hydrating", () => {
    const epic = registerSessionHoldingAgents([AGENT_ID]);
    epic.store.setState({
      chats: {
        allIds: [AGENT_ID],
        byId: { [AGENT_ID]: chatProjection(AGENT_ID, "viewer") },
      },
    });
    const chat = registerOwnedWarmChat(true);
    const { result } = renderHook(() => useOwnTurnEpicIds("viewer"));

    act(() => publishWorking([AGENT_ID]));
    expect(result.current.has(EPIC_ID)).toBe(false);

    act(() => {
      chat.store.setState({
        access: { role: "owner", ownerUserId: "viewer", canAct: true },
        runStatus: "running",
        turnInProgress: true,
      });
    });
    expect(result.current.has(EPIC_ID)).toBe(true);
  });
});

describe("useWorkingEpicIds ignores unrelated session updates", () => {
  it("does not rescan on an epic-store write that touches neither chats nor tuiAgents, but does when the agent list changes", () => {
    const handle = registerSessionHoldingAgents([AGENT_ID]);
    renderHook(() => useWorkingEpicIds());
    act(() => {
      publishWorking([AGENT_ID]);
    });
    const scan = vi.mocked(epicActivityStatusFromSources);
    scan.mockClear();

    act(() => {
      handle.store.setState((state) => ({
        epic: { ...state.epic, title: "Unrelated transcript-side update" },
      }));
    });
    expect(scan).not.toHaveBeenCalled();

    act(() => {
      handle.store.setState({ chats: { allIds: [], byId: {} } });
    });
    expect(scan).toHaveBeenCalled();
  });
});
