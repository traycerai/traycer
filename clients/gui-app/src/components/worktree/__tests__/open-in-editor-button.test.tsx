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
import type { EditorEntry, EditorId } from "@traycer/protocol/host";
import { OpenInEditorButton } from "../open-in-editor-button";
import { useSettingsStore } from "@/stores/settings/settings-store";

// Mirrors the live `EDITORS` registry's shape (id/label/urlScheme) without
// importing it, so the fixture stays a self-contained value the test owns
// rather than a runtime dependency on the protocol package's current catalog.
const EDITOR_CATALOG: ReadonlyArray<EditorEntry> = vi.hoisted(
  (): ReadonlyArray<EditorEntry> => [
    { id: "vscode", label: "VS Code", urlScheme: "vscode" },
    { id: "cursor", label: "Cursor", urlScheme: "cursor" },
    { id: "windsurf", label: "Windsurf", urlScheme: "windsurf" },
    { id: "zed", label: "Zed", urlScheme: "zed" },
    { id: "vscodium", label: "VSCodium", urlScheme: "vscodium" },
  ],
);

interface EditorButtonTestState {
  mutate: Mock<
    (input: { readonly editorId: string; readonly paths: string[] }) => void
  >;
  isPending: boolean;
  availability: string[];
  hasLocalHost: boolean;
  // Keyed by hostId, not by any "active"/"effective" concept - the button
  // dispatches on the caller's OWN `hostClient` now (Y6) and gates purely on
  // whether the OPEN TARGET's own host is local, so the fixture below answers
  // per hostId rather than off one ambient "the active host" value.
  hostKindByHostId: Record<string, string>;
  // Finder's own gate (`useFinderOpenAvailability`) - independent of the host
  // directory lookup above, which the button also consults for its editor
  // gate; this fixture answers it directly rather than reconstructing the
  // negotiated-version stack the real hook is built on.
  finderAvailable: boolean;
  // What `useOfferableEditors` returns, expressed as the ids to keep from
  // `EDITOR_CATALOG` - the host-accepts gate, independent of `availability`
  // (the installed-on-this-machine probe). Defaults to the full catalog so
  // the pre-existing tests below see the same unrestricted menu they did
  // before this gate existed.
  offerableEditorIds: EditorId[];
}

const editorState = vi.hoisted((): EditorButtonTestState => ({
  mutate: vi.fn(),
  isPending: false,
  availability: ["vscode", "cursor", "windsurf", "zed"],
  hasLocalHost: true,
  hostKindByHostId: { "host-1": "local" },
  finderAvailable: false,
  offerableEditorIds: ["vscode", "cursor", "windsurf", "zed", "vscodium"],
}));

const directoryEntryCalls: string[] = [];

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({
    mutate: editorState.mutate,
    isPending: editorState.isPending,
  }),
}));

vi.mock("@/hooks/editor/use-editor-availability-query", () => ({
  useEditorAvailability: () => ({
    data: editorState.availability,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    hasLocalHost: editorState.hasLocalHost,
  }),
}));

// The gate reads ONLY the open target's own host directory entry (Y6) - no
// "effective"/"active" host hook is mocked at all, which is itself part of
// the regression proof: the component no longer imports one.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) => {
    directoryEntryCalls.push(hostId);
    if (!(hostId in editorState.hostKindByHostId)) return null;
    return { kind: editorState.hostKindByHostId[hostId] };
  },
}));

// Mocked at the hook boundary rather than reconstructed from the negotiated
// version + host directory stack it is built on - the component only cares
// about the boolean these hooks resolve to.
vi.mock("@/hooks/editor/use-finder-open-availability", () => ({
  useFinderOpenAvailability: () => editorState.finderAvailable,
}));

vi.mock("@/hooks/editor/use-offerable-editors", () => ({
  useOfferableEditors: () =>
    EDITOR_CATALOG.filter((editor) =>
      editorState.offerableEditorIds.includes(editor.id),
    ),
}));

