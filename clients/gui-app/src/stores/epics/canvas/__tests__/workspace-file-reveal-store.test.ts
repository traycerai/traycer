import { afterEach, describe, expect, it } from "vitest";
import {
  clearWorkspaceFileRevealTarget,
  setWorkspaceFileRevealTarget,
  useWorkspaceFileRevealStore,
  useWorkspaceFileRevealTarget,
} from "@/stores/epics/canvas/workspace-file-reveal-store";
import { renderHook } from "@testing-library/react";

const TAB_1 = "tab-1";
const TAB_2 = "tab-2";
const FILE_A = "workspace-file:host-1:/repo:src/a.ts";
const FILE_B = "workspace-file:host-1:/repo:src/b.ts";

function targetFor(viewTabId: string, contentId: string) {
  return renderHook(() => useWorkspaceFileRevealTarget(viewTabId, contentId))
    .result.current;
}

function entryCount(): number {
  return Object.keys(useWorkspaceFileRevealStore.getState().targetsByKey)
    .length;
}

afterEach(() => {
  useWorkspaceFileRevealStore.setState({ targetsByKey: {} }, true);
});

describe("workspace-file-reveal-store", () => {
  it("records a reveal target with nonce 1 on first set", () => {
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 42, 7);
    expect(targetFor(TAB_1, FILE_A)).toEqual({ line: 42, col: 7, nonce: 1 });
  });

  it("bumps the nonce on a repeat set so a same-line re-click still re-fires", () => {
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 42, null);
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 42, null);
    expect(targetFor(TAB_1, FILE_A)?.nonce).toBe(2);

    // A different line on the same file keeps bumping the same key's nonce.
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 100, null);
    expect(targetFor(TAB_1, FILE_A)).toEqual({
      line: 100,
      col: null,
      nonce: 3,
    });
  });

  it("keeps targets independent per content id", () => {
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 10, null);
    setWorkspaceFileRevealTarget(TAB_1, FILE_B, 20, null);
    expect(targetFor(TAB_1, FILE_A)).toEqual({ line: 10, col: null, nonce: 1 });
    expect(targetFor(TAB_1, FILE_B)).toEqual({ line: 20, col: null, nonce: 1 });
  });

  it("scopes the same file per view tab so a click in one tab does not target another (CL-6)", () => {
    // The same file is previewed in two tabs; a click in TAB_1 must reach only
    // TAB_1's entry, leaving TAB_2's preview untouched.
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 10, null);
    expect(targetFor(TAB_1, FILE_A)).toEqual({ line: 10, col: null, nonce: 1 });
    expect(targetFor(TAB_2, FILE_A)).toBeNull();

    // A later click in TAB_2 is likewise isolated.
    setWorkspaceFileRevealTarget(TAB_2, FILE_A, 99, null);
    expect(targetFor(TAB_1, FILE_A)).toEqual({ line: 10, col: null, nonce: 1 });
    expect(targetFor(TAB_2, FILE_A)).toEqual({ line: 99, col: null, nonce: 1 });

    // Clearing one tab's entry leaves the other tab's entry intact.
    clearWorkspaceFileRevealTarget(TAB_1, FILE_A);
    expect(targetFor(TAB_1, FILE_A)).toBeNull();
    expect(targetFor(TAB_2, FILE_A)).toEqual({ line: 99, col: null, nonce: 1 });
  });

  it("clears a target on consume and leaves a fresh set starting at nonce 1", () => {
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 10, null);
    clearWorkspaceFileRevealTarget(TAB_1, FILE_A);
    expect(targetFor(TAB_1, FILE_A)).toBeNull();

    // A click after consume writes a brand-new entry (nonce resets to 1).
    setWorkspaceFileRevealTarget(TAB_1, FILE_A, 11, null);
    expect(targetFor(TAB_1, FILE_A)).toEqual({ line: 11, col: null, nonce: 1 });
  });

  it("treats clearing an unknown key as a no-op", () => {
    const before = useWorkspaceFileRevealStore.getState();
    clearWorkspaceFileRevealTarget(
      TAB_1,
      "workspace-file:host-1:/repo:missing.ts",
    );
    expect(useWorkspaceFileRevealStore.getState()).toBe(before);
  });

  it("caps the map so a flood of distinct failing clicks cannot grow it unbounded (CL-5)", () => {
    // Far more distinct targets than the cap; the map must stay bounded even
    // though none of these were consumed (the dead-tile / error path).
    for (let i = 0; i < 500; i += 1) {
      setWorkspaceFileRevealTarget(
        TAB_1,
        `workspace-file:host-1:/repo:src/file-${i}.ts`,
        i + 1,
        null,
      );
    }
    expect(entryCount()).toBeLessThanOrEqual(64);

    // The most-recent write is retained (eviction drops the oldest, never the
    // entry just written for an imminent open).
    expect(
      targetFor(TAB_1, "workspace-file:host-1:/repo:src/file-499.ts"),
    ).toEqual({ line: 500, col: null, nonce: 1 });
  });
});
