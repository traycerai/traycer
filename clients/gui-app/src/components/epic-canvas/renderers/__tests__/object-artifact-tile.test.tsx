import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type {
  ArtifactProjection,
  ArtifactsSlice,
} from "@/stores/epics/open-epic/types";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { ObjectArtifactTile } from "@/components/epic-canvas/renderers/object-artifact-tile";

const EPIC_ID = "epic-1";
const SHA = "a".repeat(64);

const mocks = vi.hoisted(() => ({
  artifacts: { byId: {}, allIds: [] } as ArtifactsSlice,
  tabHostClient: null as {
    requestWithSignal: (...args: unknown[]) => Promise<unknown>;
  } | null,
  sandboxProps: [] as Array<{ readonly source: SandboxSource }>,
  mobile: false,
  surfaceProps: [] as Array<{
    readonly artifactId: string;
    readonly viewOnly?: boolean;
  }>,
  // Every argument the tile handed the body-lease hook, null arms included.
  bodyLeases: [] as Array<string | null>,
  fileViewerProps: [] as Array<{
    readonly epicId: string;
    readonly hostId: string;
    readonly name: string;
    readonly sha256: string;
  }>,
  fileViewerMounts: [] as string[],
}));

vi.mock("@/lib/mobile-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-app")>()),
  isMobileApp: () => mocks.mobile,
}));

// The surface itself is covered by its own tests. What the tile owns is
// whether to mount it and what to tell it.
vi.mock("@/components/canvas-artifact/canvas-artifact-surface", () => ({
  CanvasArtifactSurface: (props: {
    readonly artifactId: string;
    readonly viewOnly?: boolean;
  }) => {
    mocks.surfaceProps.push(props);
    return <div data-testid="canvas-surface" />;
  },
}));

// The viewer has its own tests. What the tile owns is whether a file artifact
// reaches it, with what, and whether a new sha gets a fresh instance.
vi.mock("@/components/epic-canvas/renderers/file-artifact-viewer", () => ({
  FileArtifactViewer: (props: {
    readonly epicId: string;
    readonly hostId: string;
    readonly name: string;
    readonly object: { readonly sha256: string };
  }) => {
    mocks.fileViewerProps.push({
      epicId: props.epicId,
      hostId: props.hostId,
      name: props.name,
      sha256: props.object.sha256,
    });
    // One entry per instance, recorded when it mounts with the sha it first
    // rendered. A changed sha prop on the same instance records nothing.
    const mountedWith = useRef(props.object.sha256);
    useEffect(() => {
      mocks.fileViewerMounts.push(mountedWith.current);
    }, []);
    return <div data-testid="file-viewer" />;
  },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useArtifactById: (id: string | null) =>
    id !== null && Object.hasOwn(mocks.artifacts.byId, id)
      ? mocks.artifacts.byId[id]
      : null,
  useEpicArtifactBodyLease: (id: string | null) => {
    mocks.bodyLeases.push(id);
  },
  // Comments on the tile have their own tests; here the room stays unanswered
  // so the tile renders without its comment layer.
  useEpicCommentRoomAvailability: () => ({ kind: "checking" as const }),
}));

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: <T,>(
    selector: (state: { artifacts: ArtifactsSlice }) => T,
  ): T => selector({ artifacts: mocks.artifacts }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.tabHostClient,
}));

// jsdom runs no frame; capture what the tile hands the real sandbox so the
// source's field stability survives an unrelated re-render is observable.
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: { readonly source: SandboxSource }) => {
    mocks.sandboxProps.push(props);
    return <div data-testid="sandbox-frame" />;
  },
}));

function artifact(
  overrides: Partial<ArtifactProjection> &
    Pick<ArtifactProjection, "id" | "kind" | "folderName">,
): ArtifactProjection {
  return {
    title: "Untitled",
    parentId: null,
    artifactRoomId: null,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    createdManually: false,
    ...overrides,
  };
}

function setArtifacts(artifacts: readonly ArtifactProjection[]): void {
  const byId: Record<string, ArtifactProjection> = {};
  const allIds: string[] = [];
  for (const entry of artifacts) {
    byId[entry.id] = entry;
    allIds.push(entry.id);
  }
  mocks.artifacts = { byId, allIds };
}

function node(id: string): EpicArtifactRef {
  return {
    id,
    instanceId: `instance-${id}`,
    type: "html",
    name: "node",
    hostId: "host-1",
  };
}

