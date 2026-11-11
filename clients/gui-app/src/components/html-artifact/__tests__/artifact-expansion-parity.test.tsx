import { useEffect, useState, type ReactNode } from "react";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EpicListHtmlArtifactVersionsResponse,
  HtmlArtifactVersion,
  HtmlArtifactVersionSelection,
} from "@traycer/protocol/host/epic/html-artifact-versions";
import {
  disposeBridges,
  realBridge,
} from "@/components/canvas-artifact/__tests__/canvas-edit-test-support";
import { FrameCommentsUnavailable } from "@/components/comments/frame-comments";
import type { SandboxFrameProps } from "@/components/sandbox/sandbox-frame";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HtmlArtifactVersionState } from "@/hooks/epic/use-epic-html-artifact-version";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { holdFullscreenBlocker } from "@/lib/sandbox/overlay-owner";
import {
  composerEditorAt,
  typeIntoEditor,
} from "@/components/comments/__tests__/comment-submit-test-support";
import { useAnchoredDraftStore } from "@/stores/comments/anchored-draft-store";
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
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
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
        toolbarControls={<PickerControl initiallyOn={null} />}
        menuItems={
          <DropdownMenuItem onSelect={onDownload}>
            Download ZIP
          </DropdownMenuItem>
        }
      />
    </Providers>
  );
}

beforeEach(() => {
  frames.latest = null;
  frames.bridge = null;
  frames.mounts = 0;
});

afterEach(() => {
  cleanup();
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
