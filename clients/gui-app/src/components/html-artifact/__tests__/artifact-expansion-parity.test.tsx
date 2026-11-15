import { useContext, useEffect, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type {
  EpicListHtmlArtifactVersionsResponse,
  HtmlArtifactVersion,
  HtmlArtifactVersionSelection,
} from "@traycer/protocol/host/epic/html-artifact-versions";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  disposeBridges,
  pendingSaves,
  realBridge,
  settleSave,
  textSelection,
} from "@/components/canvas-artifact/__tests__/canvas-edit-test-support";
import { FrameCommentsUnavailable } from "@/components/comments/frame-comments";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HtmlArtifactVersionState } from "@/hooks/epic/use-epic-html-artifact-version";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import {
  holdFullscreenBlocker,
  useFullscreenPinnedRowKeys,
} from "@/lib/sandbox/overlay-owner";
import {
  composerEditorAt,
  createDeferred,
  settle,
  typeIntoEditor,
} from "@/components/comments/__tests__/comment-submit-test-support";
import { useAnchoredDraftStore } from "@/stores/comments/anchored-draft-store";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import { CanvasFrameEventsContext } from "@/components/canvas-artifact/canvas-surface-context";
import type { CanvasFrameEvents } from "@/components/canvas-artifact/canvas-frame";
import { openFrameCommentDraft } from "@/lib/comments/open-frame-comment-draft";
import { HtmlArtifactCommentSurface } from "../html-artifact-comment-surface";
import { HtmlArtifactFrame } from "../html-artifact-frame";
import { HtmlArtifactVersionPicker } from "../html-artifact-version-picker";

/**
 * Expanding an html artifact raises the instance the tile rendered. These
 * tests expand the REAL tile wiring - the comment surface with the version
 * picker as its toolbar control and a caller row in its More actions menu,
 * which is what the object tile passes - and look at what the reader can do
 * from the expanded surface. Only the sandboxed iframe is a stand-in.
 */

const frames = vi.hoisted(() => ({
  latest: null as SandboxFrameProps | null,
  bridge: null as SandboxBridgeHost | null,
  mounts: 0,
}));
vi.mock("@/components/sandbox/sandbox-frame", () => ({
  SandboxFrame: (props: SandboxFrameProps) => {
    frames.latest = props;
    const { onBridge } = props;
    useEffect(() => {
      frames.mounts += 1;
    }, []);
    useEffect(() => {
      onBridge?.(frames.bridge);
    }, [onBridge]);
    return <div data-testid="frame" />;
  },
}));
const host = vi.hoisted(() => ({
  client: null as { readonly getActiveHostId: () => string } | null,
  createThread: vi.fn<
    (request: { readonly anchor: unknown }) => Promise<{
      readonly threadId: string;
    }>
  >(),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => host.client,
}));
// The host lies outside the draft: its two writes, the id stamp that precedes
// a first comment on an element and the thread itself, are answered by hand.
vi.mock("@/components/canvas-artifact/use-artboard-edit", async () =>
  (
    await import("@/components/canvas-artifact/__tests__/canvas-edit-test-support")
  ).artboardEditModule(),
);
vi.mock("@/hooks/comments/use-comment-thread-mutations", async (original) => ({
  ...(await original<
    typeof import("@/hooks/comments/use-comment-thread-mutations")
  >()),
  useCreateCommentThreadForClient: () => ({
    isPending: false,
    mutateAsync: host.createThread,
  }),
}));
vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => true,
}));
vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => [],
}));
// The real draft box runs, with its Send to chat slot. What it asks the open
// epic for lies outside it.
vi.mock("@/providers/use-open-epic-handle", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/providers/use-open-epic-handle")
  >()),
  useOpenEpicHandle: () => ({ store: createStore(() => ({ chats: {} })) }),
}));
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-selection", () => ({
  useSidebarChatOrder: () => [],
}));
vi.mock("@/components/comments/anchored-draft-send-to-chat", () => ({
  AnchoredDraftSendToChatSlot: () => null,
}));
vi.mock("@/hooks/ui/use-coarse-pointer", () => ({
  useCoarsePointer: () => false,
}));

