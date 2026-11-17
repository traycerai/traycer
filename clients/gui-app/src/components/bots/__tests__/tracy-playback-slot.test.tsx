/**
 * The Tracy tab's playback scope with small real trees: the scope, its title
 * rows and the real controls. Nothing of the scope is replaced.
 */
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  TracyPlaybackScope,
  TracyPlaybackSlot,
} from "@/components/bots/tracy-playback-slot";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
}));

beforeEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useSettingsStore.setState({
    soundtrackEnabled: true,
    soundtrackPlaybackControls: true,
  });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

function groups(): HTMLElement[] {
  return screen.queryAllByRole("group", { name: "Music playback" });
}

function onlyGroup(): HTMLElement {
  // `getByRole` throws on a second group, as it does on none.
  return screen.getByRole("group", { name: "Music playback" });
}

function slotOf(row: string): HTMLElement {
  const slot = screen
    .getByTestId(row)
    .querySelector<HTMLElement>('[data-testid="tracy-playback-slot"]');
  if (slot === null) throw new Error(`${row} has no slot`);
  return slot;
}

function Row(props: { readonly id: string }): ReactNode {
  return (
    <div data-testid={props.id}>
      <TracyPlaybackSlot />
    </div>
  );
}

describe("<TracyPlaybackScope /> under StrictMode", () => {
  it("draws one group, in the slot", () => {
    render(
      <StrictMode>
        <TracyPlaybackScope>
          <Row id="row-a" />
        </TracyPlaybackScope>
      </StrictMode>,
    );

    expect(groups()).toHaveLength(1);
    expect(slotOf("row-a").contains(onlyGroup())).toBe(true);
  });
});

describe("<TracyPlaybackScope /> when one title row replaces another", () => {
  it("keeps the group in the new row after the old row let go", () => {
    const { rerender } = render(
      <TracyPlaybackScope>
        <Row key="a" id="row-a" />
      </TracyPlaybackScope>,
    );
    expect(slotOf("row-a").contains(onlyGroup())).toBe(true);

    rerender(
      <TracyPlaybackScope>
        <Row key="b" id="row-b" />
      </TracyPlaybackScope>,
    );

    expect(groups()).toHaveLength(1);
    expect(slotOf("row-b").contains(onlyGroup())).toBe(true);
  });

  it("keeps the group in the row that stays when the other one unmounts", () => {
    const { rerender } = render(
      <TracyPlaybackScope>
        <Row key="a" id="row-a" />
        <Row key="b" id="row-b" />
      </TracyPlaybackScope>,
    );
    expect(slotOf("row-b").contains(onlyGroup())).toBe(true);

    rerender(
      <TracyPlaybackScope>
        <Row key="b" id="row-b" />
      </TracyPlaybackScope>,
    );

    expect(groups()).toHaveLength(1);
    expect(slotOf("row-b").contains(onlyGroup())).toBe(true);
  });
});

describe("<TracyPlaybackScope /> when the subtree holding the title row is replaced", () => {
  it("keeps the one group element", () => {
    const { rerender } = render(
      <TracyPlaybackScope>
        <section key="first">
          <Row id="row-first" />
        </section>
      </TracyPlaybackScope>,
    );
    const before = onlyGroup();

    rerender(
      <TracyPlaybackScope>
        <section key="second">
          <Row id="row-second" />
        </section>
      </TracyPlaybackScope>,
    );

    expect(onlyGroup()).toBe(before);
    expect(slotOf("row-second").contains(before)).toBe(true);
  });
});

describe("<TracyPlaybackScope /> unmounting", () => {
  it("throws nothing and leaves no group in the document while a title row holds it", () => {
    const { unmount } = render(
      <TracyPlaybackScope>
        <Row id="row-a" />
      </TracyPlaybackScope>,
    );
    expect(groups()).toHaveLength(1);

    expect(() => unmount()).not.toThrow();

    expect(groups()).toHaveLength(0);
  });

  it("calls focus on nothing while a focused control goes with it", () => {
    const { unmount } = render(
      <TracyPlaybackScope>
        <Row id="row-a" />
      </TracyPlaybackScope>,
    );
    act(() => screen.getByTestId("epic-playback-toggle").focus());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    try {
      unmount();

      expect(focus).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
    }
  });
});

