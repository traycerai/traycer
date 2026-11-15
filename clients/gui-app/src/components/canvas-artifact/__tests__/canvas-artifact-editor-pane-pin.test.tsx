import { useContext, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAnchoredDraftStore } from "@/stores/comments/anchored-draft-store";
import {
  composerEditorAt,
  typeIntoEditor,
} from "@/components/comments/__tests__/comment-submit-test-support";
import { CanvasArtifactEditor } from "../canvas-artifact-editor";
import { CanvasSelectionProvider } from "../canvas-selection-provider";
import { CanvasFrameEventsContext } from "../canvas-surface-context";
import { ARTIFACT_ID, storeFromFixture } from "./canvas-fixtures";

// The real React Flow runs: the pane press is the thing under test. Only what
// jsdom lacks is stood in for, and the sandboxed board frames render as plain
// elements.

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => true,
}));
vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => [],
}));
vi.mock("@/providers/use-open-epic-handle", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/providers/use-open-epic-handle")
  >()),
  useOpenEpicHandle: () => ({ store: createStore(() => ({ chats: {} })) }),
}));
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-selection", () => ({
  useSidebarChatOrder: () => [],
}));
vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => false,
}));
vi.mock("@/components/comments/anchored-draft-send-to-chat", () => ({
  AnchoredDraftSendToChatSlot: () => null,
}));

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const DISCARD_QUESTION =
  "Discard this comment draft? Unsaved text will be lost.";

function EditorInProvider() {
  const events = useContext(CanvasFrameEventsContext);
  // The editor renders the provider's draft box itself.
  return (
    <CanvasArtifactEditor
      artifactId={ARTIFACT_ID}
      store={storeFromFixture({
        pages: [{ id: "page-1", name: "Flow" }],
        boards: {},
        notes: {},
        order: [],
      })}
      awareness={null}
      user={{ name: "Ada", color: "#112233" }}
      sourceForBoard={() => null}
      boardFiles={null}
      frameEvents={events}
      liveSlotBudget={0}
      boardByteLengths={null}
    />
  );
}

function tree(): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <SurfacePresentationBoundary visible focused>
          <CanvasSelectionProvider
            epicId="epic-1"
            artifactId={ARTIFACT_ID}
            artifactTitle="Canvas"
            artifactType="canvas"
            hostId="host-1"
            viewTabId="tab-1"
          >
            <EditorInProvider />
          </CanvasSelectionProvider>
        </SurfacePresentationBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  recordNegotiatedHostManifest("host-1", {
    "epic.createCommentThread": { major: 1, minor: 3 },
  });
});

afterEach(() => {
  cleanup();
  useAnchoredDraftStore.setState({ byEpicId: {} });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pane(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".react-flow__pane");
  if (found === null) throw new Error("no canvas pane");
  return found;
}

function openDirtyPin(): string {
  render(tree());
  fireEvent.click(screen.getByRole("button", { name: /Comment/ }));
  fireEvent.click(pane());
  typeIntoEditor(composerEditorAt(0), "pinned words");
  const draftId = useAnchoredDraftStore.getState().byEpicId["epic-1"]?.draftId;
  if (draftId === undefined) throw new Error("the pane click opened no pin");
  return draftId;
}

describe("a press on the canvas pane while comments are on and a draft holds text", () => {
  it("asks nothing at the press and once at the click that pins", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const first = openDirtyPin();

    fireEvent.pointerDown(pane(), { button: 0 });
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(pane());

    expect(confirm).toHaveBeenCalledExactlyOnceWith(DISCARD_QUESTION);
    expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]?.draftId).toBe(
      first,
    );
    expect(composerEditorAt(0).getText()).toBe("pinned words");
  });

  it("leaves the draft and its text open when the press is a drag that pins nothing", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const first = openDirtyPin();

    fireEvent.pointerDown(pane(), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(pane(), { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(pane(), { clientX: 300, clientY: 200 });

    expect(confirm).not.toHaveBeenCalled();
    expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]?.draftId).toBe(
      first,
    );
    expect(composerEditorAt(0).getText()).toBe("pinned words");
  });
});
