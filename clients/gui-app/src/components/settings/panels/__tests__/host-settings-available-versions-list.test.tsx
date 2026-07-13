import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { AvailableVersionsList } from "../host-settings-available-versions-list";

function renderErrorState(errorMessage: string): void {
  render(
    <AvailableVersionsList
      availableSnapshot={undefined}
      visibleVersions={[]}
      installedVersion={null}
      isPending={false}
      errorMessage={errorMessage}
      fetching={false}
      anyPending={false}
      showAllVersions={false}
      onToggleShowAll={() => undefined}
      onInstallVersion={() => undefined}
      onRetry={() => undefined}
    />,
  );
}

describe("<AvailableVersionsList /> registry failure report action", () => {
  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("hides the report action when the support capability is unavailable", () => {
    renderErrorState("secret-token-should-never-render");

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context, never the raw registry error", () => {
    renderErrorState("secret-token-should-never-render /Users/hostile/path");

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load host versions",
        message: "The host version registry could not be loaded.",
        code: null,
        source: "Host versions",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("/Users/hostile/path");
  });
});
