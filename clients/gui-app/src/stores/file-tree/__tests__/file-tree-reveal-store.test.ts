import { afterEach, describe, expect, it } from "vitest";
import {
  clearFileTreeRevealRequest,
  requestFileTreeReveal,
  useFileTreeRevealRequest,
  useFileTreeRevealStore,
  type FileTreeRevealTarget,
} from "@/stores/file-tree/file-tree-reveal-store";
import { renderHook } from "@testing-library/react";

const TAB_1 = "tab-1";
const TAB_2 = "tab-2";

const TARGET_A: FileTreeRevealTarget = {
  hostId: "host-1",
  workspacePath: "/repo",
  filePath: "src/lib/a.ts",
};
const TARGET_B: FileTreeRevealTarget = {
  hostId: "host-1",
  workspacePath: "/repo",
  filePath: "src/lib/b.ts",
};

function requestFor(viewTabId: string) {
  return renderHook(() => useFileTreeRevealRequest(viewTabId)).result.current;
}

afterEach(() => {
  useFileTreeRevealStore.setState({ requestsByViewTabId: {} }, true);
});

describe("file-tree-reveal-store", () => {
  it("records a reveal request with nonce 1 on the first request for a view tab", () => {
    requestFileTreeReveal(TAB_1, TARGET_A);
    expect(requestFor(TAB_1)).toEqual({ ...TARGET_A, nonce: 1 });
  });

  it("bumps the nonce on a repeat request for the same view tab and replaces the target", () => {
    requestFileTreeReveal(TAB_1, TARGET_A);
    requestFileTreeReveal(TAB_1, TARGET_B);
    expect(requestFor(TAB_1)).toEqual({ ...TARGET_B, nonce: 2 });

    // A repeat request for the SAME file also bumps the nonce, so a
    // re-reveal of the file the user just scrolled away from still fires.
    requestFileTreeReveal(TAB_1, TARGET_B);
    expect(requestFor(TAB_1)).toEqual({ ...TARGET_B, nonce: 3 });
  });

  it("keeps requests independent per view tab", () => {
    requestFileTreeReveal(TAB_1, TARGET_A);
    requestFileTreeReveal(TAB_2, TARGET_B);
    expect(requestFor(TAB_1)).toEqual({ ...TARGET_A, nonce: 1 });
    expect(requestFor(TAB_2)).toEqual({ ...TARGET_B, nonce: 1 });

    // A later request in one tab does not disturb the other's.
    requestFileTreeReveal(TAB_1, TARGET_B);
    expect(requestFor(TAB_1)).toEqual({ ...TARGET_B, nonce: 2 });
    expect(requestFor(TAB_2)).toEqual({ ...TARGET_B, nonce: 1 });
  });

  it("clears the request when the nonce matches", () => {
    requestFileTreeReveal(TAB_1, TARGET_A);
    clearFileTreeRevealRequest(TAB_1, 1);
    expect(requestFor(TAB_1)).toBeNull();
  });

  it("leaves a newer request intact when clearing with a stale nonce", () => {
    requestFileTreeReveal(TAB_1, TARGET_A); // nonce 1
    requestFileTreeReveal(TAB_1, TARGET_B); // nonce 2 - replaces target A
    clearFileTreeRevealRequest(TAB_1, 1); // stale - a consumer that read nonce 1
    expect(requestFor(TAB_1)).toEqual({ ...TARGET_B, nonce: 2 });
  });

  it("treats clearing an unknown view tab as a no-op", () => {
    const before = useFileTreeRevealStore.getState();
    clearFileTreeRevealRequest(TAB_1, 1);
    expect(useFileTreeRevealStore.getState()).toBe(before);
  });

  it("returns null from useFileTreeRevealRequest when no request is pending", () => {
    expect(requestFor(TAB_1)).toBeNull();
  });
});
