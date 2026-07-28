import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  activateTopLevelSurfaceFromFocus,
  activateTopLevelSurfaceFromPointer,
} from "@/components/layout/top-level-surface-activation-context";
import type { HeaderTab } from "@/stores/tabs/types";

afterEach(() => cleanup());

const TAB: HeaderTab = {
  kind: "draft",
  id: "draft-a",
  route: "/draft/draft-a",
  name: "Start Page",
  icon: null,
  canDuplicate: false,
  canOpenInNewWindow: false,
};

function InteractionProbe(props: {
  readonly focused: boolean;
  readonly preventDefault: boolean;
  readonly activate: (tab: HeaderTab) => void;
}) {
  return (
    <div
      data-testid="surface"
      onFocusCapture={(event) => {
        if (props.preventDefault) event.preventDefault();
        activateTopLevelSurfaceFromFocus(
          event,
          props.focused,
          TAB,
          props.activate,
        );
      }}
      onPointerDownCapture={(event) => {
        if (props.preventDefault) event.preventDefault();
        activateTopLevelSurfaceFromPointer(
          event,
          props.focused,
          TAB,
          props.activate,
        );
      }}
    />
  );
}

describe("top-level surface activation", () => {
  // The focus-restore BOUNCE (a background pane's portal unmounting on defocus,
  // whose Radix close-autofocus refocuses its trigger and re-fires this path) is
  // killed at its source by `usePaneCloseAutoFocusGuard` — proven in a real
  // browser (jsdom + `isTrusted` cannot model it). This path just activates a
  // background pane on a deliberate pointer/keyboard interaction.
  it("activates a deliberate pointer or focus interaction, never hover or wheel", () => {
    const activate = vi.fn();
    const { getByTestId } = render(
      <InteractionProbe
        focused={false}
        preventDefault={false}
        activate={activate}
      />,
    );
    const surface = getByTestId("surface");

    fireEvent.mouseEnter(surface);
    fireEvent.wheel(surface);
    expect(activate).not.toHaveBeenCalled();

    fireEvent.pointerDown(surface);
    fireEvent.focus(surface);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenLastCalledWith(TAB);
  });

  it("does not re-activate an already focused or prevented interaction", () => {
    const activate = vi.fn();
    const view = render(
      <InteractionProbe focused preventDefault={false} activate={activate} />,
    );
    const surface = view.getByTestId("surface");

    fireEvent.pointerDown(surface);
    fireEvent.focus(surface);
    expect(activate).not.toHaveBeenCalled();

    view.rerender(
      <InteractionProbe focused={false} preventDefault activate={activate} />,
    );
    fireEvent.pointerDown(surface);
    fireEvent.focus(surface);
    expect(activate).not.toHaveBeenCalled();
  });
});
