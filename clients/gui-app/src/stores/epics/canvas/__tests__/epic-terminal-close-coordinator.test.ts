import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestEpicTerminalClose,
  requestEpicTerminalLifetimeClose,
} from "@/lib/terminals/epic-terminal-close-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicTerminalRef,
} from "@/stores/epics/canvas/types";

const TAB_ID = "view-tab";
const PANE_ID = "pane";

function terminal(
  id: string,
  instanceId: string,
  authority: "legacy" | "host",
  hostId: string,
): EpicTerminalRef {
  const base = {
    id,
    instanceId,
    type: "terminal" as const,
    name: id,
    hostId,
  };
  return authority === "host"
    ? {
        ...base,
        authority: "host",
        legacyFallback: {
          name: id,
          titleSource: "manual",
          cwd: "/repo",
        },
      }
    : { ...base, titleSource: "manual", cwd: "/repo" };
}

function agent(instanceId: string): EpicCanvasTileRef {
  return {
    id: `agent-${instanceId}`,
    instanceId,
    type: "terminal-agent",
    name: "Agent",
    hostId: "host-1",
  };
}

function spec(instanceId: string): EpicCanvasTileRef {
  return {
    id: `spec-${instanceId}`,
    instanceId,
    type: "spec",
    name: "Spec",
    hostId: "host-1",
  };
}

function seed(refs: readonly EpicCanvasTileRef[], activeId: string): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic" },
    },
    canvasByTabId: {
      [TAB_ID]: {
        root: {
          kind: "pane",
          id: PANE_ID,
          tabInstanceIds: refs.map((ref) => ref.instanceId),
          activeTabId: activeId,
          previewTabId: null,
          activationHistory: refs.map((ref) => ref.instanceId),
        },
        activePaneId: PANE_ID,
        tilesByInstanceId: Object.fromEntries(
          refs.map((ref) => [ref.instanceId, ref]),
        ),
        sizesByGroupId: {},
      },
    },
  });
}

function remainingIds(): readonly string[] {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
  if (canvas?.root?.kind !== "pane") return [];
  return canvas.root.tabInstanceIds;
}

function remainingTile(instanceId: string): EpicCanvasTileRef | undefined {
  return useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.tilesByInstanceId[
    instanceId
  ];
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  };
}

