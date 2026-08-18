import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerEpicTerminalCloseAuthority,
  requestEpicTerminalLifetimeClose,
  type EpicTerminalCloseAuthority,
} from "@/lib/terminals/epic-terminal-close-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicTerminalRef,
} from "@/stores/epics/canvas/types";

const TAB_ID = "view-tab";
const PANE_ID = "pane";
const unregister: Array<() => void> = [];

function terminal(
  id: string,
  instanceId: string,
  authority: "legacy" | "host",
): EpicTerminalRef {
  const base = {
    id,
    instanceId,
    type: "terminal" as const,
    name: id,
    hostId: "host-1",
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

function register(
  ref: EpicTerminalRef,
  input: Pick<EpicTerminalCloseAuthority, "capability" | "canMutate" | "close">,
): void {
  unregister.push(
    registerEpicTerminalCloseAuthority({
      instanceId: ref.instanceId,
      hostId: ref.hostId,
      terminalId: ref.id,
      ...input,
    }),
  );
}

function remainingIds(): readonly string[] {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
  if (canvas?.root?.kind !== "pane") return [];
  return canvas.root.tabInstanceIds;
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
    unregister.splice(0).forEach((dispose) => dispose());
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it.each([
    ["unknown capability", "unknown", false],
    ["capable but unreachable authority", "capable", false],
  ] as const)("fails closed for %s", (_name, capability, canMutate) => {
    const ref = terminal("durable", "durable-1", "host");
    const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
    seed([ref], ref.instanceId);
    register(ref, { capability, canMutate, close });

    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);

    expect(remainingIds()).toEqual([ref.instanceId]);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes an import-exempt ref registered as legacy even when canMutate is false", () => {
    const ref = terminal("signin", "signin-1", "legacy");
    const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
    seed([ref], ref.instanceId);
    register(ref, { capability: "legacy", canMutate: false, close });

    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);

    expect(remainingIds()).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it("retains a durable ref when acknowledged close fails", async () => {
    const ref = terminal("durable", "durable-1", "host");
    const close = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new Error("offline")),
    );
    seed([ref], ref.instanceId);
    register(ref, { capability: "capable", canMutate: true, close });

    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, PANE_ID, ref.instanceId);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    expect(remainingIds()).toEqual([ref.instanceId]);
  });

  it("closes a multi-ref durable terminal once and removes all refs only on authoritative deletion", async () => {
    const first = terminal("durable", "durable-1", "host");
    const second = terminal("durable", "durable-2", "host");
    const firstClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const secondClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    seed([first, second], second.instanceId);
    register(first, {
      capability: "capable",
      canMutate: true,
      close: firstClose,
    });
    register(second, {
      capability: "capable",
      canMutate: true,
      close: secondClose,
    });

    useEpicCanvasStore.getState().closeAllCanvasTabs(TAB_ID, PANE_ID);
    expect(remainingIds()).toEqual([first.instanceId, second.instanceId]);
    await vi.waitFor(() =>
      expect(firstClose.mock.calls.length + secondClose.mock.calls.length).toBe(
        1,
      ),
    );

    useEpicCanvasStore.getState().removeHostTerminalRefs("host-1", "durable");
    expect(remainingIds()).toEqual([]);
  });

  it("single-flights sidebar, overlay, and store closes by terminal lifetime", async () => {
    const ref = terminal("durable", "durable-1", "host");
    const closeResult = deferred();
    const sidebarClose = vi.fn<() => Promise<void>>(() => closeResult.promise);
    const overlayClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const storeClose = vi.fn<() => Promise<void>>(() => Promise.resolve());
    seed([ref], ref.instanceId);
    register(ref, {
      capability: "capable",
      canMutate: true,
      close: storeClose,
    });

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
    expect(storeClose).not.toHaveBeenCalled();
    expect(remainingIds()).toEqual([ref.instanceId]);

    closeResult.resolve();
    await sidebarPending;
  });

  it("keeps a pending lifetime close across unmount and releases it after failure for retry", async () => {
    const ref = terminal("durable", "durable-1", "host");
    const firstResult = deferred();
    const firstClose = vi.fn<() => Promise<void>>(() => firstResult.promise);
    const mountedAuthority: EpicTerminalCloseAuthority = {
      instanceId: ref.instanceId,
      hostId: ref.hostId,
      terminalId: ref.id,
      capability: "capable",
      canMutate: true,
      close: firstClose,
    };
    const unmount = registerEpicTerminalCloseAuthority(mountedAuthority);
    unregister.push(unmount);

    const initial = requestEpicTerminalLifetimeClose(mountedAuthority);
    unmount();
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

  it.each(["others", "right", "all", "group"] as const)(
    "splits mixed %s close into durable, old-host, and terminal-agent behavior",
    async (gesture) => {
      const keep = spec("keep");
      const durable = terminal("durable", "durable-1", "host");
      const legacy = terminal("legacy", "legacy-1", "legacy");
      const terminalAgent = agent("agent-1");
      const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
      seed([keep, durable, legacy, terminalAgent], terminalAgent.instanceId);
      register(durable, {
        capability: "capable",
        canMutate: true,
        close,
      });
      register(legacy, {
        capability: "legacy",
        canMutate: false,
        close: () => Promise.resolve(),
      });

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

      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(remainingIds()).toEqual(
        gesture === "all" || gesture === "group"
          ? [durable.instanceId]
          : [keep.instanceId, durable.instanceId],
      );
    },
  );
});
