import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type Query,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  SandboxFrameProps,
  SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving/artifact-manifest";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { AnchoredDraftTidInsertion } from "@/components/comments/anchored-draft-popover";
import {
  clearCommentEditorRegistryForTests,
  requestCommentThreadAnchorReveal,
} from "@/lib/comments/comment-editor-registry";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import {
  disposeBridges,
  realBridge,
} from "@/components/canvas-artifact/__tests__/canvas-edit-test-support";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HtmlArtifactCommentSurface } from "../html-artifact-comment-surface";

// The surface, the selection provider behind it, the pages frame and the
// Comments toggle run for real. The sandboxed iframe is a stand-in that
// records the source it was asked to serve.

const frames = vi.hoisted(() => ({
  latest: null as SandboxFrameProps | null,
  bridge: null as SandboxBridgeHost | null,
  onTidInserted: null as
    | ((insertion: AnchoredDraftTidInsertion) => Promise<void>)
    | null,
}));
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frames.latest = props;
    const { onBridge } = props;
    // The page's bridge arrives once the document has mounted.
    useEffect(() => {
      onBridge?.(frames.bridge);
    }, [onBridge]);
    return <div data-testid="frame" />;
  },
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
const commentsFlag = vi.hoisted(() => ({ enabled: true }));
const commentThreads = vi.hoisted(() => ({
  current: new Array<CommentThreadWire>(),
}));
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => commentsFlag.enabled,
}));
vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => commentThreads.current,
}));
vi.mock("@/components/comments/anchored-draft-popover", () => ({
  // The real box reports a first comment's stamped id through this prop; the
  // test calls it the way the box does.
  AnchoredDraftPopover: (props: {
    readonly onTidInserted?: (
      insertion: AnchoredDraftTidInsertion,
    ) => Promise<void>;
  }) => {
    frames.onTidInserted = props.onTidInserted ?? null;
    return null;
  },
}));

const SOURCE = {
  kind: "artifact" as const,
  artifactId: "html-1",
  treePath: "site",
  entryPath: "index.html",
  manifest: {
    files: {
      "index.html": {
        sha256: "a".repeat(64),
        byteLength: 10,
        mediaType: "text/html",
      },
    },
  },
  readSpan: () => Promise.reject(new Error("unused")),
  resolveOutsideReference: () => null,
};

