/**
 * `useRegisteredEpicAgentSessionCounts` answers for ONE host.
 *
 * The Resource Manager renders one section per epic under a host its own
 * picker chose, and that scope is what the process projection is attributed
 * to (`attributedProjection` empties the panel for a reading from anywhere
 * else). The running/sleeping counts on those section headers come from the
 * open-epic session this WINDOW happens to hold - which is a session for
 * whichever host the epic is open on, not for the host being viewed.
 *
 * So an epic open on host A, viewed under host B, printed A's numbers in B's
 * header. The counts are per-agent-session facts about specific machines, so
 * there is no reading of them that is true of B.
 *
 * The answer is OMISSION, not zero: the map's own contract is that an epic
 * this window holds no session for is absent rather than zero ("we hold no
 * session for it" and "it has no agents" are different answers), and a header
 * with no count is what the caller already renders for that case.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  __getOpenEpicRegistryForTests,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import type { AgentSessionState } from "@traycer/protocol/host/agent-session-state";
import { useRegisteredEpicAgentSessionCounts } from "@/lib/epic-selectors";

const EPIC_ID = "epic-counts-host-scope";
const HOST_A = "host-a";
const HOST_B = "host-b";

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function agentRow(
  id: string,
  sessionState: AgentSessionState | null,
  hostId: string,
): TuiAgentProjection {
  return {
    id,
    docResident: false,
    origin: "registry",
    harnessId: "claude",
    title: id,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: "user-1",
    hostId,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: [],
    sessionState,
    lastExit: null,
    workspaceFolders: [],
    workspaceMode: undefined,
    archivedAt: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
  };
}

/** An epic open on `sessionHostId`, holding 2 running and 3 sleeping agents. */
function registerSessionOnHost(sessionHostId: string): OpenEpicStoreHandle {
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
  handleHostIds.set(handle, sessionHostId);
  const rows: TuiAgentProjection[] = [
    agentRow("run-1", "running", sessionHostId),
    agentRow("run-2", "running", sessionHostId),
    agentRow("sleep-1", "sleeping", sessionHostId),
    agentRow("sleep-2", "sleeping", sessionHostId),
    agentRow("sleep-3", "sleeping", sessionHostId),
  ];
  handle.store.setState({
    tuiAgents: {
      allIds: rows.map((row) => row.id),
      byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    },
  });
  return handle;
}

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
});

describe("useRegisteredEpicAgentSessionCounts is scoped to the reading's host", () => {
  it("counts the epic's agents when the session's host IS the host being read", () => {
    registerSessionOnHost(HOST_A);
    const { result } = renderHook(() =>
      useRegisteredEpicAgentSessionCounts([EPIC_ID], HOST_A),
    );
    expect(result.current.get(EPIC_ID)).toEqual({ running: 2, sleeping: 3 });
  });

  it("OMITS the epic when the only session is another host's view of it", () => {
    // THE CLAIM. Host B's Resource Manager section for this epic must not
    // print host A's 2/3. There is no correct number available here - this
    // window holds no session for B - so the header shows none.
    registerSessionOnHost(HOST_A);
    const { result } = renderHook(() =>
      useRegisteredEpicAgentSessionCounts([EPIC_ID], HOST_B),
    );
    expect(result.current.has(EPIC_ID)).toBe(false);
  });

  it("OMITS the epic when the session's host is unknown", () => {
    // An unattributed handle is not evidence for any host. Counting it under
    // whichever host happens to be on screen is the same guess by another
    // route.
    const handle = registerSessionOnHost(HOST_A);
    handleHostIds.set(handle, null);
    const { result } = renderHook(() =>
      useRegisteredEpicAgentSessionCounts([EPIC_ID], HOST_A),
    );
    expect(result.current.has(EPIC_ID)).toBe(false);
  });

  it("OMITS every epic when the reading itself is not attributed to a host", () => {
    // The panel has no scoped host yet. Nothing can be attributed, so nothing
    // is claimed.
    registerSessionOnHost(HOST_A);
    const { result } = renderHook(() =>
      useRegisteredEpicAgentSessionCounts([EPIC_ID], null),
    );
    expect(result.current.has(EPIC_ID)).toBe(false);
  });

  it("skips a ROW bound to another host inside a matching session", () => {
    // A session on A can hold rows for agents that live elsewhere. Their
    // facet is `null` today (only a binding host observes its own session
    // transitions), so they already fall out of both counts - but the count
    // is the host's, and reading it off the row makes that local rather than
    // dependent on the facet staying null for a peer row.
    const handle = registerSessionOnHost(HOST_A);
    const stranger = agentRow("run-elsewhere", "running", HOST_B);
    const state = handle.store.getState();
    handle.store.setState({
      tuiAgents: {
        allIds: [...state.tuiAgents.allIds, stranger.id],
        byId: { ...state.tuiAgents.byId, [stranger.id]: stranger },
      },
    });
    const { result } = renderHook(() =>
      useRegisteredEpicAgentSessionCounts([EPIC_ID], HOST_A),
    );
    expect(result.current.get(EPIC_ID)).toEqual({ running: 2, sleeping: 3 });
  });
});
