import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HtmlArtifactCommentSurface } from "../html-artifact-comment-surface";

// The surface, the selection provider behind it, the pages frame and the
// Comments toggle run for real. The sandboxed iframe is a stand-in that
// records the source it was asked to serve.

const frames = vi.hoisted(() => ({ latest: null as SandboxFrameProps | null }));
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frames.latest = props;
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
  AnchoredDraftPopover: () => null,
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

function mount(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <HtmlArtifactCommentSurface
          epicId="epic-1"
          artifactId="html-1"
          artifactTitle="Site"
          hostId="host-1"
          viewTabId="tab-1"
          source={SOURCE}
          toolbarControls={null}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
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
  commentsFlag.enabled = true;
});

afterEach(cleanup);

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
});
