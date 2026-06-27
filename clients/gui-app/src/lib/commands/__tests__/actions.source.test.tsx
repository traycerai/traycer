import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { actionsSource } from "@/lib/commands/sources/actions.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { ACTION_META, getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";

function ctx(): CommandContext {
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
    captured = actionsSource.useItems(ctx());
    return null;
  }
  render(<Probe />);
  return captured;
}

describe("actionsSource", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  afterEach(() => {
    cleanup();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
  });

  it("emits one item per chord-kind action and skips digit-kind ones", () => {
    const items = captureItems();
    for (const item of items) {
      expect(item.actionId).not.toBeNull();
      if (item.actionId !== null) {
        expect(ACTION_META[item.actionId].kind).toBe("chord");
      }
    }
    const ids = items.map((item) => item.id);
    expect(ids).not.toContain("action:epic.switch.byDigit");
    expect(ids).not.toContain("action:tab.switch.byDigit");
    expect(ids).not.toContain("action:app.settings.section.byDigit");
  });

  it("skips the app.palette.open action (loop prevention)", () => {
    const ids = captureItems().map((item) => item.id);
    expect(ids).not.toContain("action:app.palette.open");
  });

  it("reads the live shortcut from the keybinding store", () => {
    useKeybindingStore.getState().setBinding("app.settings.open", "mod+alt+s");
    const item = captureItems().find(
      (row) => row.id === "action:app.settings.open",
    );
    expect(item).toBeDefined();
    expect(item?.shortcut).toBe("mod+alt+s");
  });

  it("reflects an unbound action with a null shortcut", () => {
    useKeybindingStore.getState().clearBinding("app.settings.open");
    const item = captureItems().find(
      (row) => row.id === "action:app.settings.open",
    );
    expect(item?.shortcut).toBeNull();
  });
});
