import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useMaybeEpicTuiAgentHarnessId } from "@/lib/epic-selectors";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";

const handles: OpenEpicStoreHandle[] = [];

afterEach(() => {
  cleanup();
  for (const handle of handles) {
    handle.dispose();
  }
  handles.length = 0;
});

describe("useMaybeEpicTuiAgentHarnessId", () => {
  it("returns null outside an open-epic session", () => {
    const { result } = renderHook(() =>
      useMaybeEpicTuiAgentHarnessId("agent-1"),
    );

    expect(result.current).toBeNull();
  });

  it("returns null when no tuiAgents.byId entry matches the node id", () => {
    const handle = createHandle("epic-missing-agent");

    const { result } = renderHook(
      () => useMaybeEpicTuiAgentHarnessId("agent-1"),
      { wrapper: openEpicWrapper(handle) },
    );

    expect(result.current).toBeNull();
  });

  it("returns the matching tuiAgents.byId harnessId", () => {
    const handle = createHandle("epic-with-agent");
    handle.store.setState({
      tuiAgents: {
        allIds: ["agent-1"],
        byId: {
          "agent-1": tuiAgent("agent-1", "codex"),
        },
      },
    });

    const { result } = renderHook(
      () => useMaybeEpicTuiAgentHarnessId("agent-1"),
      { wrapper: openEpicWrapper(handle) },
    );

    expect(result.current).toBe("codex");
  });

  it("updates when tuiAgents.byId changes after mount", () => {
    const handle = createHandle("epic-live-update");

    const { result } = renderHook(
      () => useMaybeEpicTuiAgentHarnessId("agent-1"),
      { wrapper: openEpicWrapper(handle) },
    );

    expect(result.current).toBeNull();

    act(() => {
      handle.store.setState({
        tuiAgents: {
          allIds: ["agent-1"],
          byId: {
            "agent-1": tuiAgent("agent-1", "codex"),
          },
        },
      });
    });

    expect(result.current).toBe("codex");
  });
});

function createHandle(epicId: string): OpenEpicStoreHandle {
  const handle = createOpenEpicStore({
    epicId,
    userId: null,
    streamClientFactory: fakeStreamClientFactory,
    onAuthError: null,
  });
  handles.push(handle);
  return handle;
}

function openEpicWrapper(handle: OpenEpicStoreHandle) {
  return function OpenEpicWrapper(props: { readonly children: ReactNode }) {
    return (
      <EpicSessionContext.Provider value={handle}>
        {props.children}
      </EpicSessionContext.Provider>
    );
  };
}

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function tuiAgent(id: string, harnessId: TuiHarnessId): TuiAgentProjection {
  return {
    id,
    harnessId,
    title: "Codex",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-a",
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
