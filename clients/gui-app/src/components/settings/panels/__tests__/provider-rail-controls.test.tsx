/**
 * The rail's search + status control, driven against the REAL Radix dropdown.
 *
 * Deliberately not folded into providers-settings-panel.test: that suite
 * replaces the dropdown module with an always-open passthrough, so a status
 * selection there would only ever prove the stand-in works. Everything this
 * component owns is host-free, so it renders on its own with no provider hooks.
 */
import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProviderRailControls } from "@/components/settings/panels/provider-rail-controls";
import {
  DEFAULT_PROVIDER_RAIL_VIEW,
  PROVIDER_RAIL_STATUS,
  type ProviderRailView,
} from "@/components/settings/panels/provider-rail-filter";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(() => cleanup());

/** Controlled host, so the assertions see what a real parent would render. */
function Harness(props: {
  readonly initial: ProviderRailView;
  readonly onViewChange: (view: ProviderRailView) => void;
  readonly resultCount: number;
}) {
  const [view, setView] = useState(props.initial);
  return (
    <TooltipProvider>
      <ProviderRailControls
        view={view}
        onViewChange={(next) => {
          setView(next);
          props.onViewChange(next);
        }}
        resultCount={props.resultCount}
      />
    </TooltipProvider>
  );
}

type ViewChangeSpy = Mock<(view: ProviderRailView) => void>;

function renderControls(input: {
  readonly initial: ProviderRailView;
  readonly resultCount: number;
}): { readonly onViewChange: ViewChangeSpy } {
  const onViewChange: ViewChangeSpy = vi.fn();
  render(
    <Harness
      initial={input.initial}
      onViewChange={onViewChange}
      resultCount={input.resultCount}
    />,
  );
  return { onViewChange };
}

function openFilterMenu(): void {
  // Radix opens on pointerdown, not click - firing only `click` leaves the
  // menu shut and every following query passing vacuously.
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /^Filter providers/ }),
    { button: 0, ctrlKey: false, pointerType: "mouse" },
  );
}

describe("<ProviderRailControls />", () => {
  it("reports typing through onViewChange without touching the status", () => {
    const { onViewChange } = renderControls({
      initial: DEFAULT_PROVIDER_RAIL_VIEW,
      resultCount: 18,
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search providers" }),
      {
        target: { value: "kimi" },
      },
    );

    expect(onViewChange).toHaveBeenCalledWith({
      query: "kimi",
      status: PROVIDER_RAIL_STATUS.All,
    });
  });

  it("offers no clear button until there is something to clear", () => {
    renderControls({ initial: DEFAULT_PROVIDER_RAIL_VIEW, resultCount: 18 });
    expect(
      screen.queryByRole("button", { name: "Clear provider search" }),
    ).toBeNull();
  });

  it("clears the query but keeps the status filter", () => {
    const { onViewChange } = renderControls({
      initial: { query: "kimi", status: PROVIDER_RAIL_STATUS.Enabled },
      resultCount: 1,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Clear provider search" }),
    );

    // Clearing the text must not silently reset the other axis - the dot on the
    // filter trigger would stay lit while the rail showed everything.
    expect(onViewChange).toHaveBeenCalledWith({
      query: "",
      status: PROVIDER_RAIL_STATUS.Enabled,
    });
  });

  it("does not act on Escape at all", () => {
    const { onViewChange } = renderControls({
      initial: { query: "kimi", status: PROVIDER_RAIL_STATUS.All },
      resultCount: 1,
    });

    const notPrevented = fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search providers" }),
      { key: "Escape" },
    );

    expect(notPrevented).toBe(true);
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("leaves Escape alone inside a real Settings dialog", () => {
    // Against a REAL Radix Dialog, not a hand-rolled document listener. Radix
    // registers its Escape hook on the document with `capture: true`, so it
    // runs BEFORE anything this component could do from a React bubble
    // handler - a `stopPropagation()` here would still let the dialog close
    // and additionally eat the query, which is the worst of both.
    const onOpenChange = vi.fn();
    const onViewChange = vi.fn();
    render(
      <DialogPrimitive.Root open onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content aria-describedby={undefined}>
            <DialogPrimitive.Title>Settings</DialogPrimitive.Title>
            <Harness
              initial={{ query: "kimi", status: PROVIDER_RAIL_STATUS.All }}
              onViewChange={onViewChange}
              resultCount={1}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>,
    );

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search providers" }),
      { key: "Escape" },
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("selects a status through the menu", () => {
    const { onViewChange } = renderControls({
      initial: DEFAULT_PROVIDER_RAIL_VIEW,
      resultCount: 18,
    });

    openFilterMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Disabled" }));

    expect(onViewChange).toHaveBeenCalledWith({
      query: "",
      status: PROVIDER_RAIL_STATUS.Disabled,
    });
  });

  it("marks the active status as checked in the menu", () => {
    renderControls({
      initial: { query: "", status: PROVIDER_RAIL_STATUS.Enabled },
      resultCount: 3,
    });

    openFilterMenu();
    const checked = screen
      .getAllByRole("menuitemradio")
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map((item) => item.textContent);
    expect(checked).toEqual(["Enabled"]);
  });

  it("names the current status in the trigger, so it is readable while shut", () => {
    renderControls({
      initial: { query: "", status: PROVIDER_RAIL_STATUS.Disabled },
      resultCount: 2,
    });

    // The dot beside the icon is `aria-hidden`; without this the only thing a
    // screen reader gets from a filtered rail is the word "Filter".
    expect(
      screen.getByRole("button", {
        name: "Filter providers, showing disabled",
      }),
    ).toBeDefined();
  });

  it("stays silent while the rail is unfiltered", () => {
    // An unfiltered rail is the resting state; announcing "18 providers shown"
    // on open would make the live region chatter about nothing having happened.
    renderControls({ initial: DEFAULT_PROVIDER_RAIL_VIEW, resultCount: 18 });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("announces the count once the rail is showing a subset", () => {
    renderControls({
      initial: { query: "code", status: PROVIDER_RAIL_STATUS.All },
      resultCount: 4,
    });
    expect(screen.getByRole("status").textContent).toBe("4 providers shown.");
  });

  it("announces a status-only filter too, with no query typed", () => {
    renderControls({
      initial: { query: "", status: PROVIDER_RAIL_STATUS.Enabled },
      resultCount: 15,
    });
    expect(screen.getByRole("status").textContent).toBe("15 providers shown.");
  });

  it("says nothing matched rather than announcing zero results", () => {
    renderControls({
      initial: { query: "zzz", status: PROVIDER_RAIL_STATUS.All },
      resultCount: 0,
    });
    expect(screen.getByRole("status").textContent).toBe("No providers match.");
  });

  it("uses the singular for one result", () => {
    renderControls({
      initial: { query: "kimi", status: PROVIDER_RAIL_STATUS.All },
      resultCount: 1,
    });
    expect(screen.getByRole("status").textContent).toBe("1 provider shown.");
  });
});
