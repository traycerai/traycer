import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { PortalConcealmentBoundary } from "@/components/ui/portal-concealment-context";

/**
 * D-series cold-pane activation fix: `overlay-guards.ts`'s
 * `isOwnPaneTriggerEvent` (consumed by `useOverlayPresentation`/
 * `useClosingOverlay`) lets a visible-but-unfocused ("cold") pane's own
 * trigger gesture update the LOGICAL open state, while physical
 * presentation stays gated on the pane actually being focused - see
 * `select-background-pane.test.tsx` for the presentation-loss/background-
 * pane precedent this builds on.
 *
 * The "own trigger click activates" positive case, the concealed-rejection
 * case, and the gesture-free-open-never-presents case are all now proven
 * for Popover as real-Chrome cases in `scripts/portal-lifecycle-gate.mjs`
 * ("cold pane: own trigger click activates..."), driven through
 * `src/__tests__/browser/portal-lifecycle-gate.tsx` - a real browser is a
 * strictly stronger check than jsdom for all three, so the Popover copies
 * that used to live here were removed rather than duplicated. What's left
 * here is Select/Menu-family coverage the Chrome suite does not separately
 * exercise: the concealed guard (a different family, driven through Base's
 * own trigger wiring rather than Popover's) and the keyboard-equivalent
 * (list-navigation) acceptance branch.
 */

afterEach(cleanup);

const HOST_ITEMS = {
  "host-a": "Hardiks-MacBook-Pro",
  "host-b": "Other-Host",
};

function HostSelect(props: {
  readonly onOpenChange?: (open: boolean, details: unknown) => void;
}): React.JSX.Element {
  return (
    <Select
      items={HOST_ITEMS}
      value="host-a"
      onValueChange={() => undefined}
      onOpenChange={props.onOpenChange}
    >
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

describe("Select (Menu-family) activation from a cold (visible, unfocused) pane", () => {
  it("accepts ArrowDown on its own trigger the same as a click", () => {
    // The keyboard equivalent this session's fix added:
    // isOwnPaneTriggerEvent now also accepts reason "list-navigation" when
    // the event is a real KeyboardEvent - Base's useListNavigation (which
    // Select's own SelectRoot wires in via `listNavigation.reference`)
    // fires this same reason for an ArrowDown on the trigger.
    const onOpenChange = vi.fn();
    render(
      <SurfacePresentationBoundary visible focused={false}>
        <HostSelect onOpenChange={onOpenChange} />
      </SurfacePresentationBoundary>,
    );

    const trigger = screen.getByLabelText("Host");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(onOpenChange).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: "list-navigation" }),
    );
  });

  it("rejects a trigger press while concealed", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <PortalConcealmentBoundary concealed>
        <SurfacePresentationBoundary visible focused={false}>
          <HostSelect onOpenChange={onOpenChange} />
        </SurfacePresentationBoundary>
      </PortalConcealmentBoundary>,
    );

    await user.click(screen.getByLabelText("Host"));

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
