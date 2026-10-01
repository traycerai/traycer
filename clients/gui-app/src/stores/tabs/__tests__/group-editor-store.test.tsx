import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GroupEditorScope,
  useGroupEditor,
  useGroupEditorStore,
  useGroupEditorTarget,
} from "../group-editor-store";

// A group split across two of the Activity view's sections has a block in
// each, and each block is a scope its label anchors to and its tasks ask from.

function inScope(scope: string | null) {
  return function Scope(props: { readonly children: ReactNode }): ReactNode {
    return <GroupEditorScope value={scope}>{props.children}</GroupEditorScope>;
  };
}

/** A task's "Edit group…", as its menu runs it once the menu has closed. */
function editGroupFrom(target: string | null): void {
  if (target === null) throw new Error("no anchor to open");
  act(() => {
    useGroupEditorStore.getState().request(target);
    useGroupEditorStore.getState().openRequested();
  });
}

describe("the group editor's open state", () => {
  beforeEach(() => {
    useGroupEditorStore.setState(useGroupEditorStore.getInitialState(), true);
  });
  afterEach(() => cleanup());

  it("opens only the block a task's Edit group… asked from, when its group has two", () => {
    const working = renderHook(() => useGroupEditor("work"), {
      wrapper: inScope("working"),
    });
    const idle = renderHook(() => useGroupEditor("work"), {
      wrapper: inScope("idle"),
    });
    const idleTask = renderHook(() => useGroupEditorTarget("work"), {
      wrapper: inScope("idle"),
    });

    editGroupFrom(idleTask.result.current);

    expect(idle.result.current.open).toBe(true);
    expect(working.result.current.open).toBe(false);
  });

  it("opens a task outside any block at its group's anchor", () => {
    const chip = renderHook(() => useGroupEditor("work"), {
      wrapper: inScope(null),
    });
    const topStripTask = renderHook(() => useGroupEditorTarget("work"), {
      wrapper: inScope(null),
    });

    editGroupFrom(topStripTask.result.current);

    expect(chip.result.current.open).toBe(true);
  });

  it("closes an editor with its own block, and offers no Edit group in a block that is gone", () => {
    const working = renderHook(() => useGroupEditor("work"), {
      wrapper: inScope("working"),
    });
    const idle = renderHook(() => useGroupEditor("work"), {
      wrapper: inScope("idle"),
    });
    const idleTask = renderHook(() => useGroupEditorTarget("work"), {
      wrapper: inScope("idle"),
    });
    act(() => working.result.current.setOpen(true));

    idle.unmount();
    idleTask.rerender();

    expect(working.result.current.open).toBe(true);
    expect(idleTask.result.current).toBeNull();

    working.unmount();

    expect(useGroupEditorStore.getState().anchorId).toBeNull();
  });
});
