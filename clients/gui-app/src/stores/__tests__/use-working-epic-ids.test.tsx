/**
 * The list's "In progress" set must use the row icon's liveness rule: host
 * activity naming an agent a LIVE epic projection no longer holds is not work,
 * and dropping that agent from the projection has to notify the list.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { useWorkingEpicIds } from "@/stores/use-working-epic-ids";

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

function publishWorking(agentIds: readonly string[]): void {
  publishAgentActivity([
    {
      hostId: "host-a",
      byEpic: { [EPIC_ID]: { working: agentIds, turn: agentIds } },
    },
  ]);
}

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
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
