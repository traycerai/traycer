/**
 * A pin keeps the number the toolbar list gives its thread, and a resolved
 * thread picked from that list gets its pin and popover back for as long as it
 * is the active one. The page's geometry is the only faked seam: jsdom has no
 * layout, so the frame, the pin layer and the bridge's box answers are given
 * fixed sizes.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { FrameCommentPins } from "@/components/comments/frame-comment-pins";
import { FrameCommentsToolbar } from "@/components/comments/frame-comments";
import { FrameCommentSurfaceProvider } from "@/components/comments/frame-comment-surface";
import type { OrderedFrameThread } from "@/components/comments/use-ordered-frame-threads";
import { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "html-1";
const SOURCE = `<p data-tid="open-tid">one</p><p data-tid="resolved-tid">two</p>`;

vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => [openThread, resolvedThread],
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock(
  "@/components/comments/comment-thread-card",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/comments/comment-thread-card")
    >()),
    CommentThreadCard: (props: { readonly thread: CommentThreadWire }) => (
      <div data-testid="thread-card">{props.thread.threadId}</div>
    ),
  }),
);

function elementThread(
  threadId: string,
  elementId: string,
  resolved: boolean,
): CommentThreadWire {
  return {
    threadId,
    resolved,
    createdAt: 1,
    comments: [],
    data: { createdByUserId: "user-1", anchorKind: "element", elementId },
  };
}

const openThread = elementThread("open", "open-tid", false);
const resolvedThread = elementThread("resolved", "resolved-tid", true);
// The list numbers every thread, resolved or not, so the resolved one is #2.
const ordered: readonly OrderedFrameThread[] = [
  { thread: openThread, number: 1, hasAnchor: true },
  { thread: resolvedThread, number: 2, hasAnchor: true },
];

function createBridge(box: CanvasBox | null): SandboxBridgeHost {
  const bridge = new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: true,
      nonce: "n",
      forwardedShortcuts: [],
    },
    hostContext: {
      theme: "light",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      platform: "desktop",
    },
    hostVersion: "9.9.9",
    post: () => undefined,
    events: {
      onStatus: () => undefined,
      onSize: () => undefined,
      onOpenLink: () => Promise.resolve(true),
      onShortcut: () => undefined,
      onRequestTeardown: () => undefined,
      onScrollGesture: () => undefined,
      onWheel: () => undefined,
    },
    appRequests: null,
  });
  vi.spyOn(bridge, "elementBox").mockResolvedValue(box);
  return bridge;
}

const ON_SCREEN_BOX: CanvasBox = { x: 100, y: 50, width: 40, height: 20 };

function pins(onActivate: (threadId: string) => void, box: CanvasBox | null) {
  return (
    <FrameCommentPins
      epicId={EPIC_ID}
      artifactId={ARTIFACT_ID}
      artifactType="html"
      ordered={ordered}
      threads={[openThread, resolvedThread]}
      source={SOURCE}
      bridge={createBridge(box)}
      frame={document.createElement("iframe")}
      onActivate={onActivate}
    />
  );
}

function renderPins(onActivate: (threadId: string) => void): void {
  render(
    <FrameCommentSurfaceProvider>
      {pins(onActivate, ON_SCREEN_BOX)}
    </FrameCommentSurfaceProvider>,
  );
}

beforeEach(() => {
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
  // Without layout every box is zero-sized and no pin is placed.
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<FrameCommentPins />", () => {
  it("pins only open threads until a resolved one is picked, then keeps its list number", async () => {
    renderPins(() => undefined);

    expect(
      await screen.findByRole("button", { name: "Open comment 1" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open comment 2" })).toBeNull();

    act(() => {
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "resolved");
    });

    expect(
      await screen.findByRole("button", { name: "Open comment 2" }),
    ).toBeTruthy();
    expect((await screen.findByTestId("thread-card")).textContent).toBe(
      "resolved",
    );

    act(() => {
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, null);
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Open comment 2" }),
      ).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Open comment 1" })).toBeTruthy();
  });

  it("reports the clicked pin's thread", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderPins(onActivate);

    await user.click(
      await screen.findByRole("button", { name: "Open comment 1" }),
    );

    expect(onActivate).toHaveBeenCalledWith("open");
  });

  describe("beside the toolbar", () => {
    const toolbar = (
      <FrameCommentsToolbar
        epicId={EPIC_ID}
        artifactId={ARTIFACT_ID}
        artifactType="html"
        viewTabId="tab-1"
      />
    );

    // The element exists in the source, but the page's box for it cannot become
    // a pin (nothing measured, no area, or outside the frame), so no pin is
    // mounted for it and the thread must not vanish.
    it.each<[string, CanvasBox | null]>([
      ["no box at all", null],
      ["a zero-size box", { x: 100, y: 50, width: 0, height: 0 }],
      [
        "a box past the right edge of the frame",
        { x: 5000, y: 50, width: 40, height: 20 },
      ],
      ["a box above the frame", { x: 100, y: -500, width: 40, height: 20 }],
    ])(
      "falls back to the toolbar for a source-valid thread with %s",
      async (_label, box) => {
        render(
          <FrameCommentSurfaceProvider>
            {toolbar}
            {pins(() => undefined, box)}
          </FrameCommentSurfaceProvider>,
        );

        act(() => {
          useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "open");
        });

        expect(
          await screen.findByRole("dialog", { name: "Comment thread" }),
        ).toBeTruthy();
        expect(screen.getAllByTestId("thread-card")).toHaveLength(1);
        expect(
          screen.queryByRole("button", { name: "Open comment 1" }),
        ).toBeNull();
      },
    );

    it("shows a placed thread once, in its pin popover, and returns it to the toolbar when the pin goes", async () => {
      const view = (box: CanvasBox | null) => (
        <FrameCommentSurfaceProvider>
          {toolbar}
          {pins(() => undefined, box)}
        </FrameCommentSurfaceProvider>
      );
      const { rerender } = render(view(ON_SCREEN_BOX));
      await screen.findByRole("button", { name: "Open comment 1" });
      act(() => {
        useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "open");
      });

      expect(
        await screen.findByRole("dialog", { name: "Comment 1" }),
      ).toBeTruthy();
      expect(screen.getAllByTestId("thread-card")).toHaveLength(1);
      expect(
        screen.queryByRole("dialog", { name: "Comment thread" }),
      ).toBeNull();

      // The page now reports the element as gone; the next measurement drops the pin.
      rerender(view(null));
      expect(
        await screen.findByRole("dialog", { name: "Comment thread" }),
      ).toBeTruthy();
      expect(screen.getAllByTestId("thread-card")).toHaveLength(1);
    });
  });
});