describe("epic terminal close coordination", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it.each([
    "unknown capability before readiness",
    "capable after PTY startup",
  ] as const)("closes a %s tab as a local presentation only", () => {
    const ref = terminal("durable", "durable-1", "host", "host-1");
    seed([ref], ref.instanceId);

    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);

    expect(remainingIds()).toEqual([]);
    expect(remainingTile(ref.instanceId)).toBeUndefined();
  });

  it("maps every tab-close ref to a local presentation close, including unreachable owners", () => {
    const offline = terminal("durable", "offline-1", "host", "host-offline");
    const unknown = terminal("durable", "unknown-1", "host", "host-missing");
    const result = requestEpicTerminalClose([offline, unknown, spec("keep")]);
    expect(result.localInstanceIds).toEqual([
      offline.instanceId,
      unknown.instanceId,
      "keep",
    ]);
    expect(result.retainedInstanceIds).toEqual([]);
  });

  it("closes an unreachable-owner tab locally without a lifetime RPC", () => {
    const ref = terminal("durable", "offline-1", "host", "host-offline");
    const lifetimeClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    seed([ref], ref.instanceId);

    expect(
      requestEpicTerminalLifetimeClose({
        hostId: ref.hostId,
        terminalId: ref.id,
        capability: "capable",
        canMutate: false,
        close: lifetimeClose,
      }),
    ).toBeNull();
    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);

    expect(remainingIds()).toEqual([]);
    expect(remainingTile(ref.instanceId)).toBeUndefined();
    expect(lifetimeClose).not.toHaveBeenCalled();
  });

  it("closes an unregistered terminal tab before authority mounts", () => {
    const ref = terminal("durable", "durable-1", "host", "host-1");
    seed([ref], ref.instanceId);

    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);

    expect(remainingIds()).toEqual([]);
    expect(remainingTile(ref.instanceId)).toBeUndefined();
  });

  it("closes an import-exempt ref locally", () => {
    const ref = terminal("signin", "signin-1", "legacy", "host-1");
    seed([ref], ref.instanceId);

    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);

    expect(remainingIds()).toEqual([]);
  });

  it("removes every local presentation of a durable terminal without deleting it", () => {
    const first = terminal("durable", "durable-1", "host", "host-1");
    const second = terminal("durable", "durable-2", "host", "host-1");
    seed([first, second], second.instanceId);

    useEpicCanvasStore.getState().closeAllCanvasTabs(TAB_ID, PANE_ID);

    expect(remainingIds()).toEqual([]);
  });

  it("does not join an in-flight lifetime close when the canvas tab is closed", async () => {
    const ref = terminal("durable", "durable-1", "host", "host-1");
    const closeResult = deferred();
    const sidebarClose = vi.fn<() => Promise<void>>(() => closeResult.promise);
    const overlayClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    seed([ref], ref.instanceId);

    const sidebarPending = requestEpicTerminalLifetimeClose({
      hostId: ref.hostId,
      terminalId: ref.id,
      capability: "capable",
      canMutate: true,
      close: sidebarClose,
    });
    const overlayPending = requestEpicTerminalLifetimeClose({
      hostId: ref.hostId,
      terminalId: ref.id,
      capability: "capable",
      canMutate: true,
      close: overlayClose,
    });
    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);

    expect(overlayPending).toBe(sidebarPending);
    await vi.waitFor(() => expect(sidebarClose).toHaveBeenCalledTimes(1));
    expect(overlayClose).not.toHaveBeenCalled();
    expect(remainingIds()).toEqual([]);

    closeResult.resolve();
    await sidebarPending;
  });

  it("keeps a pending lifetime close across unmount and releases it after failure for retry", async () => {
    const ref = terminal("durable", "durable-1", "host", "host-1");
    const firstResult = deferred();
    const firstClose = vi.fn<() => Promise<void>>(() => firstResult.promise);
    const mountedAuthority = {
      hostId: ref.hostId,
      terminalId: ref.id,
      capability: "capable" as const,
      canMutate: true,
      close: firstClose,
    };

    const initial = requestEpicTerminalLifetimeClose(mountedAuthority);
    const joinedAfterUnmount = requestEpicTerminalLifetimeClose({
      ...mountedAuthority,
      close: () => Promise.resolve(),
    });
    expect(joinedAfterUnmount).toBe(initial);
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledTimes(1));

    firstResult.reject(new Error("offline"));
    await expect(initial).rejects.toThrow("offline");
    const retryClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const retry = requestEpicTerminalLifetimeClose({
      ...mountedAuthority,
      close: retryClose,
    });
    expect(retry).not.toBe(initial);
    await retry;
    expect(retryClose).toHaveBeenCalledTimes(1);
  });

  it("does not join lifetime deletes whose NUL-delimited keys would collide", async () => {
    const firstClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const secondClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const first = requestEpicTerminalLifetimeClose({
      hostId: "a",
      terminalId: "b\0c",
      capability: "capable",
      canMutate: true,
      close: firstClose,
    });
    const second = requestEpicTerminalLifetimeClose({
      hostId: "a\0b",
      terminalId: "c",
      capability: "capable",
      canMutate: true,
      close: secondClose,
    });
    expect(second).not.toBe(first);
    await Promise.resolve();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
    await first;
    await second;
  });

  it("still single-flights repeated deletes for the same composite identity", async () => {
    const closeResult = deferred();
    const firstClose = vi.fn<() => Promise<void>>(() => closeResult.promise);
    const secondClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const first = requestEpicTerminalLifetimeClose({
      hostId: "host-a",
      terminalId: "term-a",
      capability: "capable",
      canMutate: true,
      close: firstClose,
    });
    const second = requestEpicTerminalLifetimeClose({
      hostId: "host-a",
      terminalId: "term-a",
      capability: "capable",
      canMutate: true,
      close: secondClose,
    });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledTimes(1));
    expect(secondClose).not.toHaveBeenCalled();
    closeResult.resolve();
    await first;
  });

  it.each(["others", "right", "all", "group"] as const)(
    "closes mixed %s gestures locally, including durable terminal presentations",
    (gesture) => {
      const keep = spec("keep");
      const durable = terminal("durable", "durable-1", "host", "host-1");
      const legacy = terminal("legacy", "legacy-1", "legacy", "host-1");
      const terminalAgent = agent("agent-1");
      seed([keep, durable, legacy, terminalAgent], terminalAgent.instanceId);

      const store = useEpicCanvasStore.getState();
      if (gesture === "others") {
        store.closeOtherCanvasTabs(TAB_ID, PANE_ID, keep.instanceId);
      } else if (gesture === "right") {
        store.closeRightCanvasTabs(TAB_ID, PANE_ID, keep.instanceId);
      } else if (gesture === "all") {
        store.closeAllCanvasTabs(TAB_ID, PANE_ID);
      } else {
        store.closeCanvasPane(TAB_ID, PANE_ID);
      }

      expect(remainingIds()).toEqual(
        gesture === "all" || gesture === "group" ? [] : [keep.instanceId],
      );
    },
  );
});
