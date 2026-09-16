import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  selectOpenChatIds,
  useOpenChatIds,
} from "@/stores/epics/canvas/canvas-selectors";
import {
  useEpicCanvasStore,
  type EpicCanvasStore,
} from "@/stores/epics/canvas/store";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { group, pane } from "./canvas-test-fixtures";

const HOST = "host-a";

function chatRef(id: string): EpicCanvasTileRef {
  return {
    id,
    instanceId: `inst-${id}`,
    type: "chat",
    name: id,
    hostId: HOST,
  };
}

function specRef(id: string): EpicCanvasTileRef {
  return {
    id,
    instanceId: `inst-${id}`,
    type: "spec",
    name: id,
    hostId: HOST,
  };
}

function canvasOf(
  refs: ReadonlyArray<EpicCanvasTileRef>,
  root: EpicCanvasState["root"],
): EpicCanvasState {
  return {
    root,
    activePaneId: null,
    tilesByInstanceId: Object.fromEntries(
      refs.map((ref) => [ref.instanceId, ref]),
    ),
    sizesByGroupId: {},
  };
}

function stateWith(
  canvasByTabId: Readonly<Record<string, EpicCanvasState | undefined>>,
): EpicCanvasStore {
  return { ...useEpicCanvasStore.getState(), canvasByTabId };
}

describe("selectOpenChatIds", () => {
  it("finds chat refs nested in split trees, across every view tab", () => {
    // tab-1: a 2-deep split - one chat in the outer pane, one in a nested
    // group's pane, plus a spec that must not be collected.
    const chatA = chatRef("chat-a");
    const chatB = chatRef("chat-b");
    const spec = specRef("spec-a");
    const tab1 = canvasOf(
      [chatA, chatB, spec],
      group("g-1", "horizontal", [
        pane("p-1", [chatA.instanceId, spec.instanceId]),
        group("g-2", "vertical", [pane("p-2", [chatB.instanceId])]),
      ]),
    );
    // tab-2 is a bare pane in a different view tab entirely.
    const chatC = chatRef("chat-c");
    const tab2 = canvasOf([chatC], pane("p-3", [chatC.instanceId]));

    const ids = selectOpenChatIds(stateWith({ "tab-1": tab1, "tab-2": tab2 }));

    expect([...ids].sort()).toEqual(["chat-a", "chat-b", "chat-c"]);
  });

  it("collapses the same chat open in two tiles to one id, and ignores a tab with no canvas", () => {
    const first = chatRef("chat-dup");
    const second: EpicCanvasTileRef = {
      ...first,
      instanceId: "inst-chat-dup-2",
    };
    const canvas = canvasOf(
      [first, second],
      pane("p-1", [first.instanceId, second.instanceId]),
    );

    const ids = selectOpenChatIds(
      stateWith({ "tab-1": canvas, "tab-2": undefined }),
    );

    expect([...ids]).toEqual(["chat-dup"]);
  });

  it("is empty when nothing is open", () => {
    expect(selectOpenChatIds(stateWith({})).size).toBe(0);
  });

  it("answers in a stable order regardless of where the walk met each tile", () => {
    const chatA = chatRef("chat-a");
    const chatB = chatRef("chat-b");
    const refs = [chatA, chatB];
    const forward = canvasOf(
      refs,
      pane("p-1", [chatA.instanceId, chatB.instanceId]),
    );
    const reversed = canvasOf(
      refs,
      pane("p-1", [chatB.instanceId, chatA.instanceId]),
    );

    expect([...selectOpenChatIds(stateWith({ "tab-1": forward }))]).toEqual([
      ...selectOpenChatIds(stateWith({ "tab-1": reversed })),
    ]);
  });
});

describe("useOpenChatIds", () => {
  afterEach(() => {
    useEpicCanvasStore.setState({ canvasByTabId: {} });
  });

  it("keeps the same Set across a pane reorder that changes no membership", () => {
    const chatA = chatRef("chat-a");
    const chatB = chatRef("chat-b");
    const refs = [chatA, chatB];
    useEpicCanvasStore.setState({
      canvasByTabId: {
        "tab-1": canvasOf(
          refs,
          pane("p-1", [chatA.instanceId, chatB.instanceId]),
        ),
      },
    });

    const { result } = renderHook(() => useOpenChatIds());
    const before = result.current;
    expect([...before]).toEqual(["chat-a", "chat-b"]);

    // Dragging a tab within its pane: same chats open, different traversal
    // order. Without the sort this handed `useShallow` a permuted array and
    // minted a new Set, re-rendering every drafts row on a change the `Open`
    // badge does not depend on.
    act(() => {
      useEpicCanvasStore.setState({
        canvasByTabId: {
          "tab-1": canvasOf(
            refs,
            pane("p-1", [chatB.instanceId, chatA.instanceId]),
          ),
        },
      });
    });

    expect(result.current).toBe(before);
  });

  it("does produce a new Set when a chat actually opens", () => {
    const chatA = chatRef("chat-a");
    useEpicCanvasStore.setState({
      canvasByTabId: {
        "tab-1": canvasOf([chatA], pane("p-1", [chatA.instanceId])),
      },
    });

    const { result } = renderHook(() => useOpenChatIds());
    const before = result.current;

    const chatB = chatRef("chat-b");
    act(() => {
      useEpicCanvasStore.setState({
        canvasByTabId: {
          "tab-1": canvasOf(
            [chatA, chatB],
            pane("p-1", [chatA.instanceId, chatB.instanceId]),
          ),
        },
      });
    });

    expect(result.current).not.toBe(before);
    expect([...result.current]).toEqual(["chat-a", "chat-b"]);
  });
});
