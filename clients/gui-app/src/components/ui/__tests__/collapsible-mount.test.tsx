import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

afterEach(cleanup);

function UncontrolledPanel() {
  return (
    <Collapsible>
      <CollapsibleTrigger>Toggle</CollapsibleTrigger>
      <CollapsibleContent>
        <p>Body</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ControlledPanel({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger>Toggle</CollapsibleTrigger>
      <CollapsibleContent>
        <p>Body</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ForceMountPanel() {
  return (
    <Collapsible>
      <CollapsibleTrigger>Toggle</CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <p>Body</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TwoPanels() {
  return (
    <>
      <Collapsible>
        <CollapsibleTrigger>Toggle A</CollapsibleTrigger>
        <CollapsibleContent>
          <p>Body A</p>
        </CollapsibleContent>
      </Collapsible>
      <Collapsible>
        <CollapsibleTrigger>Toggle B</CollapsibleTrigger>
        <CollapsibleContent>
          <p>Body B</p>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

describe("Collapsible mount cost and correctness", () => {
  it("mounts closed with no children in the DOM, and reveals them on click", async () => {
    const user = userEvent.setup();
    render(<UncontrolledPanel />);

    expect(screen.queryByText("Body")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Toggle" }));

    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("removes children from the DOM again on close (no forceMount)", async () => {
    const user = userEvent.setup();
    render(<UncontrolledPanel />);
    const trigger = screen.getByRole("button", { name: "Toggle" });

    await user.click(trigger);
    expect(screen.getByText("Body")).toBeTruthy();

    await user.click(trigger);
    expect(screen.queryByText("Body")).toBeNull();
  });

  it("toggles open via keyboard activation (Enter and Space) on the trigger", async () => {
    const user = userEvent.setup();
    render(<UncontrolledPanel />);
    const trigger = screen.getByRole("button", { name: "Toggle" });
    trigger.focus();

    await user.keyboard("{Enter}");
    expect(screen.getByText("Body")).toBeTruthy();

    await user.keyboard(" ");
    expect(screen.queryByText("Body")).toBeNull();
  });

  it("matches Radix's own forceMount contract exactly: closed+forceMount stays VISIBLE, not hidden", () => {
    // Radix's own CollapsibleContent (react-collapsible's ContentImpl):
    // `present = forceMount || open`, then `isOpen = context.open || isPresent`,
    // `hidden = !isOpen`. So forceMount true with open false resolves
    // `isOpen` to true and `hidden` to false - forceMount does not mean
    // "keep it hidden while mounted", it means "always present", exactly
    // like this wrapper's `hidden={!present}`. Assert both facts, and pin
    // parity against the raw primitive so a future "fix" back toward
    // `hidden={!open}` would fail here as loudly as it would against Radix.
    const wrapper = render(<ForceMountPanel />);
    const wrapperContent = wrapper.container.querySelector(
      "[data-slot='collapsible-content']",
    );
    if (wrapperContent === null) throw new Error("expected wrapper content");
    expect(wrapperContent.hasAttribute("hidden")).toBe(false);
    expect(wrapperContent.getAttribute("data-state")).toBe("closed");
    expect(wrapper.getByText("Body")).toBeTruthy();

    const raw = render(
      <CollapsiblePrimitive.Root open={false}>
        <CollapsiblePrimitive.CollapsibleTrigger>
          Toggle
        </CollapsiblePrimitive.CollapsibleTrigger>
        <CollapsiblePrimitive.CollapsibleContent forceMount>
          <p>Raw body</p>
        </CollapsiblePrimitive.CollapsibleContent>
      </CollapsiblePrimitive.Root>,
    );
    const rawContent = raw.container.querySelector("p")?.parentElement ?? null;
    if (rawContent === null) throw new Error("expected raw radix content");
    expect(rawContent.hasAttribute("hidden")).toBe(false);
    expect(rawContent.getAttribute("data-state")).toBe("closed");
  });

  it("follows the controlled open prop rather than internal state", async () => {
    const onOpenChange = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <ControlledPanel
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.queryByText("Body")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Toggle" }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("does not toggle when disabled", async () => {
    const user = userEvent.setup();
    render(
      <Collapsible disabled>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <p>Body</p>
        </CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: "Toggle" });

    await user.click(trigger);

    expect(screen.queryByText("Body")).toBeNull();
  });

  it("wires each trigger's aria-controls to its own content id, not a sibling's", async () => {
    const user = userEvent.setup();
    render(<TwoPanels />);

    await user.click(screen.getByRole("button", { name: "Toggle A" }));
    await user.click(screen.getByRole("button", { name: "Toggle B" }));

    const triggerA = screen.getByRole("button", { name: "Toggle A" });
    const triggerB = screen.getByRole("button", { name: "Toggle B" });
    const contentA = screen.getByText("Body A").closest("[id]");
    const contentB = screen.getByText("Body B").closest("[id]");
    if (contentA === null || contentB === null) {
      throw new Error("expected both contents to carry an id");
    }

    expect(triggerA.getAttribute("aria-controls")).toBe(contentA.id);
    expect(triggerB.getAttribute("aria-controls")).toBe(contentB.id);
    expect(contentA.id).not.toBe(contentB.id);
  });

  it("never reads layout geometry mounting closed or opening (no Presence measurement)", () => {
    // Plain DOM lookups, not RTL's role queries: `getByRole`'s own
    // accessible-name computation calls `getComputedStyle` up the ancestor
    // chain to check visibility, which would otherwise be mistaken for a
    // read this component made. Likewise a bare `fireEvent.click`, not
    // userEvent, whose pointer-events visibility check does the same.
    const { container } = render(<UncontrolledPanel />);
    const trigger = container.querySelector("button");
    if (trigger === null) throw new Error("expected a trigger button");

    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const computedStyleSpy = vi.spyOn(window, "getComputedStyle");

    fireEvent.click(trigger);
    expect(rectSpy).not.toHaveBeenCalled();
    expect(computedStyleSpy).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(rectSpy).not.toHaveBeenCalled();
    expect(computedStyleSpy).not.toHaveBeenCalled();

    rectSpy.mockRestore();
    computedStyleSpy.mockRestore();
  });

  it("mounts with no layout reads whether it starts closed or open", () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const computedStyleSpy = vi.spyOn(window, "getComputedStyle");

    render(<UncontrolledPanel />);
    expect(rectSpy).not.toHaveBeenCalled();
    expect(computedStyleSpy).not.toHaveBeenCalled();

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <p>Body</p>
        </CollapsibleContent>
      </Collapsible>,
    );
    expect(rectSpy).not.toHaveBeenCalled();
    expect(computedStyleSpy).not.toHaveBeenCalled();

    rectSpy.mockRestore();
    computedStyleSpy.mockRestore();
  });
});
