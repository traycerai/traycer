import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import * as Y from "yjs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type { CanvasFrameEvents } from "../canvas-frame";
import { CanvasSelectionOverlay } from "../canvas-selection-overlay";
import { CanvasFrameEventsContext } from "../canvas-surface-context";
import { CanvasLayoutStore } from "../canvas-layout-store";
import { CanvasSelectionProvider } from "../canvas-selection-provider";
import { useCanvasSelectionStore } from "../canvas-selection-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

// The clipboard boundary, panels and annotation action are other tests' subjects,
// and the real ones need a query client and the host's edit transport. The
// editing overlay is stood in for by the real selection overlay it wraps, which
// is what owns the focused shield, the Escape it receives, and the report that
// the board is retired when it leaves the tree.
vi.mock("../canvas-editing-overlay", () => ({
  CanvasEditingOverlay: (
    props: ComponentProps<typeof CanvasSelectionOverlay>,
  ) => (
    <CanvasSelectionOverlay
      scope={props.scope}
      boardPath={props.boardPath}
      registry={props.registry}
      onPick={props.onPick}
      onRetire={props.onRetire}
      onEscape={props.onEscape}
    />
  ),
}));
vi.mock("../canvas-clipboard-controls", () => ({
  CanvasClipboardBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
}));
vi.mock("../canvas-editing-panel", () => ({
  CanvasEditingPanel: (props: {
    readonly boardPath: string;
    readonly children: ReactNode;
  }) => (
    <div data-testid="editing-panel" data-board-path={props.boardPath}>
      {props.children}
    </div>
  ),
  CanvasElementEditingPanel: () => <div data-testid="element-panel" />,
}));
vi.mock("../canvas-annotation-action", () => ({
  CanvasAnnotationAction: () => null,
  CanvasSelectionAction: () => null,
}));
vi.mock("../canvas-properties-panel", () => ({
  CanvasPropertiesPanel: () => null,
}));
vi.mock("../canvas-board-panel", () => ({
  CanvasBoardPanel: () => <div data-testid="board-panel" />,
}));
// Comments are a separate surface; these tests exercise ownership of frame picks.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => false,
}));
vi.mock("../canvas-comments", () => ({
  CanvasCommentIndex: () => null,
  CanvasCommentPins: () => null,
  CanvasWholeCommentPin: () => null,
}));
vi.mock("@/components/comments/anchored-draft-popover", () => ({
  AnchoredDraftPopover: () => null,
}));

const BOARD = "boards/home.html";
const SHA = "sha-1";

function scope(artifactId: string) {
  return {
    epicId: "epic-1",
    artifactId,
    artifactTitle: artifactId,
    hostId: "host-1",
    viewTabId: "tab-1",
  };
}

function element(selector: string): CanvasElement {
  return {
    marker: 1,
    tid: null,
    tagName: "div",
    selector,
    elementId: null,
    classNames: [],
    textPreview: "",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 0, y: 0, width: 10, height: 10 },
    computedStyles: [],
    generated: false,
  };
}

/** A real bridge; only the page's answer to a hit test is held open by the test. */
function bridge(): SandboxBridgeHost {
  return new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: true,
      nonce: "n",
      forwardedShortcuts: [],
      pages: null,
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
}

/** The page's answer for the document itself, which is the board and not an element. */
function rootElement(tagName: "html" | "body"): CanvasElement {
  return { ...element(tagName), tagName };
}

interface Deferred {
  readonly resolve: (value: CanvasElement | null) => void;
}

/** A provider mounted over a board whose hit test answers only when told to. */
interface MountedProvider {
  readonly events: () => CanvasFrameEvents;
  readonly pick: () => Deferred;
  readonly setOverlayShown: (shown: boolean) => void;
  /** The shield that takes pointer and key input over the board. */
  readonly shield: () => HTMLElement;
  /** Keys that reached the node wrapping the board, as XYFlow's node wrapper would see them. */
  readonly nodeKeyDowns: Mock<(event: unknown) => void>;
  /** Every path the provider told its parent frame events had been selected as the board. */
  readonly boardSelects: readonly (string | null)[];
}

