import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaneActivationFocusIntentContext,
  paneActivationDeferProps,
  resetPaneActivationFocusIntentsForTests,
  usePaneActivationFocusIntent,
  usePaneActivationOwnership,
} from "@/components/epic-canvas/pane-activation";

afterEach(() => {
  cleanup();
  resetPaneActivationFocusIntentsForTests();
});

function ActivationBoundary(props: {
  readonly active: boolean;
  readonly id: string;
  readonly onActivate: () => void;
  readonly children: ReactNode;
}) {
  const activation = usePaneActivationOwnership({
    active: props.active,
    activate: props.onActivate,
  });
  return (
    <PaneActivationFocusIntentContext.Provider value={activation.focusIntent}>
      <div
        data-testid={`pane-${props.id}`}
        onFocusCapture={activation.onFocusCapture}
        onPointerCancelCapture={activation.onPointerCancelCapture}
        onPointerDownCapture={activation.onPointerDownCapture}
      >
        {props.children}
      </div>
    </PaneActivationFocusIntentContext.Provider>
  );
}

function PortalledDeferredAction(props: { readonly onClick: () => void }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return createPortal(
    <button
      type="button"
      {...paneActivationDeferProps}
      onClick={(event) => {
        props.onClick();
        event.stopPropagation();
        setVisible(false);
      }}
    >
      Portal action
    </button>,
    document.body,
  );
}

function AutoFocusProbe(props: {
  readonly active: boolean;
  readonly onDecision: (yieldFocus: boolean) => void;
}) {
  const { active, onDecision } = props;
  const focusIntent = usePaneActivationFocusIntent();
  useEffect(() => {
    if (!active) return;
    onDecision(focusIntent.shouldYieldAutoFocus());
  }, [active, focusIntent, onDecision]);
  return null;
}

function FocusIntentHarness(props: {
  readonly target: "blank" | "control";
  readonly onDecision: (yieldFocus: boolean) => void;
}) {
  const [active, setActive] = useState(false);
  return (
    <ActivationBoundary
      active={active}
      id={props.target}
      onActivate={() => setActive(true)}
    >
      {props.target === "control" ? (
        <button type="button">Control</button>
      ) : (
        <div data-testid="blank-target">Blank surface</div>
      )}
      <AutoFocusProbe active={active} onDecision={props.onDecision} />
    </ActivationBoundary>
  );
}

function SelfRemovingFocusIntentHarness(props: {
  readonly onDecision: (yieldFocus: boolean) => void;
}) {
  const [active, setActive] = useState(false);
  const [visible, setVisible] = useState(true);
  return (
    <ActivationBoundary
      active={active}
      id="self-removing"
      onActivate={() => setActive(true)}
    >
      {visible ? (
        <button
          type="button"
          {...paneActivationDeferProps}
          onClick={() => setVisible(false)}
        >
          Remove and activate
        </button>
      ) : null}
      <AutoFocusProbe active={active} onDecision={props.onDecision} />
    </ActivationBoundary>
  );
}

describe("pane activation ownership", () => {
  it("completes a deferred action whose click stops propagation", async () => {
    const activate = vi.fn();
    const action = vi.fn();
    render(
      <ActivationBoundary active={false} id="stopped" onActivate={activate}>
        <button
          type="button"
          {...paneActivationDeferProps}
          onClick={(event) => {
            action();
            event.stopPropagation();
          }}
        >
          Stopped action
        </button>
      </ActivationBoundary>,
    );

    const button = screen.getByRole("button", { name: "Stopped action" });
    fireEvent.pointerDown(button);
    expect(activate).not.toHaveBeenCalled();
    fireEvent.click(button);

    expect(action).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
  });

  it("keeps ownership when a portalled deferred action stops and removes itself", async () => {
    const activate = vi.fn();
    const action = vi.fn();
    render(
      <ActivationBoundary active={false} id="portal" onActivate={activate}>
        <PortalledDeferredAction onClick={action} />
      </ActivationBoundary>,
    );

    const button = screen.getByRole("button", { name: "Portal action" });
    fireEvent.pointerDown(button);
    fireEvent.click(button);

    expect(action).toHaveBeenCalledTimes(1);
    expect(button.isConnected).toBe(false);
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
  });

  it("stops yielding autofocus when the initiating control removes itself", async () => {
    const decision = vi.fn();
    render(<SelfRemovingFocusIntentHarness onDecision={decision} />);

    const button = screen.getByRole("button", {
      name: "Remove and activate",
    });
    fireEvent.pointerDown(button);
    fireEvent.click(button);

    expect(button.isConnected).toBe(false);
    await waitFor(() => expect(decision).toHaveBeenCalledWith(false));
  });

  it("does not complete a stale pane token after a sibling gesture starts", async () => {
    const activateLeft = vi.fn();
    const activateRight = vi.fn();
    render(
      <>
        <ActivationBoundary active={false} id="left" onActivate={activateLeft}>
          <button type="button" {...paneActivationDeferProps}>
            Left action
          </button>
        </ActivationBoundary>
        <ActivationBoundary
          active={false}
          id="right"
          onActivate={activateRight}
        >
          <button type="button" {...paneActivationDeferProps}>
            Right action
          </button>
        </ActivationBoundary>
      </>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Left action" }));
    const right = screen.getByRole("button", { name: "Right action" });
    fireEvent.pointerDown(right);
    fireEvent.click(right);

    await waitFor(() => expect(activateRight).toHaveBeenCalledTimes(1));
    expect(activateLeft).not.toHaveBeenCalled();
  });

  it("cancels deferred ownership on pointer cancellation", async () => {
    const activate = vi.fn();
    render(
      <ActivationBoundary active={false} id="cancel" onActivate={activate}>
        <button type="button" {...paneActivationDeferProps}>
          Cancelled action
        </button>
      </ActivationBoundary>,
    );

    const button = screen.getByRole("button", { name: "Cancelled action" });
    fireEvent.pointerDown(button);
    fireEvent.pointerCancel(button);
    fireEvent.click(button);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(activate).not.toHaveBeenCalled();
  });

  it("activates on keyboard focus without stealing the control's focus intent", async () => {
    const decision = vi.fn();
    render(<FocusIntentHarness target="control" onDecision={decision} />);

    screen.getByRole("button", { name: "Control" }).focus();

    await waitFor(() => expect(decision).toHaveBeenCalledWith(true));
  });

  it("preserves primary autofocus for blank-surface pointer activation", async () => {
    const decision = vi.fn();
    render(<FocusIntentHarness target="blank" onDecision={decision} />);

    fireEvent.pointerDown(screen.getByTestId("blank-target"));

    await waitFor(() => expect(decision).toHaveBeenCalledWith(false));
  });

  it("does not let pointer focus activate a deferred action before its click", async () => {
    const activate = vi.fn();
    render(
      <ActivationBoundary active={false} id="focus" onActivate={activate}>
        <button type="button" {...paneActivationDeferProps}>
          Deferred focus
        </button>
      </ActivationBoundary>,
    );

    const button = screen.getByRole("button", { name: "Deferred focus" });
    fireEvent.pointerDown(button);
    button.focus();
    expect(activate).not.toHaveBeenCalled();
    fireEvent.click(button);

    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
  });
});