function treeOn(
  client: QueryClient,
  source: SandboxSource & { kind: "artifact" },
) {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HtmlArtifactCommentSurface
          epicId="epic-1"
          artifactId="html-1"
          artifactTitle="Site"
          hostId="host-1"
          viewTabId="tab-1"
          source={source}
          toolbarControls={null}
          menuItems={null}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function tree(source: SandboxSource & { kind: "artifact" }) {
  return treeOn(new QueryClient(), source);
}

function mount() {
  return render(tree(SOURCE));
}

function servedSource(): Extract<
  SandboxFrameProps["source"],
  { kind: "artifact" }
> {
  const source = frames.latest?.source;
  if (source?.kind !== "artifact") throw new Error("no artifact frame");
  return source;
}

const overlay = (): Element | null =>
  document.querySelector("[data-canvas-selection-overlay]");
const zoomIn = (): HTMLElement | null =>
  screen.queryByRole("button", { name: /zoom in/i });

/** The page the frame is showing, proven, so telling it its mode is observable. */
function provenBridge() {
  const bridge = realBridge();
  frames.bridge = bridge;
  const setHtmlView = vi.spyOn(bridge, "setHtmlView");
  const setMode = vi.spyOn(bridge, "setMode");
  return { setHtmlView, setMode };
}

/** The page on show proves itself: it names its page, then says ready. */
function prove(path: string): void {
  const frame = frames.latest;
  if (frame === null) throw new Error("no frame");
  act(() => {
    frame.pageNavigation?.onNavigate(path);
    frame.onStatus("ready");
  });
}

function markReady(): void {
  prove("index.html");
}

function elementThread(threadId: string, artboard: string): CommentThreadWire {
  return {
    threadId,
    resolved: false,
    createdAt: 1,
    comments: [],
    data: {
      createdByUserId: "user-1",
      anchorKind: "element",
      artboard,
      elementId: "p",
      label: "Paragraph",
    },
  };
}

function file(sha256: string, mediaType: string) {
  return { sha256, byteLength: 10, mediaType };
}

beforeEach(() => {
  frames.latest = null;
  frames.bridge = null;
  frames.onTidInserted = null;
  commentsFlag.enabled = true;
  commentThreads.current = [];
});

afterEach(() => {
  cleanup();
  disposeBridges();
  vi.restoreAllMocks();
  commentThreads.current = [];
  useCommentThreadsStore.getState().setActiveThread("epic-1", null);
  clearCommentEditorRegistryForTests();
});

describe("<HtmlArtifactCommentSurface />", () => {
  it("serves one commentable page, keeps its zoom, and tells that page when Comments turns on and off", () => {
    const { setMode, setHtmlView } = provenBridge();
    mount();
    const source = servedSource();

    // Reading and commenting are one document. The tool is a message.
    expect(source).toMatchObject({ canvas: true, canvasLinks: "native" });
    expect(zoomIn()).not.toBeNull();
    expect(overlay()).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Comments" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    markReady();
    expect(setMode).toHaveBeenLastCalledWith("play");
    expect(setHtmlView).toHaveBeenLastCalledWith({
      enabled: true,
      scale: 1,
      commenting: false,
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });

    expect(servedSource()).toBe(source);
    expect(zoomIn()).not.toBeNull();
    expect(overlay()).not.toBeNull();
    expect(setMode).toHaveBeenLastCalledWith("edit");
    expect(setHtmlView).toHaveBeenLastCalledWith({
      enabled: true,
      scale: 1,
      commenting: true,
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });

    expect(servedSource()).toBe(source);
    expect(zoomIn()).not.toBeNull();
    expect(overlay()).toBeNull();
    expect(setMode).toHaveBeenLastCalledWith("play");
    expect(setHtmlView).toHaveBeenLastCalledWith({
      enabled: true,
      scale: 1,
      commenting: false,
    });
  });

  it("offers no Comments toggle when frame comments are off, and still serves that one page", () => {
    commentsFlag.enabled = false;
    mount();

    expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
    expect(servedSource()).toMatchObject({
      canvas: true,
      canvasLinks: "native",
    });
    expect(zoomIn()).not.toBeNull();
    expect(overlay()).toBeNull();
  });

  it("drops comment mode with the toggle when frame comments become unavailable, without swapping the page", () => {
    const { setMode, setHtmlView } = provenBridge();
    const view = mount();
    markReady();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });
    const source = servedSource();
    expect(overlay()).not.toBeNull();

    commentsFlag.enabled = false;
    view.rerender(tree(SOURCE));

    expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
    expect(overlay()).toBeNull();
    expect(servedSource()).toBe(source);
    expect(zoomIn()).not.toBeNull();
    expect(setMode).toHaveBeenLastCalledWith("play");
    expect(setHtmlView).toHaveBeenLastCalledWith({
      enabled: true,
      scale: 1,
      commenting: false,
    });
  });
});