function mountProvider(artifactId: string): MountedProvider {
  let captured: CanvasFrameEvents | null = null;
  let showOverlay: (shown: boolean) => void = () => undefined;
  const host = bridge();
  const pending: Deferred[] = [];
  const boardSelects: (string | null)[] = [];
  const layoutStore = new CanvasLayoutStore(new Y.Doc(), artifactId);
  const nodeKeyDowns = vi.fn<(event: unknown) => void>();
  // The overlay keeps the selection alive by asking the page where it is.
  vi.spyOn(host, "elementBox").mockResolvedValue(element("").box);
  vi.spyOn(host, "hitTest").mockImplementation(
    () =>
      new Promise<CanvasElement | null>((resolve) => {
        pending.push({ resolve });
      }),
  );

  function Probe(): ReactNode {
    const events = useContext(CanvasFrameEventsContext);
    captured = events;
    const [shown, setShown] = useState(true);
    showOverlay = setShown;
    return (
      <>
        <div role="presentation" onKeyDown={nodeKeyDowns}>
          {shown ? (events?.renderOverlay?.(BOARD, true) ?? null) : null}
        </div>
        {events?.renderPanel?.(layoutStore, { onClose: () => undefined })}
      </>
    );
  }

  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <CanvasFrameEventsContext
        value={{
          onBridge: () => undefined,
          onStatus: () => undefined,
          onEditPointer: () => undefined,
          onBoardSelect: (path) => {
            boardSelects.push(path);
          },
        }}
      >
        <CanvasSelectionProvider {...scope(artifactId)}>
          <Probe />
        </CanvasSelectionProvider>
      </CanvasFrameEventsContext>
    </QueryClientProvider>,
  );
  const events = (): CanvasFrameEvents => {
    if (captured === null) throw new Error("provider events not captured");
    return captured;
  };
  act(() => {
    events().onBridge(BOARD, host);
    events().onServedSource?.(BOARD, SHA);
  });
  return {
    events,
    pick: () => {
      const before = pending.length;
      act(() => {
        events().onEditPointer(BOARD, { x: 5, y: 5 });
      });
      const next = pending.at(before);
      if (next === undefined) throw new Error("the pick never asked the page");
      return next;
    },
    setOverlayShown: (shown) => act(() => showOverlay(shown)),
    shield: () => {
      const found = view.container.querySelector(
        "[data-canvas-selection-overlay] > div",
      );
      if (!(found instanceof HTMLElement)) throw new Error("no shield");
      return found;
    },
    nodeKeyDowns,
    boardSelects,
  };
}

async function answer(request: Deferred, value: CanvasElement | null) {
  await act(async () => {
    request.resolve(value);
    await Promise.resolve();
  });
}

function selectedSelector(): string | null {
  return useCanvasSelectionStore.getState().selection?.element.selector ?? null;
}

function resetCommentThreads(): void {
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
}

beforeEach(() => {
  useCanvasSelectionStore.getState().clear();
  resetCommentThreads();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCanvasSelectionStore.getState().clear();
  resetCommentThreads();
});

describe("CanvasSelectionProvider picks", () => {
  it("selects the element the page answers with", async () => {
    const provider = mountProvider("artifact-a");

    await answer(provider.pick(), element("div.a"));

    expect(selectedSelector()).toBe("div.a");
  });

  it("ignores a page's late answer once the board's overlay has left (switching to Hand or Play)", async () => {
    const provider = mountProvider("artifact-a");
    const request = provider.pick();

    provider.setOverlayShown(false);
    await answer(request, element("div.late"));

    expect(selectedSelector()).toBeNull();
  });

  it("drops the selection the overlay owned when it leaves", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));
    expect(selectedSelector()).toBe("div.a");

    provider.setOverlayShown(false);

    expect(selectedSelector()).toBeNull();
  });

  it("lets only the newest pick win when two providers compete, whichever answers last", async () => {
    const older = mountProvider("artifact-a");
    const newer = mountProvider("artifact-b");
    const olderRequest = older.pick();
    const newerRequest = newer.pick();

    await answer(newerRequest, element("div.newer"));
    await answer(olderRequest, element("div.older"));

    expect(selectedSelector()).toBe("div.newer");
    expect(useCanvasSelectionStore.getState().selection?.artifactId).toBe(
      "artifact-b",
    );
  });

  it("does not let an older provider's answer land before the newer one's either", async () => {
    const older = mountProvider("artifact-a");
    const newer = mountProvider("artifact-b");
    const olderRequest = older.pick();
    const newerRequest = newer.pick();

    await answer(olderRequest, element("div.older"));
    expect(selectedSelector()).toBeNull();
    await answer(newerRequest, element("div.newer"));

    expect(selectedSelector()).toBe("div.newer");
  });
});

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

