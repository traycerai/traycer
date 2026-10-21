import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasStyleInput } from "../canvas-style-input";

const DEBOUNCE_MS = 450;

function renderInput(
  value: string,
  onCommit: (value: string) => Promise<boolean>,
) {
  const element = (current: string) => (
    <CanvasStyleInput
      label="Width"
      value={current}
      disabled={false}
      onCommit={onCommit}
    />
  );
  const view = render(element(value));
  return {
    input: () => screen.getByLabelText("Width"),
    rerenderWith: (current: string) => view.rerender(element(current)),
    unmount: () => view.unmount(),
  };
}

function type(input: HTMLElement, text: string): void {
  fireEvent.change(input, { target: { value: text } });
}

function valueOf(input: HTMLElement): string {
  if (!(input instanceof HTMLInputElement)) throw new Error("not an input");
  return input.value;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("CanvasStyleInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("emits only the final value, once the person has paused typing", () => {
    const onCommit = vi.fn((_value: string) => Promise.resolve(true));
    const subject = renderInput("", onCommit);

    type(subject.input(), "1");
    advance(DEBOUNCE_MS - 1);
    type(subject.input(), "12");
    advance(DEBOUNCE_MS - 1);
    type(subject.input(), "120px");
    advance(DEBOUNCE_MS - 1);
    expect(onCommit).not.toHaveBeenCalled();

    advance(1);
    expect(onCommit.mock.calls).toEqual([["120px"]]);
  });

  it("commits at once on Enter, and neither blur nor the timer repeats it", () => {
    const onCommit = vi.fn((_value: string) => Promise.resolve(true));
    const subject = renderInput("", onCommit);

    type(subject.input(), "blue");
    fireEvent.keyDown(subject.input(), { key: "Enter" });
    expect(onCommit.mock.calls).toEqual([["blue"]]);

    fireEvent.blur(subject.input());
    advance(DEBOUNCE_MS * 2);
    expect(onCommit.mock.calls).toEqual([["blue"]]);
  });

  it("commits on blur, and the timer does not repeat it", () => {
    const onCommit = vi.fn((_value: string) => Promise.resolve(true));
    const subject = renderInput("", onCommit);

    type(subject.input(), "2px");
    fireEvent.blur(subject.input());
    advance(DEBOUNCE_MS * 2);
    expect(onCommit.mock.calls).toEqual([["2px"]]);
  });

  it("commits nothing when the text goes back to the value it started from", () => {
    const onCommit = vi.fn((_value: string) => Promise.resolve(true));
    const subject = renderInput("10px", onCommit);

    type(subject.input(), "11px");
    type(subject.input(), "10px");
    fireEvent.blur(subject.input());
    advance(DEBOUNCE_MS * 2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows a changed external value in the same, still focused input", () => {
    const subject = renderInput("red", () => Promise.resolve(true));
    const before = subject.input();
    before.focus();
    type(before, "blu");

    subject.rerenderWith("green");

    expect(subject.input()).toBe(before);
    expect(valueOf(subject.input())).toBe("green");
    expect(document.activeElement).toBe(before);
  });

  it("keeps the person's draft while the external value is unchanged", () => {
    const subject = renderInput("red", () => Promise.resolve(true));
    type(subject.input(), "blu");

    subject.rerenderWith("red");

    expect(valueOf(subject.input())).toBe("blu");
  });

  it("cancels a pending edit when unmounted", () => {
    const onCommit = vi.fn((_value: string) => Promise.resolve(true));
    const subject = renderInput("", onCommit);

    type(subject.input(), "3px");
    subject.unmount();
    advance(DEBOUNCE_MS * 2);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("drops a pending edit and the draft on Escape", () => {
    const onCommit = vi.fn((_value: string) => Promise.resolve(true));
    const subject = renderInput("red", onCommit);

    type(subject.input(), "blu");
    fireEvent.keyDown(subject.input(), { key: "Escape" });
    advance(DEBOUNCE_MS * 2);

    expect(onCommit).not.toHaveBeenCalled();
    expect(valueOf(subject.input())).toBe("red");
  });

  // A save is acknowledged by the value prop refreshing, which can land after
  // the person has already typed the next edit. That edit must survive.
  describe("an acknowledged commit while newer text is being typed", () => {
    it("keeps the newer text in the same focused input and submits it once against the refreshed value", () => {
      const onCommit = vi.fn((_value: string) => Promise.resolve(true));
      const subject = renderInput("", onCommit);
      const input = subject.input();
      input.focus();

      type(input, "100px");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCommit.mock.calls).toEqual([["100px"]]);

      // B is typed while A is still unacknowledged, its timer pending.
      type(input, "200px");
      advance(DEBOUNCE_MS - 1);

      // A is acknowledged before B's timer fires.
      subject.rerenderWith("100px");
      expect(subject.input()).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(valueOf(input)).toBe("200px");
      expect(onCommit).toHaveBeenCalledTimes(1);

      advance(1);
      expect(onCommit.mock.calls).toEqual([["100px"], ["200px"]]);

      // B is acknowledged too: nothing is re-sent and the text stays.
      subject.rerenderWith("200px");
      fireEvent.blur(input);
      advance(DEBOUNCE_MS * 2);
      expect(valueOf(input)).toBe("200px");
      expect(onCommit.mock.calls).toEqual([["100px"], ["200px"]]);
    });

    it("keeps the newer text when it was already committed before the first acknowledgement", () => {
      const onCommit = vi.fn((_value: string) => Promise.resolve(true));
      const subject = renderInput("", onCommit);
      const input = subject.input();
      input.focus();

      type(input, "100px");
      fireEvent.keyDown(input, { key: "Enter" });
      type(input, "200px");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCommit.mock.calls).toEqual([["100px"], ["200px"]]);

      // A's acknowledgement arrives while B is queued.
      subject.rerenderWith("100px");
      expect(subject.input()).toBe(input);
      expect(valueOf(input)).toBe("200px");

      subject.rerenderWith("200px");
      fireEvent.blur(input);
      advance(DEBOUNCE_MS * 2);
      expect(valueOf(input)).toBe("200px");
      expect(document.activeElement).toBe(input);
      expect(onCommit.mock.calls).toEqual([["100px"], ["200px"]]);
    });

    it("discards newer text on Escape back to the value already submitted, and later blur or timers send nothing", () => {
      const onCommit = vi.fn((_value: string) => Promise.resolve(true));
      const subject = renderInput("100px", onCommit);
      const input = subject.input();
      input.focus();

      type(input, "200px");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCommit.mock.calls).toEqual([["200px"]]);

      // B is typed, then abandoned while A is still unacknowledged. Escape
      // returns to what was last submitted (A), not to the old source value.
      type(input, "300px");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(valueOf(input)).toBe("200px");

      fireEvent.blur(input);
      advance(DEBOUNCE_MS * 2);
      // Neither B nor a rollback to the old source was sent.
      expect(onCommit.mock.calls).toEqual([["200px"]]);

      // A's acknowledgement then shows A, and nothing extra goes out.
      subject.rerenderWith("200px");
      expect(subject.input()).toBe(input);
      expect(valueOf(input)).toBe("200px");
      fireEvent.blur(input);
      advance(DEBOUNCE_MS * 2);
      expect(onCommit.mock.calls).toEqual([["200px"]]);
    });

    it("shows the refreshed value when nothing newer was typed", () => {
      const onCommit = vi.fn((_value: string) => Promise.resolve(true));
      const subject = renderInput("", onCommit);
      const input = subject.input();
      input.focus();

      type(input, "100");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCommit.mock.calls).toEqual([["100"]]);

      // The host answers with the normalised spelling of what was committed.
      subject.rerenderWith("100px");
      expect(subject.input()).toBe(input);
      expect(valueOf(input)).toBe("100px");
      expect(document.activeElement).toBe(input);

      // And a later external change still shows through.
      subject.rerenderWith("300px");
      expect(valueOf(input)).toBe("300px");
    });
  });

  // A commit is answered by the promise onCommit returns. A refusal, a
  // rejection or a synchronous throw all mean "not saved": the field must stay
  // retryable and must not lose text typed since.
  describe("a commit the host does not accept", () => {
    interface Outcome {
      readonly accept: (accepted: boolean) => void;
      readonly reject: (error: Error) => void;
    }

    function heldCommits() {
      const outcomes: Outcome[] = [];
      const onCommit = vi.fn(
        (_value: string) =>
          new Promise<boolean>((resolve, reject) => {
            outcomes.push({ accept: resolve, reject });
          }),
      );
      return { onCommit, outcomes };
    }

    async function answer(
      outcomes: readonly Outcome[],
      index: number,
      how: "refused" | "rejected",
    ): Promise<void> {
      await act(async () => {
        if (how === "refused") outcomes[index].accept(false);
        else outcomes[index].reject(new Error("host unreachable"));
        await Promise.resolve();
      });
    }

    for (const how of ["refused", "rejected"] as const) {
      it(`sends the same value again on Enter after it was ${how}`, async () => {
        const { onCommit, outcomes } = heldCommits();
        const subject = renderInput("100px", onCommit);
        const input = subject.input();
        input.focus();

        type(input, "200px");
        fireEvent.keyDown(input, { key: "Enter" });
        await answer(outcomes, 0, how);
        expect(valueOf(input)).toBe("200px");

        fireEvent.keyDown(input, { key: "Enter" });
        expect(onCommit.mock.calls).toEqual([["200px"], ["200px"]]);
        expect(document.activeElement).toBe(input);
      });

      it(`sends the same value again on blur after it was ${how}`, async () => {
        const { onCommit, outcomes } = heldCommits();
        const subject = renderInput("100px", onCommit);
        const input = subject.input();

        type(input, "200px");
        fireEvent.blur(input);
        await answer(outcomes, 0, how);

        fireEvent.blur(input);
        expect(onCommit.mock.calls).toEqual([["200px"], ["200px"]]);
      });

      it(`keeps the newer text typed while the earlier commit is ${how}, and Escape returns to the saved value`, async () => {
        const { onCommit, outcomes } = heldCommits();
        const subject = renderInput("100px", onCommit);
        const input = subject.input();
        input.focus();

        type(input, "200px");
        fireEvent.keyDown(input, { key: "Enter" });
        type(input, "300px");
        advance(100);

        await answer(outcomes, 0, how);
        // The refusal did not take B with it.
        expect(subject.input()).toBe(input);
        expect(valueOf(input)).toBe("300px");

        // Escape abandons B and returns to what was saved, never to A's 200px.
        fireEvent.keyDown(input, { key: "Escape" });
        expect(valueOf(input)).toBe("100px");
        fireEvent.blur(input);
        advance(DEBOUNCE_MS * 2);
        expect(onCommit.mock.calls).toEqual([["200px"]]);
      });

      it(`still submits the newer text once after the earlier commit is ${how}`, async () => {
        const { onCommit, outcomes } = heldCommits();
        const subject = renderInput("100px", onCommit);
        const input = subject.input();

        type(input, "200px");
        fireEvent.keyDown(input, { key: "Enter" });
        type(input, "300px");

        await answer(outcomes, 0, how);
        advance(DEBOUNCE_MS);

        expect(onCommit.mock.calls).toEqual([["200px"], ["300px"]]);
        expect(valueOf(input)).toBe("300px");
      });
    }

    it("treats a synchronous throw as not saved, keeps the text, and lets the same value be sent again", () => {
      let attempts = 0;
      const onCommit = vi.fn((_value: string): Promise<boolean> => {
        attempts += 1;
        if (attempts === 1) throw new Error("could not start");
        return Promise.resolve(true);
      });
      const subject = renderInput("100px", onCommit);
      const input = subject.input();
      input.focus();

      type(input, "200px");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(valueOf(input)).toBe("200px");

      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCommit.mock.calls).toEqual([["200px"], ["200px"]]);
      expect(document.activeElement).toBe(input);
    });

    it("does not resend an accepted value on blur", async () => {
      const { onCommit, outcomes } = heldCommits();
      const subject = renderInput("100px", onCommit);
      const input = subject.input();

      type(input, "200px");
      fireEvent.keyDown(input, { key: "Enter" });
      await act(async () => {
        outcomes[0].accept(true);
        await Promise.resolve();
      });
      subject.rerenderWith("200px");

      fireEvent.blur(input);
      advance(DEBOUNCE_MS * 2);
      expect(onCommit.mock.calls).toEqual([["200px"]]);
    });
  });
});
