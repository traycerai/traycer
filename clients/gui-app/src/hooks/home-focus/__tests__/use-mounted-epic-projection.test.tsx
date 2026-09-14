import { useMemo, useState } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatProjection,
  TuiAgentProjection,
} from "@/stores/epics/open-epic/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { focusAgentKey } from "@/lib/home-focus/focus-tasks";
import {
  useMountedEpicProjection,
  type MountedEpicRef,
} from "@/hooks/home-focus/use-mounted-epic-projection";

/**
 * `useMountedEpicProjection` reads the REAL open-epic registry - the shape
 * `useRegisteredEpicLiveAgents` already uses (`epic-selectors.test.tsx`) - so
 * it is exercised against a real in-process runtime worker via
 * `openStoreForTest`, never a mock of the hook under test.
 */
const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function chatProjection(
  id: string,
  overrides: Partial<ChatProjection>,
): ChatProjection {
  return {
    id,
    title: "Chat",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId: "host-a",
    isTitleEditedByUser: false,
    docResident: false,
    archivedAt: null,
    settings: null,
    ...overrides,
  };
}

function tuiAgentProjection(
  id: string,
  overrides: Partial<TuiAgentProjection>,
): TuiAgentProjection {
  return {
    id,
    docResident: false,
    origin: "registry",
    harnessId: "codex",
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
    profileId: null,
    archivedAt: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    // Required-and-NULLABLE, so the fixture has to state them: `null` is the
    // row's own answer ("the serving host cannot know"), and leaving them out
    // would make `Partial` widen both to `| undefined`, which the projection
    // deliberately does not accept.
    sessionState: null,
    lastExit: null,
    ...overrides,
  };
}

const handles: OpenedStoreForTest[] = [];

function openEpic(epicId: string): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: fakeStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  for (const handle of handles) handle.dispose();
  handles.length = 0;
  vi.restoreAllMocks();
});