const boardPanel = (): HTMLElement | null =>
  screen.queryByTestId("board-panel");
const elementPanel = (): HTMLElement | null =>
  screen.queryByTestId("element-panel");

describe("CanvasSelectionProvider board picks", () => {
  it.each(["html", "body"] as const)(
    "treats a click that lands on <%s> as picking the board, not an element",
    async (tagName) => {
      const provider = mountProvider("artifact-a");

      await answer(provider.pick(), rootElement(tagName));

      expect(selectedSelector()).toBeNull();
      expect(elementPanel()).toBeNull();
      expect(boardPanel()).not.toBeNull();
    },
  );

  it("drops the element that was selected when the next click lands on the page background", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));
    expect(elementPanel()).not.toBeNull();

    await answer(provider.pick(), rootElement("body"));

    expect(selectedSelector()).toBeNull();
    expect(elementPanel()).toBeNull();
    expect(boardPanel()).not.toBeNull();
  });

  it("still selects an ordinary element after a board pick", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), rootElement("html"));

    await answer(provider.pick(), element("div.a"));

    expect(selectedSelector()).toBe("div.a");
  });
});

describe("CanvasSelectionProvider board selection", () => {
  it("cancels a pick still waiting on the page, even with nothing selected yet", async () => {
    const provider = mountProvider("artifact-a");
    const request = provider.pick();
    expect(selectedSelector()).toBeNull();

    act(() => provider.events().onBoardSelect?.(null));
    await answer(request, element("div.late"));

    expect(selectedSelector()).toBeNull();
    expect(provider.boardSelects).toEqual([null]);
  });

  it("clears the element that was selected", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));

    act(() => provider.events().onBoardSelect?.(null));

    expect(selectedSelector()).toBeNull();
    expect(elementPanel()).toBeNull();
  });

  it("clears an element selected on a different board", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));

    act(() => provider.events().onBoardSelect?.("boards/other.html"));

    expect(selectedSelector()).toBeNull();
  });
});

/**
 * A minimal `onCanvasView` report with comment mode wired to the given spy,
 * matching the shape the toolbar/editor's real view supplies.
 */
function reportCommentingView(
  provider: MountedProvider,
  commenting: boolean,
  setCommenting: Mock<(enabled: boolean) => void>,
): void {
  act(() =>
    provider.events().onCanvasView?.({
      tool: "select",
      play: false,
      commenting,
      setCommenting,
      viewOnly: false,
      order: [],
      sourceForBoard: () => null,
      revealBoard: () => true,
      setTool: () => undefined,
      clearNodeSelection: () => undefined,
    }),
  );
}

describe("CanvasSelectionProvider comment mode", () => {
  const EPIC_ID = "epic-1";

  it("clears the active comment thread on a pick while commenting, without touching the mode itself", async () => {
    const provider = mountProvider("artifact-a");
    const setCommenting = vi.fn<(enabled: boolean) => void>();
    reportCommentingView(provider, true, setCommenting);
    act(() =>
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "thread-1"),
    );

    await answer(provider.pick(), element("div.a"));

    expect(
      useCommentThreadsStore.getState().activeByEpicId[EPIC_ID],
    ).toBeNull();
    expect(setCommenting).not.toHaveBeenCalled();
  });

  it("leaves an active comment thread alone when a pick happens outside comment mode", async () => {
    const provider = mountProvider("artifact-a");
    const setCommenting = vi.fn<(enabled: boolean) => void>();
    reportCommentingView(provider, false, setCommenting);
    act(() =>
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "thread-1"),
    );

    await answer(provider.pick(), element("div.a"));

    expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
      "thread-1",
    );
  });

  it("turns comment mode off on Escape, alongside the selection - composer lifecycle, not the editor's own state", () => {
    const provider = mountProvider("artifact-a");
    const setCommenting = vi.fn<(enabled: boolean) => void>();
    reportCommentingView(provider, true, setCommenting);

    pressEscape();

    expect(setCommenting).toHaveBeenCalledWith(false);
  });
});

