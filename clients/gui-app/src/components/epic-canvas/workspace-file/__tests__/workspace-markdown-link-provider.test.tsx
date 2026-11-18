import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { use } from "react";
import { WorkspaceMarkdownLinkProvider } from "@/components/epic-canvas/workspace-file/workspace-markdown-link-provider";
import { workspaceFileTabId } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";

const HOST_ID = "host-1";

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
});

function LinkButton(props: {
  readonly label: string;
  readonly link: MarkdownFileLink;
}) {
  const policy = use(MarkdownLinkContext);
  return (
    <button
      type="button"
      onClick={() => {
        policy?.openFileLink(props.link);
      }}
    >
      {props.label}
    </button>
  );
}

describe("WorkspaceMarkdownLinkProvider", () => {
  it("opens markdown-preview file links as preview tabs", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    render(
      <WorkspaceMarkdownLinkProvider
        tabId={tabId}
        hostId={HOST_ID}
        workspacePath="/repo"
        filePath="docs/readme.md"
      >
        <LinkButton
          label="Open linked file"
          link={{
            path: "../src/app.ts",
            line: null,
            col: null,
            isDirectory: false,
          }}
        />
      </WorkspaceMarkdownLinkProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open linked file" }));

    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error(`Expected tab ${tabId}`);
    const panes = collectPanes(canvas.root);
    expect(panes).toHaveLength(1);
    const previewTabId = panes[0].previewTabId;
    if (previewTabId === null) throw new Error("Expected preview tab");
    expect(canvas.tilesByInstanceId[previewTabId]?.id).toBe(
      workspaceFileTabId(HOST_ID, "/repo", "src/app.ts"),
    );
  });
});