describe("useMountedEpicProjection", () => {
  it("leaves an unmounted epic out of mountedEpicIds, with its agents unresolved", () => {
    const refs: ReadonlyArray<MountedEpicRef> = [
      { epicId: "epic-unmounted", agentIds: ["agent-1"] },
    ];

    const { result } = renderHook(() => useMountedEpicProjection(refs));

    expect(result.current.mountedEpicIds.has("epic-unmounted")).toBe(false);
    expect(result.current.liveTitles.has("epic-unmounted")).toBe(false);
    expect(result.current.agentIdentities.size).toBe(0);
  });

  it("resolves title, parentId, surface and hostId for a mounted epic's agents", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openEpic("epic-mounted");
    handle.store.setState({
      epic: { title: "My Epic", updatedAt: 1 },
      chats: {
        allIds: ["agent-1"],
        byId: {
          "agent-1": chatProjection("agent-1", {
            title: "Agent One",
            parentId: "parent-1",
            hostId: "host-known",
          }),
        },
      },
    });
    act(() => {
      registry.acquire("epic-mounted", () => handle);
    });

    const refs: ReadonlyArray<MountedEpicRef> = [
      { epicId: "epic-mounted", agentIds: ["agent-1"] },
    ];
    const { result } = renderHook(() => useMountedEpicProjection(refs));

    expect(result.current.mountedEpicIds.has("epic-mounted")).toBe(true);
    expect(result.current.liveTitles.get("epic-mounted")).toBe("My Epic");
    expect(
      result.current.agentIdentities.get(
        focusAgentKey("epic-mounted", "agent-1"),
      ),
    ).toEqual({
      surface: "chat",
      title: "Agent One",
      parentId: "parent-1",
      hostId: "host-known",
    });
  });

  it("resolves a terminal-agent's identity the same way", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openEpic("epic-mounted");
    handle.store.setState({
      tuiAgents: {
        allIds: ["tui-1"],
        byId: {
          "tui-1": tuiAgentProjection("tui-1", {
            title: "Codex Agent",
            parentId: null,
            hostId: "host-tui",
          }),
        },
      },
    });
    act(() => {
      registry.acquire("epic-mounted", () => handle);
    });

    const refs: ReadonlyArray<MountedEpicRef> = [
      { epicId: "epic-mounted", agentIds: ["tui-1"] },
    ];
    const { result } = renderHook(() => useMountedEpicProjection(refs));

    expect(
      result.current.agentIdentities.get(
        focusAgentKey("epic-mounted", "tui-1"),
      ),
    ).toEqual({
      surface: "terminal-agent",
      title: "Codex Agent",
      parentId: null,
      hostId: "host-tui",
    });
  });

  it("keeps the SAME encoded projection across an unrelated store notification", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openEpic("epic-mounted");
    handle.store.setState({
      epic: { title: "My Epic", updatedAt: 1 },
      chats: {
        allIds: ["agent-1"],
        byId: { "agent-1": chatProjection("agent-1", {}) },
      },
    });
    act(() => {
      registry.acquire("epic-mounted", () => handle);
    });

    const refs: ReadonlyArray<MountedEpicRef> = [
      { epicId: "epic-mounted", agentIds: ["agent-1"] },
    ];
    const { result } = renderHook(() => useMountedEpicProjection(refs));
    const first = result.current;

    // An unrelated field change on the SAME store - the projection's own
    // snapshot only encodes the epic title plus the referenced agents'
    // identities, so a change elsewhere must not mint a new object.
    act(() => {
      handle.store.setState({
        artifacts: { byId: {}, allIds: [] },
      });
    });

    expect(result.current).toBe(first);
  });

  it("subscribes to the handle on mount and unsubscribes on unmount", () => {
    const registry = __getOpenEpicRegistryForTests();
    const handle = openEpic("epic-mounted");
    handle.store.setState({ chats: { allIds: [], byId: {} } });
    act(() => {
      registry.acquire("epic-mounted", () => handle);
    });

    const originalSubscribe = handle.store.subscribe.bind(handle.store);
    let capturedUnsubscribe: (() => void) | null = null;
    vi.spyOn(handle.store, "subscribe").mockImplementation((listener) => {
      const real = originalSubscribe(listener);
      const wrapped = vi.fn(real);
      capturedUnsubscribe = wrapped;
      return wrapped;
    });

    const refs: ReadonlyArray<MountedEpicRef> = [
      { epicId: "epic-mounted", agentIds: [] },
    ];
    const { unmount } = renderHook(() => useMountedEpicProjection(refs));

    expect(capturedUnsubscribe).not.toBeNull();
    unmount();
    expect(capturedUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a fixed hook count as the ref set grows and shrinks - no React hook-order warning", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      /* silence expected-clean output; assertions below check it directly */
    });
    const registry = __getOpenEpicRegistryForTests();
    const handleA = openEpic("epic-a");
    handleA.store.setState({ chats: { allIds: [], byId: {} } });
    act(() => {
      registry.acquire("epic-a", () => handleA);
    });

    function Probe(props: {
      readonly refs: ReadonlyArray<MountedEpicRef>;
    }): null {
      const [tick, setTick] = useState(0);
      const projection = useMountedEpicProjection(props.refs);
      const summary = useMemo(
        () => `${tick}:${projection.mountedEpicIds.size}`,
        [tick, projection.mountedEpicIds.size],
      );
      void setTick;
      void summary;
      return null;
    }

    const { rerender } = render(
      <Probe refs={[{ epicId: "epic-a", agentIds: [] }]} />,
    );

    rerender(
      <Probe
        refs={[
          { epicId: "epic-a", agentIds: [] },
          { epicId: "epic-b", agentIds: ["agent-x"] },
        ]}
      />,
    );
    rerender(<Probe refs={[]} />);
    rerender(<Probe refs={[{ epicId: "epic-a", agentIds: [] }]} />);

    const hookOrderWarning = consoleError.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes("Rendered more"),
      ),
    );
    expect(hookOrderWarning).toBe(false);
  });
});
