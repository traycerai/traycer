import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspacePickerWithOpener } from "../workspace-picker-with-opener";

const editorState = vi.hoisted(() => ({
  availability: ["vscode", "cursor", "windsurf", "zed"],
  hasLocalHost: true,
  activeHostId: "host-1",
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/editor/use-editor-availability-query", () => ({
  useEditorAvailability: () => ({ data: editorState.availability }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ hasLocalHost: editorState.hasLocalHost }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => editorState.activeHostId,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId.length > 0 ? { kind: "local" } : null,
}));

describe("<WorkspacePickerWithOpener />", () => {
  beforeEach(() => {
    cleanup();
    editorState.availability = ["vscode", "cursor", "windsurf", "zed"];
    editorState.hasLocalHost = true;
    editorState.activeHostId = "host-1";
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the picker slot", () => {
    render(
      <WorkspacePickerWithOpener
        picker={<div data-testid="picker-slot">picker</div>}
        openTarget={null}
      />,
    );

    expect(screen.getByTestId("picker-slot")).toBeDefined();
  });

  it("disables the opener when there is no open target", () => {
    render(
      <WorkspacePickerWithOpener
        picker={<div data-testid="picker-slot">picker</div>}
        openTarget={null}
      />,
    );

    expect(
      screen
        .getByTestId("workspace-open-in-editor-primary")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("enables the opener when the target is on the active local host", () => {
    render(
      <WorkspacePickerWithOpener
        picker={<div data-testid="picker-slot">picker</div>}
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
      />,
    );

    expect(
      screen
        .getByTestId("workspace-open-in-editor-primary")
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
