import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitChangedFile } from "@traycer/protocol/host";
import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { DEFAULT_DIFF_VIEWER_PREFERENCES } from "@/lib/diff/diff-viewer-preferences";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { BundleFileSection } from "../git-bundle-file-section";
import type { GitBundleDiffTileRef } from "../git-diff-tile-shared";

const FILE: GitChangedFile = {
  path: "src/app.ts",
  previousPath: null,
  status: "modified",
  stage: "unstaged",
  insertions: 1_001,
  deletions: 0,
  isBinary: false,
  sizeBytes: 1_024,
  stagedOid: null,
  worktreeOid: "worktree-1",
};

function bundleNode(): GitBundleDiffTileRef {
  const node = makeGitBundleDiffTile({
    hostId: "host-1",
    runningDir: "/repo",
    bundleGroup: "changes",
    repositoryContext: null,
  });
  if (node.diff.kind !== "bundle") throw new Error("expected bundle node");
  return { ...node, diff: node.diff };
}

const NODE = bundleNode();

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicSessionHandle: OpenEpicStoreHandle;

describe("<BundleFileSection />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    nestedFocusBoundaryMock.navigateNested.mockClear();
    epicSessionHandle = createOpenEpicStore({
      epicId: "epic-1",
      userId: null,
      streamClientFactory: fakeStreamClientFactory,
      onAuthError: null,
    });
  });

  afterEach(() => {
    cleanup();
    epicSessionHandle.dispose();
  });

  it("opens the source file rather than another diff tile", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    render(
      <EpicSessionContext.Provider value={epicSessionHandle}>
        <BundleFileSection
          node={NODE}
          viewTabId={tabId}
          file={FILE}
          headSha="head-1"
          diffViewerPreferences={DEFAULT_DIFF_VIEWER_PREFERENCES}
        />
      </EpicSessionContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "File" }));

    expect(nestedFocusBoundaryMock.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      tabId,
      expect.any(Function),
    );
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected pane");
    const activeTileId = canvas.root.activeTabId;
    if (activeTileId === null) throw new Error("expected active tile");
    const tile = canvas.tilesByInstanceId[activeTileId];
    expect(tile).toEqual(
      expect.objectContaining({
        type: "workspace-file",
        name: "app.ts",
        hostId: "host-1",
        workspacePath: "/repo",
        filePath: "src/app.ts",
      }),
    );
  });
});