describe("CanvasSelectionProvider Escape", () => {
  it("clears the element first and the board only on the next press", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));

    pressEscape();
    expect(selectedSelector()).toBeNull();
    expect(boardPanel()).not.toBeNull();

    pressEscape();
    expect(boardPanel()).toBeNull();
    expect(provider.boardSelects).toEqual([null]);
  });

  it("deselects the canvas's own node only on the press that clears the board", async () => {
    const provider = mountProvider("artifact-a");
    const clearNodeSelection = vi.fn();
    act(() =>
      provider.events().onCanvasView?.({
        tool: "select",
        play: false,
        commenting: false,
        setCommenting: () => undefined,
        viewOnly: false,
        order: [],
        sourceForBoard: () => null,
        revealBoard: () => true,
        setTool: () => undefined,
        clearNodeSelection,
      }),
    );
    await answer(provider.pick(), element("div.a"));

    pressEscape();
    expect(clearNodeSelection).not.toHaveBeenCalled();

    pressEscape();
    expect(clearNodeSelection).toHaveBeenCalledOnce();
  });

  it("handles an Escape pressed on the focused shield once, without the node under it ever seeing it", async () => {
    const provider = mountProvider("artifact-a");
    const clearNodeSelection = vi.fn();
    act(() =>
      provider.events().onCanvasView?.({
        tool: "select",
        play: false,
        commenting: false,
        setCommenting: () => undefined,
        viewOnly: false,
        order: [],
        sourceForBoard: () => null,
        revealBoard: () => true,
        setTool: () => undefined,
        clearNodeSelection,
      }),
    );
    await answer(provider.pick(), element("div.a"));
    const shield = provider.shield();
    act(() => shield.focus());
    expect(document.activeElement).toBe(shield);

    fireEvent.keyDown(shield, { key: "Escape", code: "Escape" });
    expect(selectedSelector()).toBeNull();
    expect(boardPanel()).not.toBeNull();
    expect(clearNodeSelection).not.toHaveBeenCalled();

    fireEvent.keyDown(shield, { key: "Escape", code: "Escape" });
    expect(boardPanel()).toBeNull();
    expect(clearNodeSelection).toHaveBeenCalledOnce();
    expect(provider.boardSelects).toEqual([null]);
    expect(provider.nodeKeyDowns).not.toHaveBeenCalled();
  });

  it("cancels a pick still waiting on the page", async () => {
    const provider = mountProvider("artifact-a");
    const request = provider.pick();

    pressEscape();
    await answer(request, element("div.late"));

    expect(selectedSelector()).toBeNull();
  });
});

describe("CanvasSelectionProvider double click", () => {
  it.each(["html", "body"] as const)(
    "ignores a double click on <%s>, which is the board and has no text to retype",
    (tagName) => {
      const provider = mountProvider("artifact-a");

      act(() => provider.events().onDoubleClick?.(BOARD, rootElement(tagName)));

      expect(selectedSelector()).toBeNull();
      expect(elementPanel()).toBeNull();
    },
  );

  it("adopts the double-clicked block as the selection", () => {
    const provider = mountProvider("artifact-a");
    expect(selectedSelector()).toBeNull();

    act(() => provider.events().onDoubleClick?.(BOARD, element("p.block")));

    expect(selectedSelector()).toBe("p.block");
    expect(elementPanel()).not.toBeNull();
  });

  it("replaces a different selected element with the double-clicked block", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));

    act(() => provider.events().onDoubleClick?.(BOARD, element("p.block")));

    expect(selectedSelector()).toBe("p.block");
  });
});

describe("CanvasSelectionProvider inspector board", () => {
  it("follows the picked board, not the board a leftover element selection belongs to", async () => {
    const provider = mountProvider("artifact-a");
    await answer(provider.pick(), element("div.a"));
    expect(
      screen.getByTestId("editing-panel").getAttribute("data-board-path"),
    ).toBe(BOARD);

    act(() => provider.events().onBoardSelect?.("boards/other.html"));
    // A selection that outlived the board change, still naming the first board.
    act(() => {
      useCanvasSelectionStore.getState().select({
        artifactId: "artifact-a",
        boardPath: BOARD,
        page: null,
        servedSha256: SHA,
        element: element("div.a"),
        textRange: null,
      });
    });

    expect(
      screen.getByTestId("editing-panel").getAttribute("data-board-path"),
    ).toBe("boards/other.html");
    expect(boardPanel()).not.toBeNull();
    expect(elementPanel()).toBeNull();
  });
});
