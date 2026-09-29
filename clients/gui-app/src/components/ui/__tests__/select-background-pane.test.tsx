import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PresentationLossDetails } from "@/components/ui/closing-overlay-presentation";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";

afterEach(cleanup);

const HOST_ITEMS = {
  "host-a": "Hardiks-MacBook-Pro",
  "host-b": "Other-Host",
};

function HostSelect(): React.JSX.Element {
  return (
    <Select items={HOST_ITEMS} value="host-a" onValueChange={() => undefined}>
      <SelectTrigger aria-label="Host">
        <SelectValue placeholder="Local" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="host-a">Hardiks-MacBook-Pro</SelectItem>
        <SelectItem value="host-b">Other-Host</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("<Select /> inside a background split pane", () => {
  it("keeps the selected value's label on the trigger while the pane is unfocused", () => {
    // Base's `<Select.Value>` renders the label straight out of the `items`
    // map by the selected `value`, independent of whether the popup's content
    // is open, closed, or even mounted at all - unlike Radix, there is no
    // portal-out-of-closed-content mechanism left to preserve. A background
    // pane that un-presents the popup therefore can't blank the trigger; that
    // is how a split pane used to lose its host name while still showing the
    // chevron.
    render(
      <SurfacePresentationBoundary visible focused={false}>
        <HostSelect />
      </SurfacePresentationBoundary>,
    );

    expect(screen.getByLabelText("Host").textContent).toContain(
      "Hardiks-MacBook-Pro",
    );
    expect(screen.getByLabelText("Host").textContent).not.toContain("Local");
  });

  it("still shows it while the pane is focused", () => {
    render(
      <SurfacePresentationBoundary visible focused>
        <HostSelect />
      </SurfacePresentationBoundary>,
    );

    expect(screen.getByLabelText("Host").textContent).toContain(
      "Hardiks-MacBook-Pro",
    );
  });

  it("does not present an open menu from a background pane", () => {
    // D13: DropdownMenu, ContextMenu and Select genuinely close on
    // presentation loss - `useClosingOverlay`'s `present = !concealed &&
    // paneFocused` gate forces `open` false the instant the pane is
    // unfocused, before this ever reaches Base's own open state. That is what
    // must not survive the pane going to the background (an open Select
    // otherwise drives a focus trap and a document-wide scroll lock).
    render(
      <SurfacePresentationBoundary visible focused={false}>
        <Select
          items={HOST_ITEMS}
          defaultOpen
          value="host-a"
          onValueChange={() => undefined}
        >
          <SelectTrigger aria-label="Host">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="host-a">Hardiks-MacBook-Pro</SelectItem>
            <SelectItem value="host-b">Other-Host</SelectItem>
          </SelectContent>
        </Select>
      </SurfacePresentationBoundary>,
    );

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("option", { name: "Other-Host" })).toBeNull();
  });

  it("does not spring back open when the pane regains focus", () => {
    // D13: unlike the old Radix-era guard (which relied on a component-local
    // `wasPaneFocused` flag because Radix never called `onOpenChange` for
    // this close), the wrapper now genuinely closes the uncontrolled state
    // itself - `useClosingOverlay` calls `setInternalOpen(false)` the instant
    // the pane un-presents - and separately fires exactly one mandatory,
    // non-cancellable `reason: "presentation-loss"` notification. A later
    // refocus only re-presents whatever is still logically open, which is
    // now nothing, so there is no state left to "spring back".
    const onOpenChange: Mock<
      (
        open: boolean,
        details:
          | PresentationLossDetails
          | SelectPrimitive.Root.ChangeEventDetails,
      ) => void
    > = vi.fn();
    const { rerender } = render(
      <SurfacePresentationBoundary visible focused>
        <Select
          items={HOST_ITEMS}
          defaultOpen
          value="host-a"
          onValueChange={() => undefined}
          onOpenChange={onOpenChange}
        >
          <SelectTrigger aria-label="Host">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="host-a">Hardiks-MacBook-Pro</SelectItem>
            <SelectItem value="host-b">Other-Host</SelectItem>
          </SelectContent>
        </Select>
      </SurfacePresentationBoundary>,
    );

    rerender(
      <SurfacePresentationBoundary visible focused={false}>
        <Select
          items={HOST_ITEMS}
          defaultOpen
          value="host-a"
          onValueChange={() => undefined}
          onOpenChange={onOpenChange}
        >
          <SelectTrigger aria-label="Host">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="host-a">Hardiks-MacBook-Pro</SelectItem>
            <SelectItem value="host-b">Other-Host</SelectItem>
          </SelectContent>
        </Select>
      </SurfacePresentationBoundary>,
    );

    // The genuine close is mandatory and non-cancellable: exactly one
    // presentation-loss notification, with no `cancel()` on its details.
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        reason: "presentation-loss",
        cause: "pane-blur",
      }),
    );
    const details = onOpenChange.mock.calls[0]?.[1];
    expect(details.event).toBeInstanceOf(Event);
    expect(Reflect.has(details, "cancel")).toBe(false);

    rerender(
      <SurfacePresentationBoundary visible focused>
        <Select
          items={HOST_ITEMS}
          defaultOpen
          value="host-a"
          onValueChange={() => undefined}
          onOpenChange={onOpenChange}
        >
          <SelectTrigger aria-label="Host">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="host-a">Hardiks-MacBook-Pro</SelectItem>
            <SelectItem value="host-b">Other-Host</SelectItem>
          </SelectContent>
        </Select>
      </SurfacePresentationBoundary>,
    );

    // Returning focus must not re-open and must not fire a second
    // notification - the close is permanent for this cycle.
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
