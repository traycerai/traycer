import "../../../../__tests__/test-browser-apis";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { helpSource } from "@/lib/commands/sources/help.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

function context(): CommandContext {
  return {
    pathname: "/",
    router: {
      getPathname: () => "/",
      navigateHome: () => undefined,
      navigateSettings: () => undefined,
      navigateToEpic: () => undefined,
      navigateToEpicTab: () => undefined,
      navigateToEpicList: () => undefined,
      navigateSettingsSection: () => undefined,
      navigateToTabIntent: () => undefined,
      goBack: () => undefined,
      goForward: () => undefined,
      isHistoryNavAvailable: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
    },
    activeTabId: null,
    activeEpicId: null,
    focusedComposerKind: null,
    targetGroupId: null,
  };
}

function captureItems(): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = helpSource.useItems(context());
    return null;
  }
  render(<Probe />);
  return captured;
}

afterEach(() => {
  cleanup();
  useDesktopDialogStore.getState().close();
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
});

describe("helpSource", () => {
  it("omits report issue when desktop support is unavailable", () => {
    expect(captureItems().map((item) => item.id)).toEqual(["help:keybindings"]);
  });

  it("offers report issue when desktop support is available", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const items = captureItems();
    const reportIssue = items.find((item) => item.id === "help:report-issue");

    expect(reportIssue).toBeDefined();
    void reportIssue?.run(context());
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
  });

  it("rechecks support before running a previously visible command", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    const reportIssue = captureItems().find(
      (item) => item.id === "help:report-issue",
    );
    cleanup();
    useDesktopDialogStore.setState({ reportIssueAvailable: false });

    void reportIssue?.run(context());

    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
  });
});
