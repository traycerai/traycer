import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capturePlainTerminalProjectionBarrier,
  replacePlainTerminalSnapshot,
  settlePlainTerminalSnapshot,
  upsertPlainTerminal,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  acknowledgedPlainTerminalPresentationIdsForScope,
  commitPlainTerminalDeferredDeletion,
  commitPlainTerminalDeletion,
  commitPlainTerminalSnapshotOmission,
  consumeRetainedPlainTerminalTombstone,
  reconcileRetainedPlainTerminalTombstones,
  rejectClosedPlainTerminalRestore,
} from "@/lib/terminals/plain-terminal-presentation-invalidation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

const TARGET_HOST_ID = "host-a";
const TARGET_TERMINAL_ID = "terminal-shared";

function seedCanvas(tabId: string, refs: readonly EpicCanvasTileRef[]): void {
  useEpicCanvasStore.setState((state) => ({
    tabsById: {
      ...state.tabsById,
      [tabId]: { tabId, epicId: `epic-${tabId}`, name: tabId },
    },
    canvasByTabId: {
      ...state.canvasByTabId,
      [tabId]: {
        root: {
          kind: "pane",
          id: `pane-${tabId}`,
          tabInstanceIds: refs.map((ref) => ref.instanceId),
          activeTabId: refs[0]?.instanceId ?? null,
          previewTabId: null,
          activationHistory: refs.map((ref) => ref.instanceId),
        },
        activePaneId: `pane-${tabId}`,
        tilesByInstanceId: Object.fromEntries(
          refs.map((ref) => [ref.instanceId, ref]),
        ),
        sizesByGroupId: {},
      },
    },
  }));
}

function remainingEpicInstanceIds(): readonly string[] {
  return Object.values(useEpicCanvasStore.getState().canvasByTabId).flatMap(
    (canvas) =>
      canvas === undefined ? [] : Object.keys(canvas.tilesByInstanceId),
  );
}