describe("<TracyPlaybackScope /> inside another", () => {
  it("adds no second group", () => {
    render(
      <TracyPlaybackScope>
        <TracyPlaybackScope>
          <Row id="row-a" />
        </TracyPlaybackScope>
      </TracyPlaybackScope>,
    );

    expect(groups()).toHaveLength(1);
    expect(slotOf("row-a").contains(onlyGroup())).toBe(true);
  });
});

// A move re-inserts the carrier, which drops focus; the scope puts it back.
describe("<TracyPlaybackScope /> moving the focused control", () => {
  type Place = "a" | "none" | "b";

  function Tree(props: { readonly place: Place }): ReactNode {
    return (
      <>
        <button type="button">Outside</button>
        <TracyPlaybackScope>
          {props.place === "none" ? null : (
            <Row key={props.place} id={`row-${props.place}`} />
          )}
        </TracyPlaybackScope>
      </>
    );
  }

  it.each<{ readonly name: string; readonly steps: readonly Place[] }>([
    { name: "across commits", steps: ["none", "b"] },
    { name: "within one commit", steps: ["b"] },
  ])(
    "keeps focus on the same button from a title row to another $name",
    (move) => {
      const { rerender } = render(<Tree place="a" />);
      const button = screen.getByTestId("epic-playback-toggle");
      act(() => button.focus());

      for (const place of move.steps) {
        rerender(<Tree place={place} />);
      }

      expect(slotOf("row-b").contains(button)).toBe(true);
      expect(document.activeElement).toBe(button);
    },
  );

  it("keeps focus on the same button when the title row goes and the group rests in the row of its own", () => {
    const { rerender } = render(<Tree place="a" />);
    const button = screen.getByTestId("epic-playback-toggle");
    act(() => button.focus());

    rerender(<Tree place="none" />);

    expect(screen.queryByTestId("tracy-playback-slot")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("does not focus a control that is not visible when the move ends", () => {
    const { rerender } = render(<Tree place="a" />);
    const button = screen.getByTestId("epic-playback-toggle");
    act(() => button.focus());
    // jsdom has no layout: a surface that is hidden is told apart by this.
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
      configurable: true,
      value: () => false,
    });

    try {
      rerender(<Tree place="b" />);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "checkVisibility");
    }

    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus from a control outside the group", () => {
    const { rerender } = render(<Tree place="a" />);
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());

    rerender(<Tree place="b" />);

    expect(document.activeElement).toBe(outside);
  });

  it("focuses nothing when no control of the group had focus", () => {
    const { rerender } = render(<Tree place="a" />);
    expect(document.activeElement).toBe(document.body);

    rerender(<Tree place="b" />);

    expect(document.activeElement).toBe(document.body);
  });
});

describe("<TracyPlaybackScope /> when a title row is replaced by state below the scope", () => {
  // The scope's parent does not render: only the child holding the rows does.
  function SwappingRows(): ReactNode {
    const [place, setPlace] = useState<"a" | "b">("a");
    useEffect(() => {
      const swap = (): void => setPlace("b");
      window.addEventListener("swap-rows", swap);
      return () => window.removeEventListener("swap-rows", swap);
    }, []);
    return <Row key={place} id={`row-${place}`} />;
  }

  it("keeps focus on the same button", () => {
    render(
      <TracyPlaybackScope>
        <SwappingRows />
      </TracyPlaybackScope>,
    );
    const button = screen.getByTestId("epic-playback-toggle");
    act(() => button.focus());

    act(() => {
      window.dispatchEvent(new Event("swap-rows"));
    });

    expect(slotOf("row-b").contains(button)).toBe(true);
    expect(document.activeElement).toBe(button);
  });
});

describe("<TracyPlaybackScope /> when another control takes focus in the commit of the move", () => {
  function TakesFocus(): ReactNode {
    const ref = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => ref.current?.focus(), []);
    return <button ref={ref}>Taker</button>;
  }

  it("leaves focus on that control", () => {
    const { rerender } = render(
      <TracyPlaybackScope>
        <Row key="a" id="row-a" />
      </TracyPlaybackScope>,
    );
    act(() => screen.getByTestId("epic-playback-toggle").focus());

    rerender(
      <TracyPlaybackScope>
        <Row key="b" id="row-b" />
        <TakesFocus />
      </TracyPlaybackScope>,
    );

    expect(slotOf("row-b").contains(onlyGroup())).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Taker" }),
    );
  });
});
