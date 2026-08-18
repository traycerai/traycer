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
import { OpenInEditorButton } from "../open-in-editor-button";
import { useSettingsStore } from "@/stores/settings/settings-store";

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
}

const editorState = vi.hoisted((): EditorButtonTestState => ({
  mutate: vi.fn(),
  isPending: false,
  availability: ["vscode", "cursor", "windsurf", "zed"],
  hasLocalHost: true,
  hostKindByHostId: { "host-1": "local" },
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

describe("<OpenInEditorButton />", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    editorState.mutate.mockClear();
    editorState.isPending = false;
    editorState.availability = ["vscode", "cursor", "windsurf", "zed"];
    editorState.hasLocalHost = true;
    editorState.hostKindByHostId = { "host-1": "local" };
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
});