describe("<HtmlArtifactCommentSurface /> keeping the page through a first comment", () => {
  const BEFORE = "a".repeat(64);
  const AFTER = "b".repeat(64);
  const withStyles = {
    ...SOURCE,
    manifest: {
      files: {
        ...SOURCE.manifest.files,
        "style.css": {
          sha256: "c".repeat(64),
          byteLength: 5,
          mediaType: "text/css",
        },
      },
    },
  };

  /** The served source with the given files' hashes replaced. */
  function revised(shas: Readonly<Record<string, string>>) {
    const files = Object.fromEntries(
      Object.entries(withStyles.manifest.files).map(([path, file]) => [
        path,
        { ...file, sha256: shas[path] ?? file.sha256 },
      ]),
    );
    return { ...withStyles, manifest: { files } };
  }

  async function commentOnFirstElement(): Promise<void> {
    frames.bridge = realBridge();
    vi.spyOn(frames.bridge, "stampTid").mockResolvedValue(true);
    vi.spyOn(frames.bridge, "shiftMarkers").mockResolvedValue(true);
    render(tree(withStyles));
    // Until a page has proved itself, every file counts as another file, so
    // the entry page's own stamp would reload it.
    markReady();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });
    await act(async () => {
      await frames.onTidInserted?.({
        boardPath: "index.html",
        marker: 1,
        tagName: "p",
        tid: "t1",
        sha256Before: BEFORE,
        sha256After: AFTER,
        splices: [{ start: 3, end: 3, replacement: ' data-tid="t1"' }],
      });
    });
  }

  function equivalent(next: { readonly manifest: ArtifactManifest }): boolean {
    const frame = frames.latest;
    if (frame === null || frame.source.kind !== "artifact")
      throw new Error("no artifact frame");
    return (
      frame.sourceEquivalent?.(frame.source, {
        ...frame.source,
        manifest: next.manifest,
      }) === true
    );
  }

  it("keeps the page when only the entry page moved to the revision the document adopted", async () => {
    await commentOnFirstElement();
    expect(equivalent(revised({ "index.html": AFTER }))).toBe(true);
  });

  it("reloads when another file in the folder changed too", async () => {
    await commentOnFirstElement();
    expect(
      equivalent(revised({ "index.html": AFTER, "style.css": "d".repeat(64) })),
    ).toBe(false);
  });

  it("reloads when the entry page changed to a revision nobody adopted", async () => {
    await commentOnFirstElement();
    expect(equivalent(revised({ "index.html": "e".repeat(64) }))).toBe(false);
  });

  it("keeps only the page on show when that page adopted the revision", async () => {
    const reportSha = "b".repeat(64);
    const adopted = "f".repeat(64);
    const source = {
      ...withStyles,
      manifest: {
        files: {
          ...withStyles.manifest.files,
          "report.html": file(reportSha, "text/html"),
        },
      },
    };
    frames.bridge = realBridge();
    vi.spyOn(frames.bridge, "stampTid").mockResolvedValue(true);
    vi.spyOn(frames.bridge, "shiftMarkers").mockResolvedValue(true);
    render(tree(source));

    function moved(shas: Readonly<Record<string, string>>): boolean {
      const frame = frames.latest;
      if (frame === null || frame.source.kind !== "artifact")
        throw new Error("no artifact frame");
      const files = Object.fromEntries(
        Object.entries(source.manifest.files).map(([path, entry]) => [
          path,
          { ...entry, sha256: shas[path] ?? entry.sha256 },
        ]),
      );
      return (
        frame.sourceEquivalent?.(frame.source, {
          ...frame.source,
          manifest: { files },
        }) === true
      );
    }

    // No page is on show yet, so the entry page moving is a reload.
    expect(moved({ "index.html": adopted })).toBe(false);

    prove("report.html");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });
    await act(async () => {
      await frames.onTidInserted?.({
        boardPath: "report.html",
        marker: 1,
        tagName: "p",
        tid: "t1",
        sha256Before: reportSha,
        sha256After: adopted,
        splices: [{ start: 3, end: 3, replacement: ' data-tid="t1"' }],
      });
    });

    expect(moved({ "report.html": adopted })).toBe(true);
    expect(
      moved({ "report.html": adopted, "index.html": "e".repeat(64) }),
    ).toBe(false);
  });
});

