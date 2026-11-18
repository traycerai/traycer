/**
 * Regression pin for the debounced-rename race in `flushPersist`
 * (`use-artifact-doc-title-follow.ts`).
 *
 * `use-artifact-doc-title-follow.test.ts` covers only the pure reducer
 * (`nextTitleFollow` / `leadingDocTitle`) - the HOOK itself, which owns the
 * 800ms debounce and the RPC dispatch, had zero coverage. That is exactly why
 * a PR could remove the flush-time re-validation guard without any test
 * turning red: a sidebar/remote rename landing inside the debounce window
 * was silently clobbered by the stale, already-scheduled RPC.
 *
 * This file renders the HOOK (not the reducer) over a REAL Tiptap `Editor`,
 * with `vi.useFakeTimers()` driving the 800ms window, and mocks only the
 * hook's three external dependencies: the open-epic handle (a fake store
 * whose `artifacts` slice this file mutates between ticks), the rename
 * mutation (`useEpicRenameArtifact`), and the canvas store's
 * `renameArtifactInTab` selector.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { ArtifactProjection } from "@/stores/epics/open-epic/types";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";

interface RenameVariables {
  readonly epicId: string;
  readonly artifactId: string;
  readonly title: string;
}

interface RenameResponse {
  readonly updated: boolean;
}

const ARTIFACT_ID = "artifact-1";
const EPIC_ID = "epic-1";
const VIEW_TAB_ID = "tab-1";
const HOST_ID = "host-1";
const DEFAULT_TITLE = "New spec";

const mocks = vi.hoisted(() => {
  const artifactsState: {
    byId: Record<string, ArtifactProjection>;
    allIds: string[];
  } = { byId: {}, allIds: [] };
  const handle = {
    store: {
      getState: () => ({ artifacts: artifactsState }),
    },
  };
  return {
    artifactsState,
    handle,
    renameArtifactInTab:
      vi.fn<(tabId: string, artifactId: string, name: string) => void>(),
    mutateAsync:
      vi.fn<(variables: RenameVariables) => Promise<RenameResponse>>(),
  };
});

vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => mocks.handle,
}));

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicRenameArtifact: () => ({ mutateAsync: mocks.mutateAsync }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: <T,>(
    selector: (state: {
      readonly renameArtifactInTab: typeof mocks.renameArtifactInTab;
    }) => T,
  ): T => selector({ renameArtifactInTab: mocks.renameArtifactInTab }),
}));

import { useArtifactDocTitleFollow } from "../use-artifact-doc-title-follow";

const editors: Editor[] = [];

function makeEditor(): Editor {
  const editor = new Editor({ extensions: [StarterKit], content: "" });
  editors.push(editor);
  return editor;
}

function artifactNode(): EpicArtifactRef {
  return {
    id: ARTIFACT_ID,
    instanceId: "inst-1",
    type: "spec",
    name: DEFAULT_TITLE,
    hostId: HOST_ID,
  };
}

/** Replaces the whole `artifacts` slice with one row, `ARTIFACT_ID`. */
function setArtifact(overrides: Partial<ArtifactProjection>): void {
  const artifact: ArtifactProjection = {
    id: ARTIFACT_ID,
    kind: "spec",
    title: DEFAULT_TITLE,
    folderName: "",
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: true,
    ...overrides,
  };
  mocks.artifactsState.byId = { [ARTIFACT_ID]: artifact };
  mocks.artifactsState.allIds = [ARTIFACT_ID];
}

function renderTitleFollow(editor: Editor) {
  return renderHook(() =>
    useArtifactDocTitleFollow({
      editor,
      epicId: EPIC_ID,
      node: artifactNode(),
      viewTabId: VIEW_TAB_ID,
      editable: true,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.mutateAsync.mockReset();
  mocks.mutateAsync.mockResolvedValue({ updated: true });
  mocks.renameArtifactInTab.mockReset();
  setArtifact({});
});

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  vi.useRealTimers();
});

describe("useArtifactDocTitleFollow - flushPersist re-validates before sending", () => {
  it("COMPETING RENAME: a sidebar/remote rename landing inside the 800ms window is not clobbered", () => {
    const editor = makeEditor();
    const { unmount } = renderTitleFollow(editor);

    act(() => {
      editor.commands.setContent("<h1>A</h1>", { emitUpdate: true });
    });

    // BEFORE the debounce fires: a sidebar/remote rename lands, breaking the
    // "title follows the doc" link exactly as an explicit rename always does.
    setArtifact({ title: "Explicit sidebar name" });

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    unmount();
  });

  it("ORDINARY SEQUENTIAL TYPING still persists (anti-vacuity control)", () => {
    const editor = makeEditor();
    const { unmount } = renderTitleFollow(editor);

    act(() => {
      editor.commands.setContent("<h1>A</h1>", { emitUpdate: true });
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      artifactId: ARTIFACT_ID,
      title: "A",
    });

    // The successful RPC round-trip's local echo - exactly what
    // `renameArtifactInTab` plus the doc's own live rename would leave
    // behind - so the next edit is read against "A", not the create-flow
    // default.
    setArtifact({ title: "A" });

    act(() => {
      editor.commands.setContent("<h1>B</h1>", { emitUpdate: true });
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.mutateAsync).toHaveBeenNthCalledWith(2, {
      epicId: EPIC_ID,
      artifactId: ARTIFACT_ID,
      title: "B",
    });
    unmount();
  });

  it("FAILED RPC DOES NOT BREAK FOLLOWING: a rejected send still lets the next edit persist", async () => {
    mocks.mutateAsync.mockReset();
    mocks.mutateAsync.mockRejectedValueOnce(new Error("rename failed"));
    const editor = makeEditor();
    const { unmount } = renderTitleFollow(editor);

    act(() => {
      editor.commands.setContent("<h1>A</h1>", { emitUpdate: true });
    });
    // Async: the rejection has to settle (a microtask) before the next
    // assertion, and before the second edit's flush decision can be trusted.
    await act(() => vi.advanceTimersByTimeAsync(800));

    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    // No optimistic write - the store never moved off the create-flow
    // default, since the removed guard was the only thing that would have
    // written it and this hook never did that itself.
    expect(mocks.artifactsState.byId[ARTIFACT_ID].title).toBe(DEFAULT_TITLE);

    mocks.mutateAsync.mockResolvedValue({ updated: true });
    act(() => {
      editor.commands.setContent("<h1>B</h1>", { emitUpdate: true });
    });
    await act(() => vi.advanceTimersByTimeAsync(800));

    expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.mutateAsync).toHaveBeenNthCalledWith(2, {
      epicId: EPIC_ID,
      artifactId: ARTIFACT_ID,
      title: "B",
    });
    unmount();
  });
});
