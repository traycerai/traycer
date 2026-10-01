import { useState, type RefObject } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const NO_FALLBACK: RefObject<HTMLElement | null> = { current: null };

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
  it("keeps an empty fixed-width slot with no button, portal or focus target", () => {
    const { container } = render(
      <HiddenTabsMenu
        side="right"
        fallbackFocusRef={NO_FALLBACK}
        tabs={[]}
        onActivate={vi.fn()}
      />,
    );
    const slot = container.querySelector("[data-hidden-tabs-control]");
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute("data-hidden-tabs-control")).toBe("right");
    expect(screen.queryByRole("button")).toBeNull();
    expect(slot?.querySelector("[tabindex],button,a,input")).toBeNull();
  });

  it("labels the icon-only trigger per side, with no visible count", () => {
    const { rerender } = render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={vi.fn()}
      />,
    );
    const left = screen.getByRole("button", {
      name: "Tabs hidden to the left",
    });
    expect(left.textContent).toBe("");
    rerender(
      <HiddenTabsMenu
        side="right"
        fallbackFocusRef={NO_FALLBACK}
        tabs={[TABS[0]]}
        onActivate={vi.fn()}
      />,
    );
    const right = screen.getByRole("button", {
      name: "Tabs hidden to the right",
    });
    expect(right.textContent).toBe("");
    expect(
      screen.queryByRole("button", { name: "Tabs hidden to the left" }),
    ).toBeNull();
  });

  it("marks its wrapper with its side so the hook can sum both footprints", () => {
    const { container } = render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={vi.fn()}
      />,
    );
    expect(
      container
        .querySelector("[data-hidden-tabs-control]")
        ?.getAttribute("data-hidden-tabs-control"),
    ).toBe("left");
  });

  it("lists only the tabs of its own side", async () => {
    const user = userEvent.setup();
    render(
      <>
        <HiddenTabsMenu
          side="left"
          fallbackFocusRef={NO_FALLBACK}
          tabs={[TABS[0]]}
          onActivate={vi.fn()}
        />
        <HiddenTabsMenu
          side="right"
          fallbackFocusRef={NO_FALLBACK}
          tabs={[TABS[1], TABS[2]]}
          onActivate={vi.fn()}
        />
      </>,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the right" }),
    );
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Beta task",
      "Gamma task",
    ]);
  });

  it("lists every hidden tab when opened", async () => {
    const user = userEvent.setup();
    render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the left" }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters by search text and shows the empty state", async () => {
    const user = userEvent.setup();
    render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the left" }),
    );
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
    render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={onActivate}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the left" }),
    );
    await user.click(screen.getByRole("option", { name: "Gamma task" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(TABS[2]);
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("selects with the keyboard: type to filter, then Enter", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={onActivate}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the left" }),
    );
    await user.type(
      screen.getByRole("combobox", { name: "Search hidden tabs" }),
      "gamma{Enter}",
    );
    expect(onActivate).toHaveBeenCalledWith(TABS[2]);
  });

  it("selects with arrow keys and Enter", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={onActivate}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the left" }),
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(TABS[1]);
  });

  it("returns focus to the trigger when dismissed with Escape", async () => {
    const user = userEvent.setup();
    render(
      <HiddenTabsMenu
        side="left"
        fallbackFocusRef={NO_FALLBACK}
        tabs={TABS}
        onActivate={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Tabs hidden to the left",
    });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps focus on the revealed tab and the slot when activating the last hidden tab removes the trigger", async () => {
    const user = userEvent.setup();
    function Host() {
      const [tabs, setTabs] = useState<ReadonlyArray<HeaderTab>>([TABS[0]]);
      return (
        <>
          <button type="button" data-testid="visible-tab">
            visible
          </button>
          <HiddenTabsMenu
            side="left"
            fallbackFocusRef={NO_FALLBACK}
            tabs={tabs}
            onActivate={() => {
              setTabs([]);
              screen.getByTestId("visible-tab").focus();
            }}
          />
        </>
      );
    }
    const { container } = render(<Host />);
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the left" }),
    );
    await user.click(screen.getByRole("option", { name: "Alpha task" }));
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(
      screen.queryByRole("button", { name: "Tabs hidden to the left" }),
    ).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("visible-tab"));
    expect(
      container.querySelector('[data-hidden-tabs-control="left"]'),
    ).not.toBeNull();
  });

  function EmptyWhileOpen(props: {
    readonly tabs: ReadonlyArray<HeaderTab>;
    readonly fallback: RefObject<HTMLElement | null>;
  }) {
    return (
      <>
        <div
          ref={(element) => {
            props.fallback.current = element;
          }}
          tabIndex={-1}
          data-testid="tablist"
        />
        <button type="button" data-testid="outside">
          outside
        </button>
        <HiddenTabsMenu
          side="right"
          fallbackFocusRef={props.fallback}
          tabs={props.tabs}
          onActivate={vi.fn()}
        />
      </>
    );
  }

  it("closes cleanly when its side empties while open, focuses the fallback, and stays closed when tabs return", async () => {
    const user = userEvent.setup();
    const fallback: RefObject<HTMLElement | null> = { current: null };
    const { container, rerender } = render(
      <EmptyWhileOpen tabs={TABS} fallback={fallback} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the right" }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(3);
    rerender(<EmptyWhileOpen tabs={[]} fallback={fallback} />);
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(screen.queryByRole("button", { name: /Tabs hidden/ })).toBeNull();
    expect(
      container.querySelector('[data-hidden-tabs-control="right"]'),
    ).not.toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("tablist")),
    );
    rerender(<EmptyWhileOpen tabs={TABS} fallback={fallback} />);
    expect(screen.queryByRole("option")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Tabs hidden to the right" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("does not steal focus that already moved outside when the side empties", async () => {
    const user = userEvent.setup();
    const fallback: RefObject<HTMLElement | null> = { current: null };
    const { rerender } = render(
      <EmptyWhileOpen tabs={TABS} fallback={fallback} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Tabs hidden to the right" }),
    );
    const outside = screen.getByTestId("outside");
    outside.focus();
    rerender(<EmptyWhileOpen tabs={[]} fallback={fallback} />);
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(document.activeElement).toBe(outside);
  });
});
