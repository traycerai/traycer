import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxFrameProps,
  SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type { ArtifactManifest } from "@/lib/sandbox/artifact-serving/artifact-manifest";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { AnchoredDraftTidInsertion } from "@/components/comments/anchored-draft-popover";
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
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => commentsFlag.enabled,
}));
vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => [],
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

function tree(source: SandboxSource & { kind: "artifact" }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <HtmlArtifactCommentSurface
          epicId="epic-1"
          artifactId="html-1"
          artifactTitle="Site"
          hostId="host-1"
          viewTabId="tab-1"
          source={source}
          toolbarControls={null}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
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

beforeEach(() => {
  frames.latest = null;
  frames.bridge = null;
  frames.onTidInserted = null;
  commentsFlag.enabled = true;
});

afterEach(() => {
  cleanup();
  disposeBridges();
  vi.restoreAllMocks();
});

describe("<HtmlArtifactCommentSurface />", () => {
  it("serves the plain page, with zoom and no overlay, until Comments is turned on", () => {
    mount();

    expect(servedSource().canvas).toBeUndefined();
    expect(zoomIn()).not.toBeNull();
    expect(overlay()).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Comments" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("serves the element bridge with native links, hides zoom and mounts the overlay while Comments is on", () => {
    mount();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });

    expect(servedSource()).toMatchObject({
      canvas: true,
      canvasLinks: "native",
    });
    expect(zoomIn()).toBeNull();
    expect(overlay()).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });
    expect(servedSource().canvas).toBeUndefined();
    expect(overlay()).toBeNull();
  });

  it("offers no Comments toggle when frame comments are off", () => {
    commentsFlag.enabled = false;
    mount();
    expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
  });

  it("drops comment mode with the toggle when frame comments become unavailable", () => {
    const view = mount();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    });
    expect(overlay()).not.toBeNull();

    commentsFlag.enabled = false;
    view.rerender(tree(SOURCE));

    expect(overlay()).toBeNull();
    expect(servedSource().canvas).toBeUndefined();
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
});
