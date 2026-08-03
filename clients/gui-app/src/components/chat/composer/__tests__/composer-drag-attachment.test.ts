import { describe, expect, it } from "vitest";
import {
  ACTIVE_AGENT_DND_TYPE,
  ARTIFACT_TAB_DND_TYPE,
  CHAT_ARTIFACT_DND_TYPE,
  GIT_DIFF_TILE_DND_TYPE,
  TERMINAL_TILE_DND_TYPE,
  WORKSPACE_FILE_DND_TYPE,
  WORKSPACE_FOLDER_DND_TYPE,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { mentionAttachmentFromDragSource } from "@/components/chat/composer/composer-drag-attachment";

const SCOPE = { epicId: "epic-1", viewTabId: "view-1" } as const;

describe("mentionAttachmentFromDragSource", () => {
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
      workspacePath: "D:\\repo",
      folderPath: "src/components/",
      name: "components",
    };

    expect(mentionAttachmentFromDragSource(fileSource)).toEqual({
      kind: "mention",
      contextType: "file",
      path: "src/components/button.tsx",
      pathKind: "file",
      relPath: "src/components/button.tsx",
      absolutePath: "/repo/src/components/button.tsx",
      workspacePath: "/repo",
      label: "button.tsx",
      description: "src/components",
    });
    expect(mentionAttachmentFromDragSource(folderSource)).toEqual({
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
      mentionAttachmentFromDragSource({
        ...fileSource,
        ref: {
          ...fileSource.ref,
          filePath: "../../etc/passwd",
        },
      }),
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
      },
    };

    expect(mentionAttachmentFromDragSource(artifactSource)).toMatchObject({
      contextType: "spec",
      path: "spec:epic-1/spec-1",
      epicId: "epic-1",
      artifactId: "spec-1",
      label: "Composer spec",
    });
    expect(mentionAttachmentFromDragSource(agentSource)).toMatchObject({
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

    expect(mentionAttachmentFromDragSource(gitFileSource)).toMatchObject({
      contextType: "file",
      path: "src/app.ts",
      label: "app.ts",
    });
    expect(mentionAttachmentFromDragSource(bundleSource)).toBeNull();
    expect(mentionAttachmentFromDragSource(terminalSource)).toBeNull();
  });

  it("does not attach draggable canvas tabs themselves", () => {
    const tabSource: EpicCanvasDragSourceData = {
      kind: ARTIFACT_TAB_DND_TYPE,
      ...SCOPE,
      sourceGroupId: "group-1",
      tabId: "tab-1",
      isPreview: false,
    };
    expect(mentionAttachmentFromDragSource(tabSource)).toBeNull();
  });
});