function sourceNamed(artifactId: string) {
  return {
    kind: "artifact" as const,
    artifactId,
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
}

function version(versionNumber: number): HtmlArtifactVersion {
  return {
    id: String(versionNumber).repeat(64),
    versionNumber,
    entryPath: "index.html",
    manifest: {
      files: {
        "index.html": {
          sha256: String(versionNumber).repeat(64),
          byteLength: 10,
          mediaType: "text/html",
        },
      },
      capturedAt: Date.UTC(2026, 9, 20 + versionNumber, 12, 0),
    },
  };
}

const V3 = version(3);
const V2 = version(2);
const HISTORY: EpicListHtmlArtifactVersionsResponse = {
  versions: [V3, V2],
  nextCursor: null,
  currentVersionNumber: 3,
};
const historyOptions = queryOptions<
  EpicListHtmlArtifactVersionsResponse,
  HostRpcError
>({
  queryKey: ["expansion-parity-versions"],
  queryFn: () => Promise.resolve(HISTORY),
  initialData: HISTORY,
});

/** The real picker over a real query result, holding its own selection. */
function PickerControl(props: {
  readonly initiallyOn: HtmlArtifactVersion | null;
}) {
  const history = useQuery(historyOptions);
  const [selected, setSelected] = useState<HtmlArtifactVersionSelection | null>(
    props.initiallyOn,
  );
  const state: HtmlArtifactVersionState = {
    manifest: null,
    entryPath: null,
    selectedVersion: selected,
    // What the hook's own `numberForHtmlSelection` answers first: a selection
    // carries its number. The picker only ever hands back a whole
    // `HtmlArtifactVersion` it found in this history, and `initiallyOn` is one
    // too, so that is every selection this fixture can hold. The hook's other
    // branch - matching a selection by identity - is for a STAMPED selection,
    // which a chat card builds without a number and this surface never makes.
    selectedVersionNumber: selected?.versionNumber ?? null,
    currentVersionNumber: 3,
    selectionAvailable: true,
    selectVersion: setSelected,
    supported: true,
    history,
    showOlder: () => undefined,
    showNewest: () => undefined,
    hasNewer: false,
  };
  return <HtmlArtifactVersionPicker version={state} />;
}

function Providers(props: { readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{props.children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function commentTile(onDownload: () => void) {
  return (
    <Providers>
      <HtmlArtifactCommentSurface
        epicId="epic-1"
        artifactId="html-1"
        artifactTitle="Site"
        hostId="host-1"
        viewTabId="tab-1"
        source={sourceNamed("html-1")}
        caption={null}
        height={null}
        className="h-full w-full"
        onSize={() => undefined}
        onStatus={() => undefined}
        toolbarControls={<PickerControl initiallyOn={null} />}
        menuItems={
          <DropdownMenuItem onSelect={onDownload}>
            Download ZIP
          </DropdownMenuItem>
        }
        raiseToComment={false}
        commentable
      />
    </Providers>
  );
}

beforeEach(() => {
  frames.latest = null;
  frames.bridge = null;
  frames.mounts = 0;
  host.client = null;
  host.createThread.mockReset();
  pendingSaves.length = 0;
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  useAnchoredDraftStore.setState({ byEpicId: {} });
  disposeBridges();
  vi.restoreAllMocks();
});

function expand(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  return screen.getByRole("dialog", { name: "Site" });
}

/** The entry page proves itself - it names its page, then says ready. */
function markReady(): void {
  const frame = frames.latest;
  if (frame === null) throw new Error("no frame");
  act(() => {
    frame.pageNavigation?.onNavigate("index.html");
    frame.onStatus("ready");
  });
}

function overlays(): number {
  return document.querySelectorAll("[data-canvas-selection-overlay]").length;
}

describe("an expanded html artifact keeps the controls its tile passed in", () => {
  it("lets the reader switch versions from the version picker, whose menu opens inside the raised surface", async () => {
    const user = userEvent.setup();
    render(commentTile(vi.fn()));
    const dialog = expand();

    await user.click(
      within(dialog).getByRole("button", {
        name: "HTML version history: Latest",
      }),
    );
    // A menu portalled to the body would open behind the raised surface.
    const older = screen.getByRole("menuitemradio", { name: /Version 2/ });
    expect(dialog.contains(older)).toBe(true);
    await user.click(older);

    expect(
      within(dialog).getByRole("button", {
        name: "HTML version history: v2 of 3",
      }),
    ).toBeTruthy();
  });

  it("runs the caller's rows in More actions from the expanded surface", () => {
    const download = vi.fn();
    render(commentTile(download));
    const dialog = expand();

    fireEvent.pointerDown(
      within(dialog).getByRole("button", { name: "More actions" }),
      { button: 0 },
    );
    const row = screen.getByRole("menuitem", { name: "Download ZIP" });
    expect(dialog.contains(row)).toBe(true);
    fireEvent.click(row);

    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe("an expanded html artifact is the same surface the tile rendered", () => {
  it("turns comment mode on from the expanded surface on the one page, one overlay and one frame", () => {
    const bridge = realBridge();
    frames.bridge = bridge;
    const setMode = vi.spyOn(bridge, "setMode");
    render(commentTile(vi.fn()));
    const dialog = expand();
    markReady();

    fireEvent.click(within(dialog).getByRole("button", { name: "Comments" }));

    expect(setMode).toHaveBeenLastCalledWith("edit");
    expect(
      dialog.querySelectorAll("[data-canvas-selection-overlay]"),
    ).toHaveLength(1);
    expect(overlays()).toBe(1);
    expect(frames.mounts).toBe(1);
  });

  it("carries comment mode in both directions across expanding and collapsing, without reloading the page", () => {
    const bridge = realBridge();
    frames.bridge = bridge;
    const setMode = vi.spyOn(bridge, "setMode");
    render(commentTile(vi.fn()));
    const pressed = (scope: HTMLElement): string | null =>
      within(scope)
        .getByRole("button", { name: "Comments" })
        .getAttribute("aria-pressed");

    markReady();
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    const dialog = expand();
    expect(pressed(dialog)).toBe("true");
    expect(overlays()).toBe(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Comments" }));
    expect(overlays()).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Comments" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pressed(document.body)).toBe("true");
    expect(overlays()).toBe(1);
    expect(setMode).toHaveBeenLastCalledWith("edit");
    expect(frames.mounts).toBe(1);
  });
});

describe("expanding does not become a way around a gate", () => {
  it("keeps comments unavailable on an older version, whose toggle stays disabled and starts nothing", () => {
    const bridge = realBridge();
    frames.bridge = bridge;
    const setMode = vi.spyOn(bridge, "setMode");
    render(
      <Providers>
        <HtmlArtifactFrame
          source={sourceNamed("html-1")}
          title="Site"
          toolbarControls={
            <>
              <PickerControl initiallyOn={V2} />
              <FrameCommentsUnavailable reason="Comments are on the latest version" />
            </>
          }
        />
      </Providers>,
    );
    const inline = screen.getByRole("button", { name: "Comments" });
    expect(inline.hasAttribute("disabled")).toBe(true);

    const dialog = expand();
    const toggle = within(dialog).getByRole("button", { name: "Comments" });

    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(setMode).not.toHaveBeenCalledWith("edit");
    expect(overlays()).toBe(0);
    expect(
      within(dialog).getByRole("button", {
        name: "HTML version history: v2 of 3",
      }),
    ).toBeTruthy();
  });
});

describe("one expansion at a time", () => {
  it("raises one artifact at a time, and expanding a second moves the raise", () => {
    render(
      <Providers>
        <HtmlArtifactFrame
          source={sourceNamed("html-a")}
          title="First"
          toolbarControls={null}
        />
        <HtmlArtifactFrame
          source={sourceNamed("html-b")}
          title="Second"
          toolbarControls={null}
        />
      </Providers>,
    );
    const [firstExpand, secondExpand] = screen.getAllByRole("button", {
      name: "Expand",
    });
    fireEvent.click(firstExpand);
    expect(screen.getByRole("dialog", { name: "First" })).toBeTruthy();

    // A reader cannot reach this press in a browser - the document behind a
    // modal surface is inert - so what it exercises is the window's one claim:
    // it moves to the second artifact in this press and is never held twice.
    fireEvent.click(secondExpand);

    const raised = screen.getByRole("dialog", { name: "Second" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    // The first is a tile again: its toggle is back, outside the raised
    // surface, and the raised one's toggle is gone, so this query is unique.
    expect(
      raised.contains(screen.getByRole("button", { name: "Expand" })),
    ).toBe(false);
  });
});

const DRAFT_TILE = "00000000-0000-4000-8000-000000000001";

/** The selection provider owns the draft under a generated id; pin it. */
function startDraft(): void {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(DRAFT_TILE);
  render(commentTile(vi.fn()));
}

function openDraft(): void {
  act(() =>
    useAnchoredDraftStore.getState().setDraft("epic-1", {
      draftId: "draft-1",
      tileId: DRAFT_TILE,
      artifactId: "html-1",
      artifactType: "html",
      anchor: { kind: "artifact" },
      quotedText: "",
      rect: { x: 10, y: 10, width: 100, height: 20 },
      selection: null,
      retargeted: false,
    }),
  );
}

describe("the comment draft of an expanded html artifact", () => {
  it("is raised inside the expanded surface, where it can be reached", () => {
    startDraft();
    const dialog = expand();

    openDraft();

    // A draft portalled onto the pane or the body would sit behind the modal.
    const draft = screen.getByRole("dialog", { name: "New comment" });
    expect(dialog.contains(draft)).toBe(true);
  });

  describe("keeps what the reader typed", () => {
    it("when something outside the surface lowers it", () => {
      const confirm = vi.spyOn(window, "confirm");
      startDraft();
      const dialog = expand();
      openDraft();
      const editor = composerEditorAt(0);
      const root = editor.view.dom;
      typeIntoEditor(editor, "unsent words");

      // Not a Close click: something else needs the reader.
      let release = (): void => undefined;
      act(() => {
        release = holdFullscreenBlocker();
      });

      expect(screen.queryByRole("dialog", { name: "Site" })).toBeNull();
      expect(dialog.isConnected).toBe(true);
      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]?.draftId).toBe(
        "draft-1",
      );
      expect(composerEditorAt(0)).toBe(editor);
      expect(composerEditorAt(0).view.dom).toBe(root);
      expect(composerEditorAt(0).getText()).toBe("unsent words");
      expect(confirm).not.toHaveBeenCalled();
      release();
    });

    it("when the keyboard raises the surface", async () => {
      const user = userEvent.setup();
      const confirm = vi.spyOn(window, "confirm");
      startDraft();
      openDraft();
      const editor = composerEditorAt(0);
      const root = editor.view.dom;
      typeIntoEditor(editor, "unsent words");

      screen.getByRole("button", { name: "Expand" }).focus();
      await user.keyboard("{Enter}");

      const dialog = screen.getByRole("dialog", { name: "Site" });
      expect(
        dialog.contains(screen.getByRole("dialog", { name: "New comment" })),
      ).toBe(true);
      expect(composerEditorAt(0)).toBe(editor);
      expect(composerEditorAt(0).view.dom).toBe(root);
      expect(composerEditorAt(0).getText()).toBe("unsent words");
      expect(confirm).not.toHaveBeenCalled();
    });
  });
  describe("when its pane loses focus", () => {
    function paneTile(focused: boolean) {
      return (
        <SurfacePresentationBoundary visible focused={focused}>
          {commentTile(vi.fn())}
        </SurfacePresentationBoundary>
      );
    }

    it("conceals the raised draft and blurs its editor, keeping what was typed, and gives it back with the pane", () => {
      vi.spyOn(crypto, "randomUUID").mockReturnValue(DRAFT_TILE);
      const view = render(paneTile(true));
      expand();
      openDraft();
      const editor = composerEditorAt(0);
      const root = editor.view.dom;
      // jsdom does not treat a contenteditable as focusable, which a browser
      // does; give it the tab stop a browser gives it so focus can be held.
      root.tabIndex = 0;
      act(() => {
        root.focus();
      });
      typeIntoEditor(editor, "unsent words");
      // A mention raised from the composer lands in the same host, so it is
      // concealed with the draft rather than left over the pane.
      typeIntoEditor(editor, " @");
      // Concealed, so out of the accessibility tree the role queries read.
      const draft = screen.getByRole("dialog", {
        name: "New comment",
        hidden: true,
      });
      const mention = screen.getByRole("listbox", { hidden: true });
      expect(root.contains(document.activeElement)).toBe(true);
      // What conceals them is whatever sits ABOVE them, so each is asked for
      // its own ancestry: a concealed host with the draft elsewhere proves
      // nothing.
      for (const node of [draft, mention]) {
        expect(
          node.closest('[data-slot="artifact-comment-host"]'),
        ).not.toBeNull();
        expect(node.closest("[inert]")).toBeNull();
        expect(node.closest('[aria-hidden="true"]')).toBeNull();
      }

      view.rerender(paneTile(false));

      expect(root.contains(document.activeElement)).toBe(false);
      for (const node of [draft, mention]) {
        expect(node.closest("[inert]")).not.toBeNull();
        expect(node.closest('[aria-hidden="true"]')).not.toBeNull();
        expect(node.closest(".invisible.pointer-events-none")).not.toBeNull();
      }
      expect(composerEditorAt(0)).toBe(editor);
      expect(composerEditorAt(0).getText()).toBe("unsent words @");

      view.rerender(paneTile(true));

      for (const node of [draft, mention]) {
        expect(node.closest("[inert]")).toBeNull();
        expect(node.closest('[aria-hidden="true"]')).toBeNull();
        expect(node.closest(".invisible")).toBeNull();
      }
      expect(composerEditorAt(0)).toBe(editor);
      expect(composerEditorAt(0).view.dom).toBe(root);
      expect(composerEditorAt(0).getText()).toBe("unsent words @");
    });
  });
});

describe("Escape in a pane that holds two cards", () => {
  const SECOND_DRAFT_TILE = "00000000-0000-4000-8000-000000000002";

  function card(artifactId: string, title: string): ReactNode {
    return (
      <HtmlArtifactCommentSurface
        epicId="epic-1"
        artifactId={artifactId}
        artifactTitle={title}
        hostId="host-1"
        viewTabId="tab-1"
        source={sourceNamed(artifactId)}
        caption={null}
        height={null}
        className="h-full w-full"
        onSize={() => undefined}
        onStatus={() => undefined}
        toolbarControls={null}
        menuItems={undefined}
        raiseToComment
        commentable
      />
    );
  }

  function pane(withSecond: boolean): ReactNode {
    return (
      <Providers>
        <SurfacePresentationBoundary visible focused>
          {card("html-a", "First")}
          {withSecond ? card("html-b", "Second") : null}
        </SurfacePresentationBoundary>
      </Providers>
    );
  }

  /** First mounts with a real draft owner; the second pins its own. */
  function mountBoth() {
    const view = render(pane(false));
    vi.spyOn(crypto, "randomUUID").mockReturnValue(SECOND_DRAFT_TILE);
    view.rerender(pane(true));
    return view;
  }

  it("goes to a later raised card's dirty draft, asking to discard it, though an earlier card shares its pane", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mountBoth();
    const [, secondExpand] = screen.getAllByRole("button", { name: "Expand" });
    fireEvent.click(secondExpand);
    act(() =>
      useAnchoredDraftStore.getState().setDraft("epic-1", {
        draftId: "draft-b",
        tileId: SECOND_DRAFT_TILE,
        artifactId: "html-b",
        artifactType: "html",
        anchor: { kind: "artifact" },
        quotedText: "",
        rect: { x: 10, y: 10, width: 100, height: 20 },
        selection: null,
        retargeted: false,
      }),
    );
    typeIntoEditor(composerEditorAt(0), "unsent words");
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });

    act(() => {
      window.dispatchEvent(escape);
    });

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("goes to a lone raised card's dirty draft, asking to discard it", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(SECOND_DRAFT_TILE);
    render(pane(false));
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    act(() =>
      useAnchoredDraftStore.getState().setDraft("epic-1", {
        draftId: "draft-a",
        tileId: SECOND_DRAFT_TILE,
        artifactId: "html-a",
        artifactType: "html",
        anchor: { kind: "artifact" },
        quotedText: "",
        rect: { x: 10, y: 10, width: 100, height: 20 },
        selection: null,
        retargeted: false,
      }),
    );
    typeIntoEditor(composerEditorAt(0), "unsent words");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          cancelable: true,
          bubbles: true,
        }),
      );
    });

    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("the comment draft of a card that comments only while raised", () => {
  const onApprove = vi.fn<() => void>();

  function PinnedRows() {
    return (
      <output data-testid="pinned">
        {useFullscreenPinnedRowKeys().join()}
      </output>
    );
  }

  function transcriptCard() {
    return (
      <Providers>
        <SurfacePresentationBoundary visible focused>
          <div data-message-id="m-1" data-row-key="row-1">
            <HtmlArtifactCommentSurface
              epicId="epic-1"
              artifactId="html-1"
              artifactTitle="Site"
              hostId="host-1"
              viewTabId="tab-1"
              source={sourceNamed("html-1")}
              caption={null}
              height={null}
              className="h-full w-full"
              onSize={() => undefined}
              onStatus={() => undefined}
              toolbarControls={null}
              menuItems={undefined}
              raiseToComment
              commentable
            />
          </div>
          <button type="button" onClick={onApprove}>
            Approve
          </button>
          <PinnedRows />
        </SurfacePresentationBoundary>
      </Providers>
    );
  }

  function draftHost(): HTMLElement {
    const host = document.querySelector<HTMLElement>(
      '[data-slot="artifact-comment-host"]',
    );
    if (host === null) throw new Error("no comment host");
    return host;
  }

  it("stays mounted with its text, concealed and out of the way, when a blocker lowers the card, and returns when the card is raised again", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    onApprove.mockClear();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(DRAFT_TILE);
    render(transcriptCard());
    fireEvent.click(within(expand()).getByRole("button", { name: "Comments" }));
    openDraft();
    const editor = composerEditorAt(0);
    typeIntoEditor(editor, "unsent words");
    const host = draftHost();

    let release = (): void => undefined;
    act(() => {
      release = holdFullscreenBlocker();
    });
    onTestFinished(release);

    expect(screen.queryByRole("dialog", { name: "Site" })).toBeNull();
    expect(composerEditorAt(0)).toBe(editor);
    expect(composerEditorAt(0).getText()).toBe("unsent words");
    expect(host.closest("[inert]")).not.toBeNull();
    expect(host.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByTestId("pinned").textContent).toBe("row-1");
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.pointerDown(approve);
    fireEvent.click(approve);
    expect(confirm).not.toHaveBeenCalled();
    expect(onApprove).toHaveBeenCalledTimes(1);

    act(() => release());
    const raised = expand();

    expect(
      within(raised).getByRole("dialog", { name: "New comment" }),
    ).toBeTruthy();
    expect(host.closest("[inert]")).toBeNull();
    expect(host.closest('[aria-hidden="true"]')).toBeNull();
    expect(composerEditorAt(0)).toBe(editor);
    expect(composerEditorAt(0).getText()).toBe("unsent words");
  });
});

describe("a first comment whose stamp moves the artifact past the page on show", () => {
  const STAMPED_TID = "t-stamped";

  function raisedCard(commentable: boolean) {
    return (
      <Providers>
        <HtmlArtifactCommentSurface
          epicId="epic-1"
          artifactId="html-1"
          artifactTitle="Site"
          hostId="host-1"
          viewTabId="tab-1"
          source={sourceNamed("html-1")}
          caption={null}
          height={null}
          className="h-full w-full"
          onSize={() => undefined}
          onStatus={() => undefined}
          toolbarControls={null}
          menuItems={undefined}
          raiseToComment
          commentable={commentable}
        />
      </Providers>
    );
  }

  it("keeps the draft and its text through a failed create, and posts on the stamped element when the reader retries", async () => {
    host.client = { getActiveHostId: () => "host-1" };
    recordNegotiatedHostManifest("host-1", {
      "epic.createCommentThread": { major: 1, minor: 2 },
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(DRAFT_TILE);
    const view = render(raisedCard(true));
    fireEvent.click(within(expand()).getByRole("button", { name: "Comments" }));
    act(() =>
      useAnchoredDraftStore.getState().setDraft("epic-1", {
        draftId: "draft-1",
        tileId: DRAFT_TILE,
        artifactId: "html-1",
        artifactType: "html",
        anchor: {
          kind: "element",
          artboard: "index.html",
          elementId: null,
          label: "p",
        },
        quotedText: "",
        rect: { x: 10, y: 10, width: 100, height: 20 },
        selection: {
          ...textSelection(null, { tid: null, marker: 0 }),
          artifactId: "html-1",
          boardPath: "index.html",
        },
        retargeted: false,
      }),
    );
    typeIntoEditor(composerEditorAt(0), "unsent words");
    const created = createDeferred<{ readonly threadId: string }>();
    host.createThread.mockReturnValueOnce(created.promise);

    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await settleSave(0, {
      ok: true,
      tid: STAMPED_TID,
      sha256After: "a".repeat(64),
      splices: [],
    });
    await settle();
    expect(host.createThread).toHaveBeenCalledTimes(1);

    // The stamp moved the head past the page on show.
    view.rerender(raisedCard(false));
    await act(async () => {
      created.reject(new Error("host unreachable"));
      await Promise.resolve();
    });

    expect(screen.getByRole("alert").textContent).toBe("host unreachable");
    expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]?.draftId).toBe(
      "draft-1",
    );
    expect(composerEditorAt(0).getText()).toBe("unsent words");

    host.createThread.mockResolvedValueOnce({ threadId: "thread-1" });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await settle();

    expect(host.createThread).toHaveBeenCalledTimes(2);
    expect(host.createThread.mock.calls[1][0].anchor).toMatchObject({
      kind: "element",
      elementId: STAMPED_TID,
    });
    expect(pendingSaves).toHaveLength(1);
    expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toBeUndefined();
  });
});

describe("a card whose draft a blocker has parked", () => {
  const FIRST_TILE = "00000000-0000-4000-8000-0000000000a1";
  const SECOND_TILE = "00000000-0000-4000-8000-0000000000b2";
  const DISCARD_QUESTION =
    "Discard this comment draft? Unsaved text will be lost.";

  function card(artifactId: string, title: string): ReactNode {
    return (
      <HtmlArtifactCommentSurface
        epicId="epic-1"
        artifactId={artifactId}
        artifactTitle={title}
        hostId="host-1"
        viewTabId="tab-1"
        source={sourceNamed(artifactId)}
        caption={null}
        height={null}
        className="h-full w-full"
        onSize={() => undefined}
        onStatus={() => undefined}
        toolbarControls={null}
        menuItems={undefined}
        raiseToComment
        commentable
      />
    );
  }

  function pane(second: ReactNode): ReactNode {
    return (
      <Providers>
        <SurfacePresentationBoundary visible focused>
          {card("html-a", "First")}
          {second}
        </SurfacePresentationBoundary>
      </Providers>
    );
  }

  /** The first card raised with Comments on, beside `second`. */
  function raiseFirstCard(second: ReactNode): void {
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    randomUUID.mockReturnValue(FIRST_TILE);
    const view = render(
      <Providers>
        <SurfacePresentationBoundary visible focused>
          {card("html-a", "First")}
        </SurfacePresentationBoundary>
      </Providers>,
    );
    randomUUID.mockReturnValue(SECOND_TILE);
    view.rerender(pane(second));
    const [firstExpand] = screen.getAllByRole("button", { name: "Expand" });
    fireEvent.click(firstExpand);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "First" })).getByRole(
        "button",
        { name: "Comments" },
      ),
    );
  }

  /**
   * The first card is raised, a draft opened on it and typed into, and a
   * blocker lowers it: the draft is parked, answering no Escape or press.
   */
  function parkFirstCardsDraft(text: string | null, second: ReactNode): void {
    raiseFirstCard(second);
    act(() =>
      useAnchoredDraftStore.getState().setDraft("epic-1", {
        draftId: "draft-a",
        tileId: FIRST_TILE,
        artifactId: "html-a",
        artifactType: "html",
        anchor: { kind: "artifact" },
        quotedText: "",
        rect: { x: 10, y: 10, width: 100, height: 20 },
        selection: null,
        retargeted: false,
      }),
    );
    if (text !== null) typeIntoEditor(composerEditorAt(0), text);
    let release = (): void => undefined;
    act(() => {
      release = holdFullscreenBlocker();
    });
    act(() => release());
  }

  describe("a second card starting a comment while the first card's draft is parked", () => {
    /** The second card's pick, through the opener its provider calls. */
    async function startSecondCardsComment(): Promise<void> {
      await act(async () => {
        await openFrameCommentDraft({
          epicId: "epic-1",
          tileId: SECOND_TILE,
          artifactType: "html",
          selection: {
            ...textSelection(null, { tid: "b-el", marker: 1 }),
            artifactId: "html-b",
            boardPath: "index.html",
          },
          bridge: realBridge(),
          frame: document.createElement("iframe"),
          source: null,
          queryClient: new QueryClient(),
          isCurrent: () => true,
        });
      });
    }

    function openDraftId(): string | undefined {
      return useAnchoredDraftStore.getState().byEpicId["epic-1"]?.draftId;
    }

    it("asks before dropping the parked draft's text, and keeps the draft and its text when the reader says no", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      parkFirstCardsDraft("unsent words", card("html-b", "Second"));
      const editor = composerEditorAt(0);

      await startSecondCardsComment();

      expect(confirm).toHaveBeenCalledExactlyOnceWith(DISCARD_QUESTION);
      expect(openDraftId()).toBe("draft-a");
      expect(composerEditorAt(0)).toBe(editor);
      expect(composerEditorAt(0).getText()).toBe("unsent words");
    });

    it("opens the second card's draft in its place when the reader agrees to discard", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      parkFirstCardsDraft("unsent words", card("html-b", "Second"));

      await startSecondCardsComment();

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        {
          tileId: SECOND_TILE,
          artifactId: "html-b",
        },
      );
    });

    it("replaces an empty parked draft without asking", async () => {
      const confirm = vi.spyOn(window, "confirm");
      parkFirstCardsDraft(null, card("html-b", "Second"));

      await startSecondCardsComment();

      expect(confirm).not.toHaveBeenCalled();
      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        {
          tileId: SECOND_TILE,
          artifactId: "html-b",
        },
      );
    });
  });

  describe("a canvas pane pin while a card's draft is parked", () => {
    const pin: { events: CanvasFrameEvents | null } = { events: null };

    function PinHost() {
      const events = useContext(CanvasFrameEventsContext);
      useEffect(() => {
        pin.events = events;
      }, [events]);
      return events?.renderCommentDraft?.() ?? null;
    }

    function paneCommentHandler(): CanvasFrameEvents["onPaneComment"] {
      return pin.events?.onPaneComment;
    }

    function canvasProvider(): ReactNode {
      return (
        <CanvasSelectionProvider
          epicId="epic-1"
          artifactId="canvas-1"
          artifactTitle="Board"
          artifactType="canvas"
          hostId="host-1"
          viewTabId="tab-1"
        >
          <PinHost />
        </CanvasSelectionProvider>
      );
    }

    function pinOnCanvas(): void {
      const onPaneComment = paneCommentHandler();
      if (onPaneComment === undefined)
        throw new Error("no pane comment handler");
      act(() =>
        onPaneComment({
          screen: { x: 300, y: 200 },
          canvas: { x: 40, y: -12 },
          page: "flow",
        }),
      );
    }

    function parkCardDraftAndPin(): void {
      pin.events = null;
      parkFirstCardsDraft("unsent words", canvasProvider());
      pinOnCanvas();
    }

    it("keeps the parked card draft and its text, opening no pin, when the reader declines to discard it", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

      parkCardDraftAndPin();

      expect(confirm).toHaveBeenCalledExactlyOnceWith(DISCARD_QUESTION);
      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        {
          draftId: "draft-a",
          anchor: { kind: "artifact" },
        },
      );
      expect(composerEditorAt(0).getText()).toBe("unsent words");
    });

    it("pins the comment in its place when the reader agrees to discard the parked draft", () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);

      parkCardDraftAndPin();

      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        {
          tileId: SECOND_TILE,
          artifactId: "canvas-1",
          anchor: { kind: "canvas-point", page: "flow", x: 40, y: -12 },
        },
      );
    });

    it("leaves another view's draft alone while it is posting, even when the reader would discard it", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      host.client = { getActiveHostId: () => "host-1" };
      recordNegotiatedHostManifest("host-1", {
        "epic.createCommentThread": { major: 1, minor: 3 },
      });
      const bridge = realBridge();
      frames.bridge = bridge;
      const stamped = createDeferred<boolean>();
      const stampTid = vi
        .spyOn(bridge, "stampTid")
        .mockReturnValue(stamped.promise);
      pin.events = null;
      raiseFirstCard(canvasProvider());
      markReady();
      act(() =>
        useAnchoredDraftStore.getState().setDraft("epic-1", {
          draftId: "draft-a",
          tileId: FIRST_TILE,
          artifactId: "html-a",
          artifactType: "html",
          anchor: {
            kind: "element",
            artboard: "index.html",
            elementId: null,
            label: "p",
          },
          quotedText: "",
          rect: { x: 10, y: 10, width: 100, height: 20 },
          selection: {
            ...textSelection(null, { tid: null, marker: 0 }),
            artifactId: "html-a",
            boardPath: "index.html",
            servedSha256: "a".repeat(64),
          },
          retargeted: false,
        }),
      );
      typeIntoEditor(composerEditorAt(0), "unsent words");
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await settleSave(0, {
        ok: true,
        tid: "t-stamped",
        sha256After: "b".repeat(64),
        splices: [],
      });
      await settle();
      // The id is being adopted: no request is in flight, the draft is posting.
      expect(stampTid).toHaveBeenCalledTimes(1);
      expect(host.createThread).not.toHaveBeenCalled();
      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        { draftId: "draft-a", submitting: true },
      );

      pinOnCanvas();

      expect(confirm).not.toHaveBeenCalled();
      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        { draftId: "draft-a", submitting: true },
      );

      host.createThread.mockResolvedValueOnce({ threadId: "thread-1" });
      stamped.resolve(true);
      await settle();

      expect(host.createThread).toHaveBeenCalledTimes(1);
      expect(
        useAnchoredDraftStore.getState().byEpicId["epic-1"],
      ).toBeUndefined();
      pinOnCanvas();
      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        { artifactId: "canvas-1", anchor: { kind: "canvas-point" } },
      );
    });

    it("opens nothing new when a view pins again while its own pin is posting", async () => {
      host.client = { getActiveHostId: () => "host-1" };
      recordNegotiatedHostManifest("host-1", {
        "epic.createCommentThread": { major: 1, minor: 3 },
      });
      pin.events = null;
      render(
        <Providers>
          <SurfacePresentationBoundary visible focused>
            {canvasProvider()}
          </SurfacePresentationBoundary>
        </Providers>,
      );
      pinOnCanvas();
      const first = useAnchoredDraftStore.getState().byEpicId["epic-1"];
      if (first === undefined) throw new Error("the first pin opened no draft");
      typeIntoEditor(composerEditorAt(0), "pinned words");
      const created = createDeferred<{ readonly threadId: string }>();
      host.createThread.mockReturnValueOnce(created.promise);
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await settle();
      expect(host.createThread).toHaveBeenCalledTimes(1);

      const pinAgain = paneCommentHandler();
      if (pinAgain === undefined) throw new Error("no pane comment handler");
      act(() => {
        pinAgain({
          screen: { x: 10, y: 20 },
          canvas: { x: 5, y: 6 },
          page: "other",
        });
      });

      expect(useAnchoredDraftStore.getState().byEpicId["epic-1"]).toMatchObject(
        { draftId: first.draftId, anchor: { kind: "canvas-point", x: 40 } },
      );
      created.resolve({ threadId: "thread-1" });
      await settle();
    });
  });
});
