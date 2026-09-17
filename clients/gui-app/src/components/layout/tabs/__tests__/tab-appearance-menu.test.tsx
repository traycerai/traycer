import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TabAppearanceMenu } from "../tab-appearance-menu";
import { TabGroupChip } from "../tab-group-chip";
import { useTabsStore } from "@/stores/tabs/store";
import type { HeaderTab } from "@/stores/tabs/types";

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), open: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigation.navigate,
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: navigation.open,
}));
vi.mock("@/lib/commands/actions/new-epic", () => ({
  openNewEpicIntent: () => ({ kind: "new-epic" }),
}));

const TAB: HeaderTab = {
  kind: "epic",
  id: "tab-a",
  epicId: "epic-a",
  hostId: null,
  route: "/epics/epic-a",
  name: "Alpha",
  icon: null,
  canClose: true,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

function renderMenu(): void {
  render(
    <ContextMenu open>
      <ContextMenuTrigger>Open</ContextMenuTrigger>
      <ContextMenuContent>
        <TabAppearanceMenu tab={TAB} />
      </ContextMenuContent>
    </ContextMenu>,
  );
}

describe("tab appearance and grouping controls", () => {
  beforeEach(() => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useTabsStore.setState({
      items: [
        {
          kind: "tab",
          id: "tab:epic:tab-a",
          ref: { kind: "epic", id: "tab-a" },
        },
      ],
      stripOrder: [{ kind: "epic", id: "tab-a" }],
      groups: {
        existing: { name: "Existing", color: "#81c995", collapsed: false },
      },
    });
  });
  afterEach(() => cleanup());

  it("shows the appearance submenu and stores a color and manual icon", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Tab appearance"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Blue" }));
    fireEvent.click(screen.getByText("Edit icon…"));
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Tab icon" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Tab icon" }), {
      target: { value: "★" },
    });
    const customization =
      useTabsStore.getState().customizations?.["epic:tab-a"];
    expect(customization).toMatchObject({ color: "#8ab4f8", icon: "★" });
  });

  it("stores a custom tab color from the appearance submenu", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Tab appearance"));
    fireEvent.change(screen.getByLabelText("Custom tab color"), {
      target: { value: "#123456" },
    });

    expect(useTabsStore.getState().customizations?.["epic:tab-a"]?.color).toBe(
      "#123456",
    );
  });

  it("creates a group and supports removing the tab from it", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Add tab to group"));
    fireEvent.click(screen.getByText("New group"));
    const groupId =
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId;
    expect(groupId).toBeTruthy();
    fireEvent.click(screen.getByText("Remove from group"));
    expect(
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId,
    ).toBeNull();
  });

  it("adds a tab to an existing group", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Add tab to group"));
    fireEvent.click(screen.getByText("Existing"));
    expect(
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId,
    ).toBe("existing");
  });

  it("collapses and edits a group, including group actions", () => {
    const group = {
      name: "Alpha",
      color: "#8ab4f8",
      collapsed: false,
    } as const;
    useTabsStore.setState({
      groups: { group },
      customizations: {
        "epic:tab-a": { color: null, icon: null, groupId: "group" },
      },
    });
    const close = vi.fn();
    render(<TabGroupChip groupId="group" group={group} onClose={close} />);
    const chip = screen.getByRole("button", { name: /Alpha: collapse group/ });
    fireEvent.click(chip);
    expect(useTabsStore.getState().groups?.group.collapsed).toBe(true);
    fireEvent.contextMenu(chip);
    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
      target: { value: "Renamed" },
    });
    expect(useTabsStore.getState().groups?.group.name).toBe("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));
    expect(
      useTabsStore.getState().customizations?.["epic:tab-a"]?.groupId,
    ).toBeNull();
    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByRole("button", { name: "New tab in group" }));
    expect(navigation.open).toHaveBeenCalled();
    fireEvent.contextMenu(chip);
    fireEvent.click(screen.getByRole("button", { name: "Close group" }));
    expect(close).toHaveBeenCalledWith("group");
  });

  it("stores a custom color from the group color picker", () => {
    const group = {
      name: "Alpha",
      color: "#8ab4f8",
      collapsed: false,
    } as const;
    useTabsStore.setState({
      groups: { group },
      customizations: {
        "epic:tab-a": { color: null, icon: null, groupId: "group" },
      },
    });
    const close = vi.fn();
    render(<TabGroupChip groupId="group" group={group} onClose={close} />);
    fireEvent.contextMenu(
      screen.getByRole("button", { name: /Alpha: collapse group/ }),
    );
    fireEvent.change(screen.getByLabelText("Custom tab color"), {
      target: { value: "#123456" },
    });

    expect(useTabsStore.getState().groups?.group.color).toBe("#123456");
  });
});