describe("<OpenInEditorButton />", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    editorState.mutate.mockClear();
    editorState.isPending = false;
    editorState.availability = ["vscode", "cursor", "windsurf", "zed"];
    editorState.hasLocalHost = true;
    editorState.hostKindByHostId = { "host-1": "local" };
    editorState.finderAvailable = false;
    editorState.offerableEditorIds = [
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "vscodium",
    ];
    directoryEntryCalls.length = 0;
    useSettingsStore.setState({ defaultEditor: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows click feedback and temporarily disables editor controls", () => {
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    const primaryButton = screen.getByTestId(
      "workspace-open-in-editor-primary",
    );
    const chooserButton = screen.getByTestId(
      "workspace-open-in-editor-chevron",
    );

    fireEvent.click(primaryButton);

    expect(editorState.mutate).toHaveBeenCalledWith({
      editorId: "vscode",
      paths: ["/repo"],
    });
    expect(
      screen.getByTestId("workspace-open-in-editor-spinner"),
    ).toBeDefined();
    expect(primaryButton.hasAttribute("disabled")).toBe(true);
    expect(chooserButton.hasAttribute("disabled")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(primaryButton.hasAttribute("disabled")).toBe(false);
    expect(chooserButton.hasAttribute("disabled")).toBe(false);
  });

  it("disables the controls when there is no open target", () => {
    render(<OpenInEditorButton openTarget={null} hostClient={null} />);

    const primaryButton = screen.getByTestId(
      "workspace-open-in-editor-primary",
    );
    const chooserButton = screen.getByTestId(
      "workspace-open-in-editor-chevron",
    );

    expect(primaryButton.hasAttribute("disabled")).toBe(true);
    expect(chooserButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(primaryButton);
    expect(editorState.mutate).not.toHaveBeenCalled();
  });

  it("disables the controls when the target host itself is not local", () => {
    editorState.hostKindByHostId = { "host-1": "remote" };
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    expect(
      screen
        .getByTestId("workspace-open-in-editor-primary")
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("workspace-open-in-editor-chevron")
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("workspace-open-in-editor-primary"));
    expect(editorState.mutate).not.toHaveBeenCalled();
  });

  // Y6 regression: the panel's own surface pin can be local while the
  // app-wide EFFECTIVE host is remote (a git-diff / file-tree panel pinned to
  // a different machine than the window is showing). The old gate compared
  // `openTarget.hostId` against the app-wide effective host and hid the
  // button for the very machine that has the editor; the new gate asks only
  // about the target's OWN host, so it renders enabled here - and the
  // directory lookup is proven to be keyed on the target's host id alone
  // (never on a stand-in "effective" id this fixture also knows about).
  it("renders enabled when the target host is local, independent of any other host's state", () => {
    editorState.hostKindByHostId = {
      "host-1": "local",
      "effective-remote-host": "remote",
    };
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    expect(
      screen
        .getByTestId("workspace-open-in-editor-primary")
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByTestId("workspace-open-in-editor-chevron")
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(directoryEntryCalls).toEqual(["host-1"]);
    expect(directoryEntryCalls).not.toContain("effective-remote-host");
  });

  it("renders nothing without a local host", () => {
    editorState.hasLocalHost = false;
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    expect(screen.queryByTestId("workspace-open-in-editor")).toBeNull();
  });

  it("offers Open in Finder and dispatches the finder target when the gate is open", () => {
    editorState.finderAvailable = true;
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    fireEvent.pointerDown(
      screen.getByTestId("workspace-open-in-editor-chevron"),
      { button: 0 },
    );

    fireEvent.click(screen.getByTestId("workspace-open-in-editor-finder"));

    expect(editorState.mutate).toHaveBeenCalledWith({
      editorId: "finder",
      paths: ["/repo"],
    });
  });

  // The chevron itself disables while a launch is in flight, so the menu is
  // opened first and the pending state applied on a re-render - the same
  // sequence a user sees when an open starts from an already-open menu.
  it("swaps each launching item's icon for the spinner while opening, labels unchanged", () => {
    editorState.finderAvailable = true;
    const view = render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    fireEvent.pointerDown(
      screen.getByTestId("workspace-open-in-editor-chevron"),
      { button: 0 },
    );

    editorState.isPending = true;
    view.rerender(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    screen.getByTestId("workspace-open-in-editor-vscode-spinner");
    screen.getByTestId("workspace-open-in-editor-finder-spinner");
    // The label is the half that must NOT move.
    expect(
      screen.getByTestId("workspace-open-in-editor-vscode").textContent,
    ).toContain("VS Code");
    expect(
      screen.getByTestId("workspace-open-in-editor-finder").textContent,
    ).toContain("Open in Finder");
    // Copy path reaches no host, so it neither disables nor spins.
    expect(
      screen.queryByTestId("workspace-open-in-editor-copy-path-spinner"),
    ).toBeNull();
  });

  it("shows no spinner in the menu while idle", () => {
    editorState.finderAvailable = true;
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    fireEvent.pointerDown(
      screen.getByTestId("workspace-open-in-editor-chevron"),
      { button: 0 },
    );

    expect(
      screen.queryByTestId("workspace-open-in-editor-vscode-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("workspace-open-in-editor-finder-spinner"),
    ).toBeNull();
  });

  it("hides Open in Finder when the gate is closed, without hiding the rest of the menu", () => {
    editorState.finderAvailable = false;
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    fireEvent.pointerDown(
      screen.getByTestId("workspace-open-in-editor-chevron"),
      { button: 0 },
    );

    expect(screen.queryByTestId("workspace-open-in-editor-finder")).toBeNull();
    screen.getByTestId("workspace-open-in-editor-vscode");
    screen.getByTestId("workspace-open-in-editor-copy-path");
  });

  it("gates the vscodium menu item on the offer list, not merely on install detection", () => {
    // The install probe reports vscodium as available, but the host has not
    // negotiated the minor that lets the client tell it about that id - the
    // offer gate, not the probe, must be what keeps the item off the menu.
    editorState.availability = [
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "vscodium",
    ];
    editorState.offerableEditorIds = ["vscode", "cursor", "windsurf", "zed"];
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    fireEvent.pointerDown(
      screen.getByTestId("workspace-open-in-editor-chevron"),
      { button: 0 },
    );

    expect(
      screen.queryByTestId("workspace-open-in-editor-vscodium"),
    ).toBeNull();
  });

  it("shows the vscodium menu item once the host offers it and it is installed", () => {
    editorState.availability = [
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "vscodium",
    ];
    editorState.offerableEditorIds = [
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "vscodium",
    ];
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    fireEvent.pointerDown(
      screen.getByTestId("workspace-open-in-editor-chevron"),
      { button: 0 },
    );

    screen.getByTestId("workspace-open-in-editor-vscodium");
  });

  it("falls the primary button back off a stored vscodium default the host no longer offers", () => {
    // `defaultEditor` was persisted from before, or from a host that still
    // offers vscodium; this host's offer list has since narrowed and must
    // not be told to open an id it never advertised.
    useSettingsStore.setState({ defaultEditor: "vscodium" });
    editorState.availability = [
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "vscodium",
    ];
    editorState.offerableEditorIds = ["vscode", "cursor", "windsurf", "zed"];
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-open-in-editor-primary"));

    expect(editorState.mutate).toHaveBeenCalledWith({
      editorId: "vscode",
      paths: ["/repo"],
    });
  });
});
