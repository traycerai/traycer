import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import { setMobileApp } from "@/lib/mobile-app";

function ShortcutOwner(props: {
  readonly active: boolean;
  readonly action: () => void;
}) {
  usePrimaryActionShortcut(props.active, props.action);
  return null;
}

function ShortcutOwnerWithLayoutDispatch(props: {
  readonly action: () => void;
  readonly dispatch: boolean;
}) {
  usePrimaryActionShortcut(true, props.action);
  useLayoutEffect(() => {
    if (!props.dispatch) return;
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  }, [props.dispatch]);
  return null;
}

describe("usePrimaryActionShortcut", () => {
  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  it("routes Cmd/Ctrl+Enter only to the topmost active owner", () => {
    const lowerAction = vi.fn();
    const upperAction = vi.fn();
    const view = render(
      <>
        <ShortcutOwner active action={lowerAction} />
        <ShortcutOwner active action={upperAction} />
      </>,
    );

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(upperAction).toHaveBeenCalledTimes(1);
    expect(lowerAction).not.toHaveBeenCalled();

    view.rerender(
      <>
        <ShortcutOwner active action={lowerAction} />
        <ShortcutOwner active={false} action={upperAction} />
      </>,
    );
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(lowerAction).toHaveBeenCalledTimes(1);
  });

  it("ignores modified variants and key-repeat submissions", () => {
    const action = vi.fn();
    render(<ShortcutOwner active action={action} />);

    fireEvent.keyDown(window, {
      key: "Enter",
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true, repeat: true });

    expect(action).not.toHaveBeenCalled();
  });

  it("refreshes the action before a layout effect can dispatch the shortcut", () => {
    const previousAction = vi.fn();
    const nextAction = vi.fn();
    const view = render(
      <ShortcutOwnerWithLayoutDispatch
        action={previousAction}
        dispatch={false}
      />,
    );

    view.rerender(
      <ShortcutOwnerWithLayoutDispatch action={nextAction} dispatch />,
    );

    expect(previousAction).not.toHaveBeenCalled();
    expect(nextAction).toHaveBeenCalledTimes(1);
  });

  // The load-bearing guarantee: hiding the shortcut HINT on the installed
  // mobile app must never unbind the shortcut itself - an iPad with a
  // hardware keyboard still dispatches Cmd/Ctrl+Enter.
  it("still dispatches on the installed mobile app", () => {
    setMobileApp(true);
    const action = vi.fn();
    render(<ShortcutOwner active action={action} />);

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

    expect(action).toHaveBeenCalledTimes(1);
  });
});
