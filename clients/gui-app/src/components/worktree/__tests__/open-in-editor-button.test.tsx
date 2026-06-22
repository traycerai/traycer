import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { OpenInEditorButton } from "../open-in-editor-button";
import { useSettingsStore } from "@/stores/settings/settings-store";

const editorState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  availability: ["vscode", "cursor", "windsurf", "zed"],
  hasLocalHost: true,
  activeHostId: "host-1",
  activeHostKind: "local",
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({
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

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => editorState.activeHostId,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId.length > 0 ? { kind: editorState.activeHostKind } : null,
}));

describe("<OpenInEditorButton />", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    editorState.mutate.mockClear();
    editorState.isPending = false;
    editorState.availability = ["vscode", "cursor", "windsurf", "zed"];
    editorState.hasLocalHost = true;
    editorState.activeHostId = "host-1";
    editorState.activeHostKind = "local";
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
    render(<OpenInEditorButton openTarget={null} />);

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

  it("disables the controls when the target host is not the active host", () => {
    editorState.activeHostId = "host-2";
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
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
  });

  it("disables the controls when the active host is not local", () => {
    editorState.activeHostKind = "remote";
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
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

  it("renders nothing without a local host", () => {
    editorState.hasLocalHost = false;
    render(
      <OpenInEditorButton
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
      />,
    );

    expect(screen.queryByTestId("workspace-open-in-editor")).toBeNull();
  });
});
