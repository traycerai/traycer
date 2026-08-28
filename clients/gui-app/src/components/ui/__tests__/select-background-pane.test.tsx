import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";

afterEach(cleanup);

function HostSelect(): React.JSX.Element {
  return (
    <Select value="host-a" onValueChange={() => undefined}>
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
    // Radix renders CLOSED content into a DocumentFragment and portals the
    // selected `SelectItemText` out of it into the trigger's value node. A
    // background pane that un-presents by unmounting the content therefore
    // blanks the trigger - and the placeholder cannot cover it, because Radix
    // suppresses the placeholder whenever `value` is set. That is how a split
    // pane lost its host name while still showing the chevron.
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
    // The reason the guard exists: an open Select drives a focus trap,
    // `hideOthers` and a scroll lock document-wide, which must not survive the
    // pane going to the background. Closing achieves that; the label above
    // proves it does so without unmounting the closed content.
    render(
      <SurfacePresentationBoundary visible focused={false}>
        <Select defaultOpen value="host-a" onValueChange={() => undefined}>
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
    // The reason `wasPaneFocused` exists: settling the remembered open state
    // to closed on blur makes backgrounding a real close, so a later refocus
    // must not restore it - Radix never calls `onOpenChange` for this
    // controlled close, so nothing else would clear the uncontrolled state.
    const { rerender } = render(
      <SurfacePresentationBoundary visible focused>
        <Select defaultOpen value="host-a" onValueChange={() => undefined}>
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
        <Select defaultOpen value="host-a" onValueChange={() => undefined}>
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
      <SurfacePresentationBoundary visible focused>
        <Select defaultOpen value="host-a" onValueChange={() => undefined}>
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
  });
});
