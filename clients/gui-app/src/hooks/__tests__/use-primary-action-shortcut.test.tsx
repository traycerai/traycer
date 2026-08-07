import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";

function ShortcutOwner(props: {
  readonly active: boolean;
  readonly action: () => void;
}) {
  usePrimaryActionShortcut(props.active, props.action);
  return null;
}

describe("usePrimaryActionShortcut", () => {
  afterEach(cleanup);

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
});
