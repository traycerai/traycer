import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HiddenTabsMenu } from "@/components/layout/tabs/hidden-tabs-menu";
import type { HeaderTab } from "@/stores/tabs/types";

vi.mock("@/components/layout/tabs/header-tab-presentation", () => ({
  useHeaderTabTitle: (tab: HeaderTab) => ({
    resolvedTabName: tab.name,
    displayName: tab.name,
  }),
}));

afterEach(cleanup);

function draft(id: string, name: string): HeaderTab {
  return {
    kind: "draft",
    id,
    route: `/draft/${id}`,
    name,
    icon: null,
    canDuplicate: false,
    canOpenInNewWindow: false,
  };
}

const TABS: ReadonlyArray<HeaderTab> = [
  draft("1", "Alpha task"),
  draft("2", "Beta task"),
  draft("3", "Gamma task"),
];

describe("<HiddenTabsMenu />", () => {
  it("renders nothing without hidden tabs", () => {
    const { container } = render(
      <HiddenTabsMenu tabs={[]} onActivate={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("labels the trigger with the singular or plural count", () => {
    const { rerender } = render(
      <HiddenTabsMenu tabs={[TABS[0]]} onActivate={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "1 hidden tab" })).toBeTruthy();
    rerender(<HiddenTabsMenu tabs={TABS} onActivate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "3 hidden tabs" })).toBeTruthy();
  });

  it("marks its wrapper so the hook can subtract the control's width", () => {
    const { container } = render(
      <HiddenTabsMenu tabs={TABS} onActivate={vi.fn()} />,
    );
    expect(
      container.querySelector("[data-hidden-tabs-control]"),
    ).not.toBeNull();
  });

  it("lists every hidden tab when opened", async () => {
    const user = userEvent.setup();
    render(<HiddenTabsMenu tabs={TABS} onActivate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "3 hidden tabs" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters by search text and shows the empty state", async () => {
    const user = userEvent.setup();
    render(<HiddenTabsMenu tabs={TABS} onActivate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "3 hidden tabs" }));
    const search = screen.getByRole("combobox", { name: "Search hidden tabs" });
    await user.type(search, "beta");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Beta task",
    ]);
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching tabs.")).toBeTruthy();
  });

  it("activates the clicked tab and closes the menu", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<HiddenTabsMenu tabs={TABS} onActivate={onActivate} />);
    await user.click(screen.getByRole("button", { name: "3 hidden tabs" }));
    await user.click(screen.getByRole("option", { name: "Gamma task" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(TABS[2]);
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("selects with the keyboard: type to filter, then Enter", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<HiddenTabsMenu tabs={TABS} onActivate={onActivate} />);
    await user.click(screen.getByRole("button", { name: "3 hidden tabs" }));
    await user.type(
      screen.getByRole("combobox", { name: "Search hidden tabs" }),
      "gamma{Enter}",
    );
    expect(onActivate).toHaveBeenCalledWith(TABS[2]);
  });

  it("selects with arrow keys and Enter", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<HiddenTabsMenu tabs={TABS} onActivate={onActivate} />);
    await user.click(screen.getByRole("button", { name: "3 hidden tabs" }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(TABS[1]);
  });

  it("returns focus to the trigger when dismissed with Escape", async () => {
    const user = userEvent.setup();
    render(<HiddenTabsMenu tabs={TABS} onActivate={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "3 hidden tabs" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
