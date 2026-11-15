import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpicsSortMenu } from "@/components/epics/epics-sort-menu";
import type { HistorySortOption } from "@/components/home/data/home-page.data";

function renderMenu(args: {
  value: HistorySortOption;
  createdSortAvailable: boolean;
}) {
  const onChange = vi.fn<(next: HistorySortOption) => void>();
  render(<EpicsSortMenu {...args} onChange={onChange} />);
  return onChange;
}

describe("EpicsSortMenu", () => {
  afterEach(cleanup);

  it("offers Newest created in place of Oldest", async () => {
    const user = userEvent.setup();
    renderMenu({ value: "recent", createdSortAvailable: true });

    await user.click(screen.getByRole("button", { name: /most recent/i }));

    expect(
      screen.getByRole("menuitemradio", { name: "Newest created" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "Oldest" })).toBeNull();
  });

  it("hides Newest created on a host that cannot order by creation", async () => {
    const user = userEvent.setup();
    renderMenu({ value: "recent", createdSortAvailable: false });

    await user.click(screen.getByRole("button", { name: /most recent/i }));

    expect(
      screen.queryByRole("menuitemradio", { name: "Newest created" }),
    ).toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: "Title A → Z" }),
    ).toBeTruthy();
  });

  it("keeps naming a saved oldest sort on the trigger", () => {
    renderMenu({ value: "oldest", createdSortAvailable: true });

    expect(screen.getByRole("button", { name: "Oldest" })).toBeTruthy();
  });

  it("reports created-desc when Newest created is picked", async () => {
    const user = userEvent.setup();
    const onChange = renderMenu({
      value: "recent",
      createdSortAvailable: true,
    });

    await user.click(screen.getByRole("button", { name: /most recent/i }));
    await user.click(
      screen.getByRole("menuitemradio", { name: "Newest created" }),
    );

    expect(onChange).toHaveBeenCalledExactlyOnceWith("created-desc");
  });
});
