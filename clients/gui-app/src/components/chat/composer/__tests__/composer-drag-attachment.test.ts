import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_AGENT_DND_TYPE,
  ARTIFACT_TAB_DND_TYPE,
  CHAT_ARTIFACT_DND_TYPE,
  GIT_DIFF_TILE_DND_TYPE,
  SIDEBAR_NODE_DND_TYPE,
  TERMINAL_TILE_DND_TYPE,
  WORKSPACE_FILE_DND_TYPE,
  WORKSPACE_FOLDER_DND_TYPE,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { mentionAttachmentFromDragSource } from "@/components/chat/composer/composer-drag-attachment";

const { peekOpenEpicMock, epicTreeRecordMock } = vi.hoisted(() => ({
  peekOpenEpicMock: vi.fn(),
  epicTreeRecordMock: vi.fn(),
}));

vi.mock("@/lib/registries/epic-session-registry", () => ({
  getOpenEpicRegistry: () => ({ peek: peekOpenEpicMock }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  epicTreeRecordForNodeId: epicTreeRecordMock,
}));

const SCOPE = { epicId: "epic-1", viewTabId: "view-1" } as const;
const TARGET_HOST_ID = "host-1";

beforeEach(() => {
  peekOpenEpicMock.mockReset();
  epicTreeRecordMock.mockReset();
  peekOpenEpicMock.mockReturnValue(null);
});

describe("mentionAttachmentFromDragSource", () => {
  it("resolves sidebar nodes through the open Epic projection", () => {
    peekOpenEpicMock.mockReturnValue({
      store: {
        getState: () => ({
          epic: { title: "Drag attachments" },
          tuiAgents: { byId: {} },
        }),
      },
    });
    epicTreeRecordMock.mockReturnValue({
      id: "spec-1",
      parentId: null,
      name: "Composer spec",
      type: "spec",
      status: null,
      hostId: TARGET_HOST_ID,
    });
    const source: EpicCanvasDragSourceData = {
      kind: SIDEBAR_NODE_DND_TYPE,
      ...SCOPE,
      hostId: TARGET_HOST_ID,
      nodeId: "spec-1",
    };

    expect(
      mentionAttachmentFromDragSource(source, TARGET_HOST_ID),
    ).toMatchObject({
      contextType: "spec",
      path: "spec:epic-1/spec-1",
      label: "Composer spec",
      description: "Drag attachments",
    });
    expect(
      mentionAttachmentFromDragSource(
        { ...source, hostId: "host-2" },
        TARGET_HOST_ID,
      ),
    ).toBeNull();
  });

  it("rejects unavailable sidebar sessions and records", () => {
    const source: EpicCanvasDragSourceData = {
      kind: SIDEBAR_NODE_DND_TYPE,
      ...SCOPE,
      hostId: TARGET_HOST_ID,
      nodeId: "missing",
    };

    expect(mentionAttachmentFromDragSource(source, TARGET_HOST_ID)).toBeNull();

    peekOpenEpicMock.mockReturnValue({
      store: {
        getState: () => ({
          epic: { title: "Drag attachments" },
          tuiAgents: { byId: {} },
        }),
      },
    });
    epicTreeRecordMock.mockReturnValue(null);
    expect(mentionAttachmentFromDragSource(source, TARGET_HOST_ID)).toBeNull();
  });

  it("builds the existing file and folder mention shapes", () => {
    const fileSource: EpicCanvasDragSourceData = {
      kind: WORKSPACE_FILE_DND_TYPE,
      ...SCOPE,
      ref: {
        id: "file-tab",
        instanceId: "file-instance",
        type: "workspace-file",
        name: "button.tsx",
        hostId: "host-1",
        workspacePath: "/repo",
        filePath: "src/components/button.tsx",
      },
    };
    const folderSource: EpicCanvasDragSourceData = {
      kind: WORKSPACE_FOLDER_DND_TYPE,
      ...SCOPE,
      hostId: TARGET_HOST_ID,
      workspacePath: "D:\\repo",
      folderPath: "src/components/",
      name: "components",
    };

    expect(mentionAttachmentFromDragSource(fileSource, TARGET_HOST_ID)).toEqual(
      {
        kind: "mention",
        contextType: "file",
        path: "src/components/button.tsx",
        pathKind: "file",
        relPath: "src/components/button.tsx",
        absolutePath: "/repo/src/components/button.tsx",
        workspacePath: "/repo",
        label: "button.tsx",
        description: "src/components",
      },
    );
    expect(
      mentionAttachmentFromDragSource(folderSource, TARGET_HOST_ID),
    ).toEqual({
      kind: "mention",
      contextType: "folder",
      path: "src/components/",
      pathKind: "folder",
      relPath: "src/components/",
      absolutePath: "D:\\repo\\src\\components",
      workspacePath: "D:\\repo",
      label: "components",
      description: "src",
    });
    expect(
      mentionAttachmentFromDragSource(
        {
          ...fileSource,
          ref: {
            ...fileSource.ref,
            filePath: "../../etc/passwd",
          },
        },
        TARGET_HOST_ID,
      ),
    ).toMatchObject({
      path: "etc/passwd",
      relPath: "etc/passwd",
      absolutePath: "/repo/etc/passwd",
    });
  });

  it("turns artifact and terminal-interface agent sources into entity mentions", () => {
    const artifactSource: EpicCanvasDragSourceData = {
      kind: CHAT_ARTIFACT_DND_TYPE,
      ...SCOPE,
      artifact: {
        id: "spec-1",
        type: "spec",
        name: "Composer spec",
        hostId: "host-1",
      },
    };
    const agentSource: EpicCanvasDragSourceData = {
      kind: ACTIVE_AGENT_DND_TYPE,
      ...SCOPE,
      agent: {
        id: "agent-1",
        type: "terminal-agent",
        name: "Implementation agent",
        hostId: "host-1",
        harnessId: "claude",
      },
    };

    expect(
      mentionAttachmentFromDragSource(artifactSource, TARGET_HOST_ID),
    ).toMatchObject({
      contextType: "spec",
      path: "spec:epic-1/spec-1",
      epicId: "epic-1",
      artifactId: "spec-1",
      label: "Composer spec",
    });
    expect(
      mentionAttachmentFromDragSource(agentSource, TARGET_HOST_ID),
    ).toMatchObject({
      contextType: "terminal-agent",
      path: "terminal-agent:epic-1/agent-1",
      epicId: "epic-1",
      terminalAgentId: "agent-1",
      label: "Implementation agent",
    });
  });

  it("accepts individual Git files but rejects bundles and terminal sessions", () => {
    const gitFileSource: EpicCanvasDragSourceData = {
      kind: GIT_DIFF_TILE_DND_TYPE,
      ...SCOPE,
      tile: {
        id: "git-file",
        instanceId: "git-file-instance",
        type: "git-diff",
        name: "app.ts · Changes",
        hostId: "host-1",
        repositoryContext: null,
        diff: {
          kind: "file",
          runningDir: "/repo",
          filePath: "src/app.ts",
          stage: "unstaged",
        },
        view: { collapsedFilePaths: [] },
      },
    };
    const bundleSource: EpicCanvasDragSourceData = {
      ...gitFileSource,
      tile: {
        ...gitFileSource.tile,
        diff: {
          kind: "bundle",
          runningDir: "/repo",
          bundleGroup: "changes",
        },
      },
    };
    const terminalSource: EpicCanvasDragSourceData = {
      kind: TERMINAL_TILE_DND_TYPE,
      ...SCOPE,
      tile: {
        id: "terminal-1",
        instanceId: "terminal-instance",
        type: "terminal",
        name: "Terminal",
        titleSource: "default",
        hostId: "host-1",
        cwd: "/repo",
      },
    };

    expect(
      mentionAttachmentFromDragSource(gitFileSource, TARGET_HOST_ID),
    ).toMatchObject({
      contextType: "file",
      path: "src/app.ts",
      label: "app.ts",
    });
    expect(
      mentionAttachmentFromDragSource(bundleSource, TARGET_HOST_ID),
    ).toBeNull();
    expect(
      mentionAttachmentFromDragSource(terminalSource, TARGET_HOST_ID),
    ).toBeNull();
  });

  it("does not attach draggable canvas tabs themselves", () => {
    const tabSource: EpicCanvasDragSourceData = {
      kind: ARTIFACT_TAB_DND_TYPE,
      ...SCOPE,
      sourceGroupId: "group-1",
      tabId: "tab-1",
      isPreview: false,
    };
    expect(
      mentionAttachmentFromDragSource(tabSource, TARGET_HOST_ID),
    ).toBeNull();
  });

  it("rejects host-local paths from a different host and Cursor TUI agents", () => {
    const fileSource: EpicCanvasDragSourceData = {
      kind: WORKSPACE_FILE_DND_TYPE,
      ...SCOPE,
      ref: {
        id: "file-tab",
        instanceId: "file-instance",
        type: "workspace-file",
        name: "app.ts",
        hostId: "host-2",
        workspacePath: "/repo",
        filePath: "src/app.ts",
      },
    };
    const cursorAgentSource: EpicCanvasDragSourceData = {
      kind: ACTIVE_AGENT_DND_TYPE,
      ...SCOPE,
      agent: {
        id: "cursor-agent",
        type: "terminal-agent",
        name: "Cursor",
        hostId: TARGET_HOST_ID,
        harnessId: "cursor",
      },
    };

    expect(
      mentionAttachmentFromDragSource(fileSource, TARGET_HOST_ID),
    ).toBeNull();
    expect(
      mentionAttachmentFromDragSource(cursorAgentSource, TARGET_HOST_ID),
    ).toBeNull();
  });
});