describe("<HtmlArtifactCommentSurface /> pages", () => {
  function htmlFile(sha256: string) {
    return file(sha256, "text/html");
  }

  it("reads every html page as its own board, entry first, and skips the rest", () => {
    const client = new QueryClient();
    commentThreads.current = [
      elementThread("thread-middle", "middle.html"),
      elementThread("thread-a", "a.html"),
      elementThread("thread-z", "z.html"),
    ];
    render(
      treeOn(client, {
        ...SOURCE,
        entryPath: "middle.html",
        manifest: {
          files: {
            "z.html": htmlFile("c".repeat(64)),
            "a.html": htmlFile("b".repeat(64)),
            "middle.html": htmlFile("a".repeat(64)),
            "style.css": file("d".repeat(64), "text/css"),
          },
        },
      }),
    );

    const sources = client
      .getQueryCache()
      .findAll({ queryKey: ["canvas.source"] })
      .map((query) => sourceIdentity(query));

    expect(sources.map((source) => source.path)).toEqual([
      "middle.html",
      "a.html",
      "z.html",
    ]);
    expect(sources.map((source) => source.entryPath)).toEqual([
      "middle.html",
      "a.html",
      "z.html",
    ]);
    expect(sources.map((source) => source.sha256)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ]);
  });

  it("opens the page a revealed thread is on, and Back returns to the one showing", () => {
    const { setMode } = provenBridge();
    commentThreads.current = [
      elementThread("thread-report", "report.html"),
      elementThread("thread-css", "notes.css"),
    ];
    render(
      tree({
        ...SOURCE,
        manifest: {
          files: {
            "index.html": file("a".repeat(64), "text/html"),
            "report.html": file("b".repeat(64), "text/html"),
            "notes.css": file("c".repeat(64), "text/css"),
          },
        },
      }),
    );
    markReady();

    act(() => {
      useCommentThreadsStore.getState().setActiveThread("epic-1", "thread-css");
      requestCommentThreadAnchorReveal("epic-1", "html-1", "thread-css");
    });

    expect(frames.latest?.pageNavigation?.path).toBe("index.html");

    act(() => {
      useCommentThreadsStore
        .getState()
        .setActiveThread("epic-1", "thread-report");
      requestCommentThreadAnchorReveal("epic-1", "html-1", "thread-report");
    });

    expect(frames.latest?.pageNavigation?.path).toBe("report.html");
    expect(
      screen
        .getByRole("button", { name: "Comments" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    prove("report.html");
    expect(setMode).toHaveBeenLastCalledWith("edit");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(frames.latest?.pageNavigation?.path).toBe("index.html");
  });

  it("re-reads a missing page when the thread on it is revealed", () => {
    commentThreads.current = [elementThread("thread-report", "report.html")];
    render(
      tree({
        ...SOURCE,
        manifest: {
          files: {
            "index.html": file("a".repeat(64), "text/html"),
            "report.html": file("b".repeat(64), "text/html"),
          },
        },
      }),
    );
    markReady();
    const frame = frames.latest;
    if (frame?.pageNavigation === undefined) throw new Error("no navigation");
    act(() => {
      frame.pageNavigation?.onNavigate("report.html");
      frame.pageNavigation?.onPageMissing();
    });
    expect(screen.getByText("This page is not in the artifact.")).toBeTruthy();
    const visit = frames.latest?.pageNavigation?.visit;
    if (visit === undefined) throw new Error("no visit");

    act(() => {
      useCommentThreadsStore
        .getState()
        .setActiveThread("epic-1", "thread-report");
      requestCommentThreadAnchorReveal("epic-1", "html-1", "thread-report");
    });

    expect(frames.latest?.pageNavigation?.path).toBe("report.html");
    expect(frames.latest?.pageNavigation?.visit).toBe(visit + 1);
    expect(screen.queryByText("This page is not in the artifact.")).toBeNull();
  });
});

/** The board path, the entry the source is read as, and that file's sha. */
function sourceIdentity(query: Query): {
  readonly path: string;
  readonly entryPath: string;
  readonly sha256: string;
} {
  const path = query.queryKey[2];
  const sha256 = query.queryKey[3];
  const identity = query.queryKey[4];
  if (typeof path !== "string" || typeof sha256 !== "string")
    throw new Error("source query is missing its path");
  if (
    identity === null ||
    typeof identity !== "object" ||
    !("entryPath" in identity) ||
    typeof identity.entryPath !== "string"
  )
    throw new Error("source query is missing its entry path");
  return { path, entryPath: identity.entryPath, sha256 };
}
