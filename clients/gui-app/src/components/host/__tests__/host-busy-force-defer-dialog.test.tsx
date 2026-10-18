import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";

afterEach(() => {
  cleanup();
});

interface Handlers {
  readonly onForce: () => void;
  readonly onDefer: () => void;
}

function renderDialog(isForcing: boolean): Handlers {
  const handlers: Handlers = { onForce: vi.fn(), onDefer: vi.fn() };
  render(
    <HostBusyForceDeferDialog
      purpose="restart"
      open
      title="Host is busy"
      message="Another surface holds the mutation lane."
      detail={null}
      isForcing={isForcing}
      forceLabel="Force restart"
      forceDestructive
      onForce={handlers.onForce}
      onDefer={handlers.onDefer}
      idleAction={null}
    />,
  );
  return handlers;
}

function getButton(testId: string): HTMLButtonElement {
  const element = screen.getByTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`${testId} is not a button`);
  }
  return element;
}

describe("HostBusyForceDeferDialog", () => {
  describe("while forcing", () => {
    it("disables Force so a click does not call onForce", () => {
      const handlers = renderDialog(true);
      const force = getButton("host-busy-force");
      expect(force.disabled).toBe(true);
      fireEvent.click(force);
      expect(handlers.onForce).not.toHaveBeenCalled();
    });

    it("keeps the dismiss button enabled, labelled Close, and calls onDefer once on click", () => {
      const handlers = renderDialog(true);
      const defer = getButton("host-busy-defer");
      expect(defer.disabled).toBe(false);
      expect(defer.textContent).toBe("Close");
      fireEvent.click(defer);
      expect(handlers.onDefer).toHaveBeenCalledTimes(1);
    });

    it("calls onDefer when Escape is pressed on the dialog", () => {
      const handlers = renderDialog(true);
      fireEvent.keyDown(screen.getByTestId("host-busy-force-defer-dialog"), {
        key: "Escape",
      });
      expect(handlers.onDefer).toHaveBeenCalled();
      expect(handlers.onForce).not.toHaveBeenCalled();
    });
  });

  describe("when not forcing", () => {
    it("enables both buttons and calls onForce on Force click", () => {
      const handlers = renderDialog(false);
      const defer = getButton("host-busy-defer");
      expect(defer.disabled).toBe(false);
      expect(defer.textContent).toBe("Defer");
      const force = getButton("host-busy-force");
      expect(force.disabled).toBe(false);
      fireEvent.click(force);
      expect(handlers.onForce).toHaveBeenCalledTimes(1);
      expect(handlers.onDefer).not.toHaveBeenCalled();
    });
  });
});