describe("plain terminal presentation invalidation", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingTerminalStore.getState().resetForTests();
    // The GUI Vitest config does not restore mocks automatically, so the
    // store-action `vi.spyOn` wrappers below would otherwise leak forward.
    vi.restoreAllMocks();
  });

  it("sweeps both scopes by host and terminal without touching future authority, another host, another terminal, or terminal-agent", () => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    seedCanvas("one", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "epic-host-ref",
        type: "terminal",
        name: "Canonical",
        hostId: TARGET_HOST_ID,
        authority: "host",
        legacyFallback: {
          name: "Canonical",
          titleSource: "manual",
          cwd: "/repo",
        },
      },
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "epic-agent-ref",
        type: "terminal-agent",
        name: "Agent",
        hostId: TARGET_HOST_ID,
      },
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "epic-other-host-ref",
        type: "terminal",
        name: "Other host",
        hostId: "host-b",
        authority: "host",
        legacyFallback: {
          name: "Other host",
          titleSource: "manual",
          cwd: "/repo",
        },
      },
    ]);
    seedCanvas("two", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "epic-legacy-ref",
        type: "terminal",
        name: "Legacy evidence",
        hostId: TARGET_HOST_ID,
        titleSource: "manual",
        cwd: "/repo",
      },
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "epic-future-ref",
        type: "terminal",
        name: "Future authority",
        hostId: TARGET_HOST_ID,
        authority: "unsupported",
        rawAuthority: "future-v2",
        legacyFallback: {
          name: "Future authority",
          titleSource: "manual",
          cwd: "/repo",
        },
      },
      {
        id: "terminal-other",
        instanceId: "epic-other-terminal-ref",
        type: "terminal",
        name: "Other terminal",
        hostId: TARGET_HOST_ID,
        authority: "host",
        legacyFallback: {
          name: "Other terminal",
          titleSource: "manual",
          cwd: "/repo",
        },
      },
    ]);

    useLandingTerminalStore.setState({
      tabs: [
        {
          instanceId: "landing-target",
          sessionId: TARGET_TERMINAL_ID,
          hostId: TARGET_HOST_ID,
          cwd: "/repo",
          name: "Target",
          titleSource: "manual",
          hostAuthorityAcknowledged: true,
        },
        {
          instanceId: "landing-target-legacy",
          sessionId: TARGET_TERMINAL_ID,
          hostId: TARGET_HOST_ID,
          cwd: "/legacy",
          name: "Target legacy evidence",
          titleSource: "manual",
          hostAuthorityAcknowledged: false,
        },
        {
          instanceId: "landing-target-pending",
          sessionId: TARGET_TERMINAL_ID,
          hostId: TARGET_HOST_ID,
          cwd: "/pending",
          name: "Target pending create",
          titleSource: "default",
          hostAuthorityAcknowledged: false,
          pendingCreate: true,
        },
        {
          instanceId: "landing-other-host",
          sessionId: TARGET_TERMINAL_ID,
          hostId: "host-b",
          cwd: "/repo",
          name: "Other host",
          titleSource: "manual",
          hostAuthorityAcknowledged: true,
        },
        {
          instanceId: "landing-other-terminal",
          sessionId: "terminal-other",
          hostId: TARGET_HOST_ID,
          cwd: "/repo",
          name: "Other terminal",
          titleSource: "manual",
          hostAuthorityAcknowledged: true,
        },
      ],
      activeInstanceId: "landing-target",
    });

    useEpicCanvasStore.setState({
      closedTilePayloadsByTabId: {
        one: {
          "closed-host-ref": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "closed-host-ref",
              type: "terminal",
              name: "Closed canonical",
              hostId: TARGET_HOST_ID,
              authority: "host",
              legacyFallback: {
                name: "Closed canonical",
                titleSource: "manual",
                cwd: "/repo",
              },
            },
            pendingCreate: false,
          },
          "closed-agent-ref": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "closed-agent-ref",
              type: "terminal-agent",
              name: "Closed agent",
              hostId: TARGET_HOST_ID,
            },
            pendingCreate: false,
          },
          "closed-other-host-ref": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "closed-other-host-ref",
              type: "terminal",
              name: "Closed other host",
              hostId: "host-b",
              authority: "host",
              legacyFallback: {
                name: "Closed other host",
                titleSource: "manual",
                cwd: "/repo",
              },
            },
            pendingCreate: false,
          },
        },
        two: {
          "closed-legacy-ref": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "closed-legacy-ref",
              type: "terminal",
              name: "Closed legacy",
              hostId: TARGET_HOST_ID,
              titleSource: "manual",
              cwd: "/repo",
            },
            pendingCreate: false,
          },
          "closed-future-ref": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "closed-future-ref",
              type: "terminal",
              name: "Closed future",
              hostId: TARGET_HOST_ID,
              authority: "unsupported",
              rawAuthority: "future-v2",
              legacyFallback: {
                name: "Closed future",
                titleSource: "manual",
                cwd: "/repo",
              },
            },
            pendingCreate: false,
          },
          "closed-other-terminal-ref": {
            node: {
              id: "terminal-other",
              instanceId: "closed-other-terminal-ref",
              type: "terminal",
              name: "Closed other terminal",
              hostId: TARGET_HOST_ID,
              authority: "host",
              legacyFallback: {
                name: "Closed other terminal",
                titleSource: "manual",
                cwd: "/repo",
              },
            },
            pendingCreate: false,
          },
        },
      },
    });

    const queryClient = new QueryClient();
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey: ["plain-terminal-invalidation"],
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 1 },
        deferPresentation: false,
      }),
    ).toBe(true);

    expect([...remainingEpicInstanceIds()].sort()).toEqual([
      "epic-agent-ref",
      "epic-future-ref",
      "epic-other-host-ref",
      "epic-other-terminal-ref",
    ]);
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.map((tab) => tab.instanceId)
        .sort(),
    ).toEqual(["landing-other-host", "landing-other-terminal"]);
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      "landing-other-host",
    );
    expect(
      Object.values(useEpicCanvasStore.getState().closedTilePayloadsByTabId)
        .flatMap((forTab) => Object.keys(forTab ?? {}))
        .sort(),
    ).toEqual([
      "closed-agent-ref",
      "closed-future-ref",
      "closed-other-host-ref",
      "closed-other-terminal-ref",
    ]);
  });

  it("discharges the same deferred tombstone across Query clients without duplicate store effects", () => {
    seedCanvas("one", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "epic-host-ref",
        type: "terminal",
        name: "Canonical",
        hostId: TARGET_HOST_ID,
        authority: "host",
        legacyFallback: {
          name: "Canonical",
          titleSource: "manual",
          cwd: "/repo",
        },
      },
    ]);
    useLandingTerminalStore.getState().addTab({
      instanceId: "landing-target",
      sessionId: TARGET_TERMINAL_ID,
      hostId: TARGET_HOST_ID,
      cwd: "/repo",
      name: "Target",
      titleSource: "manual",
      hostAuthorityAcknowledged: true,
    });
    const epicRemove = vi.spyOn(
      useEpicCanvasStore.getState(),
      "removeHostTerminalRefs",
    );
    const landingRemove = vi.spyOn(
      useLandingTerminalStore.getState(),
      "removeHostTerminal",
    );
    epicRemove.mockClear();
    landingRemove.mockClear();

    const queryKey = ["plain-terminal-deferred"] as const;
    const queryClients = [new QueryClient(), new QueryClient()];
    for (const queryClient of queryClients) {
      expect(
        commitPlainTerminalDeletion({
          queryClient,
          queryKey,
          hostId: TARGET_HOST_ID,
          terminalId: TARGET_TERMINAL_ID,
          evidence: { kind: "stream", revision: 4 },
          deferPresentation: true,
        }),
      ).toBe(true);
      queryClient.setQueryData<PlainTerminalCollection>(queryKey, (current) =>
        settlePlainTerminalSnapshot(replacePlainTerminalSnapshot(current, [])),
      );
    }

    for (const queryClient of queryClients) {
      expect(
        commitPlainTerminalDeferredDeletion({
          queryClient,
          queryKey,
          hostId: TARGET_HOST_ID,
          terminalId: TARGET_TERMINAL_ID,
          snapshotEpoch: 1,
        }),
      ).toBe(true);
    }
    expect(epicRemove).toHaveBeenCalledTimes(1);
    expect(landingRemove).toHaveBeenCalledTimes(1);
    for (const queryClient of queryClients) {
      expect(
        queryClient.getQueryData<PlainTerminalCollection>(queryKey)
          ?.pendingPresentationDeletionRevisionById[TARGET_TERMINAL_ID],
      ).toBeUndefined();
    }
  });

  it("sweeps late-hydrated supported refs on an equal retained tombstone without advancing Query sequence", () => {
    const queryClient = new QueryClient();
    const queryKey = ["plain-terminal-late-tombstone"] as const;
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);
    const sequenceAfterFirst =
      queryClient.getQueryData<PlainTerminalCollection>(
        queryKey,
      )?.projectionSequence;
    expect(sequenceAfterFirst).toBe(1);

    seedCanvas("late", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-legacy",
        type: "terminal",
        name: "Late epic live",
        hostId: TARGET_HOST_ID,
        titleSource: "manual",
        cwd: "/legacy",
      },
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-other-host",
        type: "terminal",
        name: "Other host",
        hostId: "host-b",
        titleSource: "manual",
        cwd: "/repo",
      },
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-agent",
        type: "terminal-agent",
        name: "Agent",
        hostId: TARGET_HOST_ID,
      },
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-future",
        type: "terminal",
        name: "Future",
        hostId: TARGET_HOST_ID,
        authority: "unsupported",
        rawAuthority: "future-v2",
        legacyFallback: {
          name: "Future",
          titleSource: "manual",
          cwd: "/repo",
        },
      },
    ]);
    useEpicCanvasStore.setState({
      closedTilePayloadsByTabId: {
        late: {
          "late-closed-legacy": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "late-closed-legacy",
              type: "terminal",
              name: "Late closed",
              hostId: TARGET_HOST_ID,
              titleSource: "manual",
              cwd: "/legacy",
            },
            pendingCreate: false,
          },
          "late-closed-other-terminal": {
            node: {
              id: "terminal-other",
              instanceId: "late-closed-other-terminal",
              type: "terminal",
              name: "Other terminal",
              hostId: TARGET_HOST_ID,
              titleSource: "manual",
              cwd: "/repo",
            },
            pendingCreate: false,
          },
        },
      },
    });
    useLandingTerminalStore.setState({
      tabs: [
        {
          instanceId: "late-legacy",
          sessionId: TARGET_TERMINAL_ID,
          hostId: TARGET_HOST_ID,
          cwd: "/legacy",
          name: "Late landing",
          titleSource: "manual",
          hostAuthorityAcknowledged: false,
        },
        {
          instanceId: "late-other-host",
          sessionId: TARGET_TERMINAL_ID,
          hostId: "host-b",
          cwd: "/repo",
          name: "Other host",
          titleSource: "manual",
          hostAuthorityAcknowledged: false,
        },
      ],
      activeInstanceId: "late-legacy",
    });

    const collection =
      queryClient.getQueryData<PlainTerminalCollection>(queryKey);
    const epicRemove = vi.spyOn(
      useEpicCanvasStore.getState(),
      "removeHostTerminalRefs",
    );
    const landingRemove = vi.spyOn(
      useLandingTerminalStore.getState(),
      "removeHostTerminal",
    );
    epicRemove.mockClear();
    landingRemove.mockClear();

    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: {
          kind: "unary",
          revision: 2,
          barrier: capturePlainTerminalProjectionBarrier(collection),
        },
        deferPresentation: false,
      }),
    ).toBe(true);
    expect(
      queryClient.getQueryData<PlainTerminalCollection>(queryKey)
        ?.projectionSequence,
    ).toBe(sequenceAfterFirst);
    expect(epicRemove).toHaveBeenCalledTimes(1);
    expect(landingRemove).toHaveBeenCalledTimes(1);
    expect([...remainingEpicInstanceIds()].sort()).toEqual([
      "late-epic-agent",
      "late-epic-future",
      "late-epic-other-host",
    ]);
    expect(
      useLandingTerminalStore.getState().tabs.map((tab) => tab.instanceId),
    ).toEqual(["late-other-host"]);
    expect(
      Object.keys(
        useEpicCanvasStore.getState().closedTilePayloadsByTabId.late ?? {},
      ),
    ).toEqual(["late-closed-other-terminal"]);

    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: {
          kind: "unary",
          revision: 2,
          barrier: capturePlainTerminalProjectionBarrier(
            queryClient.getQueryData<PlainTerminalCollection>(queryKey),
          ),
        },
        deferPresentation: false,
      }),
    ).toBe(false);
    expect(epicRemove).toHaveBeenCalledTimes(1);
    expect(landingRemove).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale tombstone replay overtaken by a newer live projection", () => {
    const queryClient = new QueryClient();
    const queryKey = ["plain-terminal-stale-tombstone"] as const;
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);
    queryClient.setQueryData<PlainTerminalCollection>(queryKey, (current) =>
      upsertPlainTerminal(current, {
        record: {
          terminalId: TARGET_TERMINAL_ID,
          hostId: TARGET_HOST_ID,
          scope: { kind: "epic", epicId: "epic-late" },
          launch: { cwd: "/repo", shellCommand: "/bin/zsh", shellArgs: [] },
          manualTitle: "newer lifecycle",
          revision: 3,
          createdAt: "2026-08-16T10:00:00.000Z",
          updatedAt: "2026-08-16T10:02:00.000Z",
        },
        runtime: { status: "dormant" },
      }),
    );
    seedCanvas("late", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-legacy",
        type: "terminal",
        name: "Late epic live",
        hostId: TARGET_HOST_ID,
        titleSource: "manual",
        cwd: "/legacy",
      },
    ]);
    useLandingTerminalStore.getState().addTab({
      instanceId: "late-legacy",
      sessionId: TARGET_TERMINAL_ID,
      hostId: TARGET_HOST_ID,
      cwd: "/legacy",
      name: "Late landing",
      titleSource: "manual",
      hostAuthorityAcknowledged: false,
    });

    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: {
          kind: "unary",
          revision: 2,
          barrier: capturePlainTerminalProjectionBarrier(
            queryClient.getQueryData<PlainTerminalCollection>(queryKey),
          ),
        },
        deferPresentation: false,
      }),
    ).toBe(false);
    expect(
      useEpicCanvasStore.getState().canvasByTabId.late?.tilesByInstanceId[
        "late-epic-legacy"
      ],
    ).toBeDefined();
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.some((tab) => tab.instanceId === "late-legacy"),
    ).toBe(true);
  });

  it("consumes a retained tombstone when supported legacy evidence mounts later", () => {
    const queryClient = new QueryClient();
    const queryKey = ["plain-terminal-mount-tombstone"] as const;
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);
    useLandingTerminalStore.getState().addTab({
      instanceId: "late-legacy",
      sessionId: TARGET_TERMINAL_ID,
      hostId: TARGET_HOST_ID,
      cwd: "/legacy",
      name: "Late landing",
      titleSource: "manual",
      hostAuthorityAcknowledged: false,
    });
    expect(
      consumeRetainedPlainTerminalTombstone({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
      }),
    ).toBe(true);
    expect(useLandingTerminalStore.getState().tabs).toEqual([]);
    expect(
      queryClient.getQueryData<PlainTerminalCollection>(queryKey)
        ?.projectionSequence,
    ).toBe(1);
  });

  it("does not consume a retained tombstone while its presentation fanout is still deferred", () => {
    const queryClient = new QueryClient();
    const queryKey = ["plain-terminal-deferred-reconcile"] as const;
    seedCanvas("late", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-legacy",
        type: "terminal",
        name: "Late epic live",
        hostId: TARGET_HOST_ID,
        titleSource: "manual",
        cwd: "/legacy",
      },
    ]);
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: true,
      }),
    ).toBe(true);
    expect(
      consumeRetainedPlainTerminalTombstone({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
      }),
    ).toBe(false);
    expect(
      useEpicCanvasStore.getState().canvasByTabId.late?.tilesByInstanceId[
        "late-epic-legacy"
      ],
    ).toBeDefined();
  });

  it("reconciles retained tombstones against closed-only epic payloads without a unary", () => {
    const queryClient = new QueryClient();
    const queryKey = ["plain-terminal-closed-only-reconcile"] as const;
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);
    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        ...state.tabsById,
        late: { tabId: "late", epicId: "epic-late", name: "Late" },
      },
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        late: {
          "late-closed-legacy": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "late-closed-legacy",
              type: "terminal",
              name: "Late closed",
              hostId: TARGET_HOST_ID,
              titleSource: "manual",
              cwd: "/legacy",
            },
            pendingCreate: false,
          },
          "late-closed-future": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "late-closed-future",
              type: "terminal",
              name: "Future authority",
              hostId: TARGET_HOST_ID,
              authority: "unsupported",
              rawAuthority: "future-v2",
              legacyFallback: {
                name: "Future authority",
                titleSource: "manual",
                cwd: "/repo",
              },
            },
            pendingCreate: false,
          },
          "late-closed-other-id": {
            node: {
              id: "terminal-other",
              instanceId: "late-closed-other-id",
              type: "terminal",
              name: "Other terminal",
              hostId: TARGET_HOST_ID,
              titleSource: "manual",
              cwd: "/other",
            },
            pendingCreate: false,
          },
        },
      },
    }));
    seedCanvas("live", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-agent",
        type: "terminal-agent",
        name: "Agent",
        hostId: TARGET_HOST_ID,
      },
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "late-epic-other-host",
        type: "terminal",
        name: "Other host",
        hostId: "host-b",
        titleSource: "manual",
        cwd: "/repo",
      },
    ]);

    expect(
      reconcileRetainedPlainTerminalTombstones({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
      }),
    ).toBe(true);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId.late?.[
        "late-closed-legacy"
      ],
    ).toBeUndefined();
    expect(
      Object.keys(
        useEpicCanvasStore.getState().closedTilePayloadsByTabId.late ?? {},
      ).sort(),
    ).toEqual(["late-closed-future", "late-closed-other-id"]);
    expect([...remainingEpicInstanceIds()].sort()).toEqual([
      "late-epic-agent",
      "late-epic-other-host",
    ]);
    expect(
      queryClient.getQueryData<PlainTerminalCollection>(queryKey)
        ?.projectionSequence,
    ).toBe(1);
    expect(
      reconcileRetainedPlainTerminalTombstones({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
      }),
    ).toBe(false);
  });

  it("rejects a closed restore for a retained tombstone without advancing Query", () => {
    const queryClient = new QueryClient();
    const queryKey = hostQueryKeys.plainTerminals(TARGET_HOST_ID, {
      kind: "epic",
      epicId: "epic-late",
    });
    const node: EpicCanvasTileRef = {
      id: TARGET_TERMINAL_ID,
      instanceId: "closed-legacy",
      type: "terminal",
      name: "Closed legacy",
      hostId: TARGET_HOST_ID,
      titleSource: "manual",
      cwd: "/legacy",
    };
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);
    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        ...state.tabsById,
        late: { tabId: "late", epicId: "epic-late", name: "Late" },
      },
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        late: {
          "closed-legacy": { node, pendingCreate: false },
          "closed-future": {
            node: {
              id: TARGET_TERMINAL_ID,
              instanceId: "closed-future",
              type: "terminal",
              name: "Future",
              hostId: TARGET_HOST_ID,
              authority: "unsupported",
              rawAuthority: "future-v2",
              legacyFallback: {
                name: "Future",
                titleSource: "manual",
                cwd: "/repo",
              },
            },
            pendingCreate: false,
          },
        },
      },
    }));

    expect(
      rejectClosedPlainTerminalRestore({
        queryClient,
        epicId: "epic-late",
        node,
      }),
    ).toBe(true);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId.late?.[
        "closed-legacy"
      ],
    ).toBeUndefined();
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId.late?.[
        "closed-future"
      ],
    ).toBeDefined();
    expect(
      queryClient.getQueryData<PlainTerminalCollection>(queryKey)
        ?.projectionSequence,
    ).toBe(1);
  });

  it("does not consume while deferred and still blocks closed restore", () => {
    const queryClient = new QueryClient();
    const queryKey = hostQueryKeys.plainTerminals(TARGET_HOST_ID, {
      kind: "epic",
      epicId: "epic-late",
    });
    const node: EpicCanvasTileRef = {
      id: TARGET_TERMINAL_ID,
      instanceId: "closed-deferred",
      type: "terminal",
      name: "Deferred",
      hostId: TARGET_HOST_ID,
      titleSource: "manual",
      cwd: "/legacy",
    };
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: true,
      }),
    ).toBe(true);
    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        ...state.tabsById,
        late: { tabId: "late", epicId: "epic-late", name: "Late" },
      },
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        late: { "closed-deferred": { node, pendingCreate: false } },
      },
    }));

    expect(
      rejectClosedPlainTerminalRestore({
        queryClient,
        epicId: "epic-late",
        node,
      }),
    ).toBe(true);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId.late?.[
        "closed-deferred"
      ],
    ).toBeDefined();
  });

  it("allows closed restore after a newer live projection overtakes the tombstone", () => {
    const queryClient = new QueryClient();
    const queryKey = hostQueryKeys.plainTerminals(TARGET_HOST_ID, {
      kind: "epic",
      epicId: "epic-late",
    });
    const node: EpicCanvasTileRef = {
      id: TARGET_TERMINAL_ID,
      instanceId: "closed-newer",
      type: "terminal",
      name: "Newer",
      hostId: TARGET_HOST_ID,
      titleSource: "manual",
      cwd: "/legacy",
    };
    expect(
      commitPlainTerminalDeletion({
        queryClient,
        queryKey,
        hostId: TARGET_HOST_ID,
        terminalId: TARGET_TERMINAL_ID,
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);
    queryClient.setQueryData<PlainTerminalCollection>(queryKey, (current) =>
      upsertPlainTerminal(current, {
        record: {
          terminalId: TARGET_TERMINAL_ID,
          hostId: TARGET_HOST_ID,
          scope: { kind: "epic", epicId: "epic-late" },
          launch: { cwd: "/repo", shellCommand: "/bin/zsh", shellArgs: [] },
          manualTitle: "newer lifecycle",
          revision: 3,
          createdAt: "2026-08-16T10:00:00.000Z",
          updatedAt: "2026-08-16T10:02:00.000Z",
        },
        runtime: { status: "dormant" },
      }),
    );
    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        ...state.tabsById,
        late: { tabId: "late", epicId: "epic-late", name: "Late" },
      },
      closedTilePayloadsByTabId: {
        ...state.closedTilePayloadsByTabId,
        late: { "closed-newer": { node, pendingCreate: false } },
      },
    }));

    expect(
      rejectClosedPlainTerminalRestore({
        queryClient,
        epicId: "epic-late",
        node,
      }),
    ).toBe(false);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId.late?.[
        "closed-newer"
      ],
    ).toBeDefined();
  });

  it("keeps an epic pending-create host ref through a settled snapshot omission", () => {
    const queryClient = new QueryClient();
    const scope = { kind: "epic" as const, epicId: "epic-one" };
    const queryKey = hostQueryKeys.plainTerminals(TARGET_HOST_ID, scope);
    const settled = settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, []),
    );
    queryClient.setQueryData(queryKey, settled);

    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    seedCanvas("one", [
      {
        id: TARGET_TERMINAL_ID,
        instanceId: "epic-pending-create",
        type: "terminal",
        name: "Minted before create",
        hostId: TARGET_HOST_ID,
        authority: "host",
        legacyFallback: {
          name: "Minted before create",
          titleSource: "default",
          cwd: "/repo",
        },
      },
    ]);
    useEpicCanvasStore.getState().markArtifactPendingCreate(TARGET_TERMINAL_ID);

    const sweepAcknowledgedOmissions = (): void => {
      for (const terminalId of acknowledgedPlainTerminalPresentationIdsForScope(
        TARGET_HOST_ID,
        scope,
      )) {
        if (settled.terminalsById[terminalId] === undefined) {
          commitPlainTerminalSnapshotOmission({
            queryClient,
            queryKey,
            hostId: TARGET_HOST_ID,
            scope,
            terminalId,
            snapshotEpoch: settled.snapshotEpoch,
          });
        }
      }
    };

    expect(
      acknowledgedPlainTerminalPresentationIdsForScope(
        TARGET_HOST_ID,
        scope,
      ).has(TARGET_TERMINAL_ID),
    ).toBe(false);
    sweepAcknowledgedOmissions();
    expect(remainingEpicInstanceIds()).toEqual(["epic-pending-create"]);

    useEpicCanvasStore
      .getState()
      .unmarkArtifactPendingCreate(TARGET_TERMINAL_ID);
    expect(
      acknowledgedPlainTerminalPresentationIdsForScope(
        TARGET_HOST_ID,
        scope,
      ).has(TARGET_TERMINAL_ID),
    ).toBe(true);
    sweepAcknowledgedOmissions();
    expect(remainingEpicInstanceIds()).toEqual([]);
  });
});
