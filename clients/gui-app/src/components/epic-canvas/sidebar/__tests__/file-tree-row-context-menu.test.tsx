/**
 * Pins `FileTreeRowContextMenu`'s row recovery, directory/file labeling, and
 * gating:
 *
 * - The row under a right-click is recovered from the event's composed path,
 *   not from a per-row element the tree hands the menu directly - a
 *   right-click that hits no tagged row must not open an empty menu.
 * - A row is a directory by either of two independent tells (a trailing
 *   separator, or absence from the openable-file map); a file row shows
 *   "Reveal in Finder", a directory row "Open in Finder".
 * - The absolute path handed to the host strips a directory row's trailing
 *   separator; the copied relative path is the workspace-relative tree path
 *   with the same separator stripped.
 * - The Finder item and the editor items are independently gated (Finder's
 *   own availability probe; the editor items on the host directory entry
 *   being local) while the two Copy items are unconditional.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { EditorEntry, EditorId } from "@traycer/protocol/host";
import { toast } from "sonner";
import { FileTreeRowContextMenu } from "../file-tree-row-context-menu";
import { PIERRE_ITEM_PATH_ATTR } from "@/components/epic-canvas/pierre-tree-adapter";

const EDITOR_CATALOG: ReadonlyArray<EditorEntry> = vi.hoisted(
  (): ReadonlyArray<EditorEntry> => [
    { id: "vscode", label: "VS Code", urlScheme: "vscode" },
    { id: "cursor", label: "Cursor", urlScheme: "cursor" },
    { id: "windsurf", label: "Windsurf", urlScheme: "windsurf" },
    { id: "zed", label: "Zed", urlScheme: "zed" },
    { id: "vscodium", label: "VSCodium", urlScheme: "vscodium" },
  ],
);

interface ContextMenuTestState {
  mutate: Mock<
    (input: { readonly editorId: string; readonly paths: string[] }) => void
  >;
  isPending: boolean;
  availability: string[];
  // Keyed by hostId, mirroring the open-in-editor-button fixture: the editor
  // items' gate reads the row's OWN host directory entry.
  hostKindByHostId: Record<string, string>;
  finderAvailable: boolean;
  offerableEditorIds: EditorId[];
}

const menuState = vi.hoisted((): ContextMenuTestState => ({
  mutate: vi.fn(),
  isPending: false,
  availability: ["vscode", "cursor", "windsurf", "zed"],
  hostKindByHostId: { "host-1": "local" },
  finderAvailable: true,
  offerableEditorIds: ["vscode", "cursor", "windsurf", "zed", "vscodium"],
}));

const copyCalls: string[] = [];

interface ClipboardCopyOptions {
  readonly resetMs: number;
  readonly onSuccess: (() => void) | null;
  readonly onError: (() => void) | null;
}

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({
    mutate: menuState.mutate,
    isPending: menuState.isPending,
  }),
}));

vi.mock("@/hooks/editor/use-editor-availability-query", () => ({
  useEditorAvailability: () => ({
    data: menuState.availability,
  }),
}));

vi.mock("@/hooks/editor/use-finder-open-availability", () => ({
  useFinderOpenAvailability: () => menuState.finderAvailable,
}));

vi.mock("@/hooks/editor/use-offerable-editors", () => ({
  useOfferableEditors: () =>
    EDITOR_CATALOG.filter((editor) =>
      menuState.offerableEditorIds.includes(editor.id),
    ),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) => {
    if (hostId === null) return null;
    if (!(hostId in menuState.hostKindByHostId)) return null;
    return { kind: menuState.hostKindByHostId[hostId] };
  },
}));

// Captures what each copy call was actually given, and fires the real
// `onSuccess` synchronously - which is what drives the two distinct toast
// messages the component wires per copy target.
vi.mock("@/hooks/ui/use-clipboard-copy", () => ({
  useClipboardCopy: (options: ClipboardCopyOptions) => ({
    copied: false,
    copy: (value: string) => {
      copyCalls.push(value);
      options.onSuccess?.();
    },
    copyWith: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

const FILE_NAME_BY_PATH = new Map<string, string>([
  ["src/index.ts", "index.ts"],
]);

const FILE_ROW_PATH = "src/index.ts";
// Directory tell #1: a trailing separator.
const DIR_ROW_TRAILING_SLASH_PATH = "src/lib/";
// Directory tell #2: absent from `fileNameByPath`, no trailing separator.
const DIR_ROW_ABSENT_PATH = "src/assets";

function renderTree(hostId: string | null) {
  return render(
    <FileTreeRowContextMenu
      hostId={hostId}
      workspacePath="/repo"
      fileNameByPath={FILE_NAME_BY_PATH}
    >
      <div data-testid="tree">
        <div
          data-testid="row-file"
          {...{ [PIERRE_ITEM_PATH_ATTR]: FILE_ROW_PATH }}
        >
          index.ts
        </div>
        <div
          data-testid="row-dir-trailing"
          {...{ [PIERRE_ITEM_PATH_ATTR]: DIR_ROW_TRAILING_SLASH_PATH }}
        >
          lib
        </div>
        <div
          data-testid="row-dir-absent"
          {...{ [PIERRE_ITEM_PATH_ATTR]: DIR_ROW_ABSENT_PATH }}
        >
          assets
        </div>
      </div>
    </FileTreeRowContextMenu>,
  );
}

function renderTreeWithChildren(hostId: string | null, children: ReactElement) {
  return render(
    <FileTreeRowContextMenu
      hostId={hostId}
      workspacePath="/repo"
      fileNameByPath={FILE_NAME_BY_PATH}
    >
      {children}
    </FileTreeRowContextMenu>,
  );
}

describe("<FileTreeRowContextMenu />", () => {
  beforeEach(() => {
    cleanup();
    menuState.mutate.mockClear();
    menuState.isPending = false;
    menuState.availability = ["vscode", "cursor", "windsurf", "zed"];
    menuState.hostKindByHostId = { "host-1": "local" };
    menuState.finderAvailable = true;
    menuState.offerableEditorIds = [
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "vscodium",
    ];
    copyCalls.length = 0;
    vi.mocked(toast.success).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("labels the Finder item 'Reveal in Finder' for a file row", () => {
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-file"));

    expect(screen.getByTestId("epic-file-tree-row-finder").textContent).toBe(
      "Reveal in Finder",
    );
  });

  it("labels the Finder item 'Open in Finder' for a directory row marked by a trailing slash", () => {
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-dir-trailing"));

    expect(screen.getByTestId("epic-file-tree-row-finder").textContent).toBe(
      "Open in Finder",
    );
  });

  it("labels the Finder item 'Open in Finder' for a directory row absent from fileNameByPath", () => {
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-dir-absent"));

    expect(screen.getByTestId("epic-file-tree-row-finder").textContent).toBe(
      "Open in Finder",
    );
  });

  // One select per render: a second launch inside the same menu instance is
  // deliberately suppressed while an open is in flight.
  it("dispatches the finder target with a file row's absolute path", () => {
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-file"));
    fireEvent.click(screen.getByTestId("epic-file-tree-row-finder"));

    expect(menuState.mutate).toHaveBeenLastCalledWith({
      editorId: "finder",
      paths: ["/repo/src/index.ts"],
    });
  });

  it("strips a directory row's trailing slash from the dispatched path", () => {
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-dir-trailing"));
    fireEvent.click(screen.getByTestId("epic-file-tree-row-finder"));

    expect(menuState.mutate).toHaveBeenLastCalledWith({
      editorId: "finder",
      paths: ["/repo/src/lib"],
    });
  });

  it("copies the absolute path and the trailing-slash-stripped relative path, toasting each", () => {
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-dir-trailing"));
    fireEvent.click(screen.getByTestId("epic-file-tree-row-copy-path"));

    expect(copyCalls).toEqual(["/repo/src/lib"]);
    expect(toast.success).toHaveBeenLastCalledWith("Copied path");

    fireEvent.contextMenu(screen.getByTestId("row-dir-trailing"));
    fireEvent.click(
      screen.getByTestId("epic-file-tree-row-copy-relative-path"),
    );

    expect(copyCalls).toEqual(["/repo/src/lib", "src/lib"]);
    expect(toast.success).toHaveBeenLastCalledWith("Copied relative path");
  });

  it("does not open the menu for a right-click that hits no row, and prevents its default", () => {
    renderTree("host-1");

    const wasNotPrevented = fireEvent.contextMenu(screen.getByTestId("tree"));

    expect(wasNotPrevented).toBe(false);
    expect(screen.queryByTestId("epic-file-tree-row-menu")).toBeNull();
  });

  it("hides the Finder item when the gate is closed, keeping both Copy items", () => {
    menuState.finderAvailable = false;
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-file"));

    expect(screen.queryByTestId("epic-file-tree-row-finder")).toBeNull();
    screen.getByTestId("epic-file-tree-row-copy-path");
    screen.getByTestId("epic-file-tree-row-copy-relative-path");
  });

  it("renders no editor items when the host entry is not local, while both Copy items still render", () => {
    menuState.hostKindByHostId = { "host-1": "remote" };
    renderTree("host-1");

    fireEvent.contextMenu(screen.getByTestId("row-file"));

    expect(screen.queryByTestId("epic-file-tree-row-open-vscode")).toBeNull();
    expect(screen.queryByTestId("epic-file-tree-row-open-cursor")).toBeNull();
    screen.getByTestId("epic-file-tree-row-copy-path");
    screen.getByTestId("epic-file-tree-row-copy-relative-path");
  });

  // Radix arms a 700ms long-press timer on a touch/pen pointerdown and opens
  // WITHOUT ever firing `contextMenu`, so the row has to be captured there too
  // or the menu opens with no content mounted.
  describe("touch long-press", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it("opens with the pressed row after the long-press delay", () => {
      renderTree("host-1");

      fireEvent.pointerDown(screen.getByTestId("row-file"), {
        pointerType: "touch",
      });
      act(() => {
        vi.advanceTimersByTime(700);
      });

      // `toContain`, not `toBe`: the spinner glyph shares the item's
      // textContent. A label swapped to "Opening…" still fails this.
      expect(
        screen.getByTestId("epic-file-tree-row-finder").textContent,
      ).toContain("Reveal in Finder");
    });

    it("labels a directory row correctly through the same path", () => {
      renderTree("host-1");

      fireEvent.pointerDown(screen.getByTestId("row-dir-trailing"), {
        pointerType: "touch",
      });
      act(() => {
        vi.advanceTimersByTime(700);
      });

      expect(screen.getByTestId("epic-file-tree-row-finder").textContent).toBe(
        "Open in Finder",
      );
    });

    it("opens nothing when the long-press hits no row", () => {
      renderTree("host-1");

      const notPrevented = fireEvent.pointerDown(screen.getByTestId("tree"), {
        pointerType: "touch",
      });
      act(() => {
        vi.advanceTimersByTime(700);
      });

      expect(notPrevented).toBe(false);
      expect(screen.queryByTestId("epic-file-tree-row-menu")).toBeNull();
    });

    it("ignores a mouse pointerdown, leaving that path to contextMenu", () => {
      renderTree("host-1");

      fireEvent.pointerDown(screen.getByTestId("row-file"), {
        pointerType: "mouse",
      });
      act(() => {
        vi.advanceTimersByTime(700);
      });

      expect(screen.queryByTestId("epic-file-tree-row-menu")).toBeNull();
    });
  });

  // One launch at a time: the menu can be reopened and a target reselected
  // while a slow open is still in flight, and every mutate is queued rather
  // than coalesced, so an unguarded handler launches the same path twice.
  describe("while an open is in flight", () => {
    it("disables the editor and Finder items but not the Copy items", () => {
      menuState.isPending = true;
      renderTree("host-1");

      fireEvent.contextMenu(screen.getByTestId("row-file"));

      expect(
        screen
          .getByTestId("epic-file-tree-row-open-vscode")
          .getAttribute("data-disabled"),
      ).not.toBeNull();
      expect(
        screen
          .getByTestId("epic-file-tree-row-finder")
          .getAttribute("data-disabled"),
      ).not.toBeNull();
      expect(
        screen
          .getByTestId("epic-file-tree-row-copy-path")
          .getAttribute("data-disabled"),
      ).toBeNull();
      expect(
        screen
          .getByTestId("epic-file-tree-row-copy-relative-path")
          .getAttribute("data-disabled"),
      ).toBeNull();
    });

    it("swaps each launching item's icon for the spinner, leaving the label alone", () => {
      menuState.isPending = true;
      renderTree("host-1");

      fireEvent.contextMenu(screen.getByTestId("row-file"));

      // The disabled state has to read as work in progress rather than as a
      // dead item, and the label must not become "Opening…" - the spinner is
      // the only channel that moves.
      screen.getByTestId("epic-file-tree-row-open-vscode-spinner");
      screen.getByTestId("epic-file-tree-row-finder-spinner");
      expect(
        screen.getByTestId("epic-file-tree-row-open-vscode").textContent,
      ).toContain("VS Code");
      // `toContain`, not `toBe`: the spinner glyph shares the item's
      // textContent. A label swapped to "Opening…" still fails this.
      expect(
        screen.getByTestId("epic-file-tree-row-finder").textContent,
      ).toContain("Reveal in Finder");

      // The Copy items neither disable nor spin - they touch no host.
      expect(
        screen.queryByTestId("epic-file-tree-row-copy-path-spinner"),
      ).toBeNull();
    });

    it("shows no spinner while idle", () => {
      renderTree("host-1");

      fireEvent.contextMenu(screen.getByTestId("row-file"));

      expect(
        screen.queryByTestId("epic-file-tree-row-open-vscode-spinner"),
      ).toBeNull();
      expect(
        screen.queryByTestId("epic-file-tree-row-finder-spinner"),
      ).toBeNull();
    });

    it("does not dispatch a second launch while the mutation is pending", () => {
      menuState.isPending = true;
      renderTree("host-1");

      fireEvent.contextMenu(screen.getByTestId("row-file"));
      fireEvent.click(screen.getByTestId("epic-file-tree-row-finder"));

      expect(menuState.mutate).not.toHaveBeenCalled();
    });

    it("does not relaunch when the menu is reopened and reselected inside the feedback window", () => {
      // The pending flag has to outlive the menu closing, which is exactly the
      // reopen-and-reselect path: `isPending` stays false here, so the
      // press-feedback half of the guard is what has to hold.
      renderTree("host-1");

      fireEvent.contextMenu(screen.getByTestId("row-file"));
      fireEvent.click(screen.getByTestId("epic-file-tree-row-finder"));
      expect(menuState.mutate).toHaveBeenCalledTimes(1);

      fireEvent.contextMenu(screen.getByTestId("row-file"));
      fireEvent.click(screen.getByTestId("epic-file-tree-row-finder"));

      expect(menuState.mutate).toHaveBeenCalledTimes(1);
    });
  });

  it("accepts an arbitrary trigger subtree via its children prop", () => {
    renderTreeWithChildren(
      "host-1",
      <ul data-testid="tree">
        <li
          data-testid="row-file"
          {...{ [PIERRE_ITEM_PATH_ATTR]: FILE_ROW_PATH }}
        >
          index.ts
        </li>
      </ul>,
    );

    fireEvent.contextMenu(screen.getByTestId("row-file"));

    screen.getByTestId("epic-file-tree-row-menu");
  });
});
