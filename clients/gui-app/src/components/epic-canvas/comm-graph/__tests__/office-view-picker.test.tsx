/**
 * `OfficeViewPicker` is pure - a `choice` in, a trigger label and a radio
 * group of test-id'd rows out. This suite pins its text contract and that
 * `onChoose` reports exactly what was clicked, over the four views the app
 * actually offers (`OFFICE_VIEW_CHOICES`): Floor, Building, Mission control,
 * Campus. Auto, Towers and City are retired layout ids kept readable for
 * migration only (see `office-view-vocabulary.ts`) - they are not offered
 * here and have no row.
 */
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({
    resolvedTheme: "light" as const,
    themePreset: "default",
  }),
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeViewPicker } from "@/components/epic-canvas/comm-graph/office/office-view-picker";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import { OFFICE_VIEW_CHOICES } from "@/lib/comm-graph/office/office-view-vocabulary";
import type { OfficeViewChoice } from "@/stores/epics/canvas/types";

function openPicker(): void {
  // Radix opens on pointerdown, not click - a bare click leaves the menu shut
  // and every following query passes vacuously.
  fireEvent.pointerDown(screen.getByTestId("comm-graph-office-view-picker"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function renderPicker(props: {
  readonly choice: OfficeViewChoice;
  readonly onChoose: (choice: OfficeViewChoice) => void;
}) {
  return render(
    <OfficeViewPicker choice={props.choice} onChoose={props.onChoose} />,
  );
}

afterEach(() => cleanup());

describe("OfficeViewPicker", () => {
  it.each(OFFICE_VIEW_CHOICES)(
    "labels the trigger with %s's own label",
    (choice) => {
      renderPicker({ choice, onChoose: vi.fn() });

      expect(
        screen.getByTestId("comm-graph-office-view-picker").textContent,
      ).toBe(OFFICE_VIEWS[choice].label);
    },
  );

  it("lists exactly the four offered views, each with its label and description, and offers no Auto/Towers/City row", () => {
    renderPicker({ choice: "floor", onChoose: vi.fn() });

    openPicker();

    for (const id of OFFICE_VIEW_CHOICES) {
      const row = screen.getByTestId(`comm-graph-office-view-${id}`);
      expect(row.textContent).toBe(
        `${OFFICE_VIEWS[id].label}${OFFICE_VIEWS[id].description}`,
      );
    }
    expect(screen.queryByTestId("comm-graph-office-view-auto")).toBeNull();
    expect(screen.queryByTestId("comm-graph-office-view-towers")).toBeNull();
    expect(screen.queryByTestId("comm-graph-office-view-city")).toBeNull();
  });

  it("reports the chosen id through onChoose", () => {
    const onChoose = vi.fn();
    renderPicker({ choice: "floor", onChoose });

    openPicker();
    fireEvent.click(screen.getByTestId("comm-graph-office-view-campus"));

    expect(onChoose).toHaveBeenCalledWith("campus");
  });

  it("sizes the open menu independently of the trigger width, with a fluid width and a tokenized cap (Finding 14)", () => {
    // The shadcn DropdownMenuContent base pins `w` to the trigger. A
    // `max-w-[min(90vw,22rem)]` on the picker never displaced that, so
    // every description wrapped to four or five lines. `w-[90vw]` is the
    // explicit width that DOES displace the trigger pin (`cn` keeps the
    // last `w-*` and drops the base var); `max-w-sm` is the
    // tokenized ceiling the fluid-sizing rule asks for on a wide screen -
    // layout itself is not asserted here because jsdom does not compute it.
    renderPicker({ choice: "building", onChoose: vi.fn() });

    openPicker();

    const classes = screen.getByRole("menu").className.split(/\s+/);
    expect(classes).toContain("w-[90vw]");
    expect(classes).toContain("max-w-sm");
    expect(classes).not.toContain("w-(--radix-dropdown-menu-trigger-width)");
  });
});