// Tile renderers always mount under the tab's host provider.
function tile(id: string): ReactNode {
  return (
    <TabHostContext.Provider value="host-1">
      <ObjectArtifactTile node={node(id)} epicId={EPIC_ID} />
    </TabHostContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  mocks.artifacts = { byId: {}, allIds: [] };
  mocks.tabHostClient = null;
  mocks.sandboxProps = [];
  mocks.mobile = false;
  mocks.surfaceProps = [];
  mocks.bodyLeases = [];
  mocks.fileViewerProps = [];
  mocks.fileViewerMounts = [];
});

describe("<ObjectArtifactTile />", () => {
  it("shows an unavailable notice when the artifact is not projected", () => {
    setArtifacts([]);
    render(tile("missing"));

    expect(screen.getByText("Artifact unavailable.")).toBeTruthy();
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();
  });

  it("mounts a SandboxFrame at the artifact's own folder for a folder-layout html artifact", () => {
    setArtifacts([
      artifact({ id: "docs", kind: "spec", folderName: "docs" }),
      artifact({
        id: "page",
        kind: "html",
        folderName: "report",
        parentId: "docs",
        layout: "folder",
        head: {
          files: {
            "index.html": {
              sha256: SHA,
              byteLength: 10,
              mediaType: "text/html",
              status: "published",
            },
          },
          capturedAt: 1,
        },
      }),
    ]);

    render(tile("page"));

    expect(screen.getByTestId("sandbox-frame")).toBeTruthy();
    const source = mocks.sandboxProps.at(-1)?.source;
    expect(source).toMatchObject({
      kind: "artifact",
      artifactId: "page",
      treePath: "docs/report",
      entryPath: "index.html",
    });
  });

  it("mounts a SandboxFrame at the parent's folder with the relativePath entry for a loose html artifact", () => {
    setArtifacts([
      artifact({ id: "docs", kind: "spec", folderName: "docs" }),
      artifact({
        id: "weather",
        kind: "html",
        folderName: "",
        parentId: "docs",
        layout: "file",
        relativePath: "weather.html",
        head: {
          files: {
            "weather.html": {
              sha256: SHA,
              byteLength: 10,
              mediaType: "text/html",
              status: "published",
            },
          },
          capturedAt: 1,
        },
      }),
    ]);

    render(tile("weather"));

    const source = mocks.sandboxProps.at(-1)?.source;
    expect(source).toMatchObject({
      kind: "artifact",
      artifactId: "weather",
      treePath: "docs",
      entryPath: "weather.html",
    });
  });

  describe("a canvas artifact", () => {
    const CANVAS_HEAD = {
      files: {
        "index.html": {
          sha256: SHA,
          byteLength: 10,
          mediaType: "text/html",
          status: "published",
        },
      },
      capturedAt: 1,
    } as const;

    function canvasArtifact(): ArtifactProjection {
      return artifact({
        id: "board",
        kind: "canvas",
        folderName: "board",
        head: CANVAS_HEAD,
      });
    }

    it("never mounts a SandboxFrame, and a browser is sent to the apps", () => {
      setArtifacts([canvasArtifact()]);

      render(tile("board"));

      expect(screen.queryByTestId("sandbox-frame")).toBeNull();
      expect(screen.queryByTestId("canvas-surface")).toBeNull();
      expect(mocks.surfaceProps).toEqual([]);
      expect(
        screen.getByText("Open this canvas in the desktop or mobile app."),
      ).toBeTruthy();
    });

    it("opens the canvas view-only in the mobile app", () => {
      mocks.mobile = true;
      setArtifacts([canvasArtifact()]);

      render(tile("board"));

      expect(screen.getByTestId("canvas-surface")).toBeTruthy();
      expect(screen.queryByTestId("sandbox-frame")).toBeNull();
      expect(
        screen.queryByText("Open this canvas in the desktop or mobile app."),
      ).toBeNull();
      expect(mocks.surfaceProps.at(-1)).toMatchObject({
        artifactId: "board",
        viewOnly: true,
      });
    });
  });

  // The lease is what makes the host run the epic's file work while the
  // artifact is on screen (capture of the folder, materialisation of a
  // collaborator's head); a chat-only task runs none of it.
  it("holds the artifact body lease for an html artifact and none for a file artifact", () => {
    setArtifacts([
      artifact({
        id: "page",
        kind: "html",
        folderName: "page",
        title: "Page",
        head: { files: {}, capturedAt: 0 },
      }),
      artifact({
        id: "logo",
        kind: "file",
        folderName: "",
        layout: "file",
        relativePath: "logo.png",
        title: "Logo",
        object: {
          sha256: SHA,
          byteLength: 2048,
          mediaType: "image/png",
          status: "published",
        },
      }),
    ]);

    render(tile("page"));
    expect(mocks.bodyLeases).toContain("page");
    cleanup();

    mocks.bodyLeases = [];
    render(tile("logo"));
    expect(mocks.bodyLeases).toEqual([null]);
  });

  it("shows the plain summary card, not the viewer, for a file artifact whose object has not been captured yet", () => {
    setArtifacts([
      artifact({
        id: "logo",
        kind: "file",
        folderName: "",
        layout: "file",
        relativePath: "logo.png",
        title: "Logo",
      }),
    ]);

    render(tile("logo"));

    expect(screen.queryByTestId("file-viewer")).toBeNull();
    expect(screen.queryByTestId("sandbox-frame")).toBeNull();
    expect(screen.getByText("Logo")).toBeTruthy();
    expect(screen.getByText("File")).toBeTruthy();
  });

  it("keeps the sandbox source's resolver and read span stable across an unrelated artifact's rename", () => {
    const page = artifact({
      id: "page",
      kind: "html",
      folderName: "report",
      head: {
        files: {
          "index.html": {
            sha256: SHA,
            byteLength: 10,
            mediaType: "text/html",
            status: "published",
          },
        },
        capturedAt: 1,
      },
    });
    const spec = artifact({
      id: "spec-1",
      kind: "spec",
      folderName: "spec-1",
      title: "Before",
    });
    setArtifacts([page, spec]);

    const view = render(tile("page"));
    const first = mocks.sandboxProps.at(-1)?.source;
    expect(first).toBeDefined();

    // Only the unrelated sibling changes identity, exactly as the real
    // projector's per-entry identity contract promises; `page` itself is the
    // SAME reference, as it would be for a real sibling rename.
    setArtifacts([page, { ...spec, title: "After" }]);
    view.rerender(tile("page"));

    const second = mocks.sandboxProps.at(-1)?.source;
    expect(second).toBeDefined();
    expect(second?.kind).toBe("artifact");
    expect(first?.kind).toBe("artifact");
    if (first?.kind === "artifact" && second?.kind === "artifact") {
      expect(second.resolveOutsideReference).toBe(
        first.resolveOutsideReference,
      );
      expect(second.readSpan).toBe(first.readSpan);
      expect(second.manifest).toBe(first.manifest);
      expect(second.treePath).toBe(first.treePath);
      expect(second.entryPath).toBe(first.entryPath);
    }
  });

  it("routes a file artifact to the file viewer under its file name, on the tab's host", () => {
    setArtifacts([
      artifact({
        id: "photo",
        kind: "file",
        folderName: "photo.png",
        object: {
          sha256: SHA,
          byteLength: 3,
          mediaType: "image/png",
          status: "published",
        },
      }),
    ]);

    render(tile("photo"));

    expect(screen.getByTestId("file-viewer")).toBeTruthy();
    expect(mocks.fileViewerProps.at(-1)).toEqual({
      epicId: EPIC_ID,
      hostId: "host-1",
      name: "photo.png",
      sha256: SHA,
    });
  });

  it("gives a file artifact whose bytes changed a fresh viewer instead of repainting the old file", () => {
    const refreshed = "b".repeat(64);
    const file = (sha256: string) =>
      artifact({
        id: "photo",
        kind: "file",
        folderName: "photo.png",
        object: {
          sha256,
          byteLength: 3,
          mediaType: "image/png",
          status: "published",
        },
      });
    setArtifacts([file(SHA)]);
    const view = render(tile("photo"));

    setArtifacts([file(refreshed)]);
    view.rerender(tile("photo"));

    expect(mocks.fileViewerMounts).toEqual([SHA, refreshed]);
  });

  it("keeps the same viewer instance when only the object's status moves from queued to published", () => {
    const file = (status: "queued" | "published") =>
      artifact({
        id: "photo",
        kind: "file",
        folderName: "photo.png",
        object: { sha256: SHA, byteLength: 3, mediaType: "image/png", status },
      });
    setArtifacts([file("queued")]);
    const view = render(tile("photo"));

    setArtifacts([file("published")]);
    view.rerender(tile("photo"));

    expect(mocks.fileViewerMounts).toEqual([SHA]);
  });
});
