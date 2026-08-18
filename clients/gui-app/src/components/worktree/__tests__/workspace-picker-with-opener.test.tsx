import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspacePickerWithOpener } from "../workspace-picker-with-opener";

const editorState = vi.hoisted(() => ({
  availability: ["vscode", "cursor", "windsurf", "zed"],
  hasLocalHost: true,
}));

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpenForClient: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/editor/use-editor-availability-query", () => ({
  useEditorAvailability: () => ({ data: editorState.availability }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ hasLocalHost: editorState.hasLocalHost }),
}));

// `OpenInEditorButton` (rendered inside this picker) gates on the open
// TARGET's own host directory entry now (Y6), not any app-wide "effective"
// or "active" host - no such hook is mocked here.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string) =>
    hostId.length > 0 ? { kind: "local" } : null,
}));

describe("<WorkspacePickerWithOpener />", () => {
  beforeEach(() => {
    cleanup();
    editorState.availability = ["vscode", "cursor", "windsurf", "zed"];
    editorState.hasLocalHost = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the picker slot", () => {
    render(
      <WorkspacePickerWithOpener
        picker={<div data-testid="picker-slot">picker</div>}
        openTarget={null}
        hostClient={null}
      />,
    );

    expect(screen.getByTestId("picker-slot")).toBeDefined();
  });

  it("disables the opener when there is no open target", () => {
    render(
      <WorkspacePickerWithOpener
        picker={<div data-testid="picker-slot">picker</div>}
        openTarget={null}
        hostClient={null}
      />,
    );

    expect(
      screen
        .getByTestId("workspace-open-in-editor-primary")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("enables the opener when the target's own host is local", () => {
    render(
      <WorkspacePickerWithOpener
        picker={<div data-testid="picker-slot">picker</div>}
        openTarget={{ workspacePath: "/repo", hostId: "host-1" }}
        hostClient={null}
      />,
    );

    expect(
      screen
        .getByTestId("workspace-open-in-editor-primary")
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
