import { afterEach, describe, expect, it, vi } from "vitest";
import { claimBareKey } from "@/lib/keybindings/bare-key-owner";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function claim(handler: (event: KeyboardEvent) => void): () => void {
  const dispose = claimBareKey("r", handler);
  disposers.push(dispose);
  return dispose;
}

function pressR(init: KeyboardEventInit | undefined): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "r",
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

describe("claimBareKey", () => {
  it("delivers a bare letter to ONE owner, not to every surface that wants it", () => {
    // The folder-mapping picker and the worktree owner hover card can both be
    // open in the same pane. Two raw `window` listeners would both fire for one
    // keystroke - `preventDefault` stops the browser, not a sibling listener -
    // so `R` would refresh both, including the card, which deliberately does
    // not defer to text fields.
    const first = vi.fn();
    const second = vi.fn();
    claim(first);
    claim(second);

    pressR(undefined);

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("hands the key back to the surface underneath when the newer one closes", () => {
    const first = vi.fn();
    const second = vi.fn();
    claim(first);
    const closeSecond = claim(second);

    closeSecond();
    pressR(undefined);

    expect(first).toHaveBeenCalledTimes(1);
  });

  it("ignores modified presses, which belong to the app's own chords", () => {
    const handler = vi.fn();
    claim(handler);

    pressR({ metaKey: true });
    pressR({ ctrlKey: true });
    pressR({ altKey: true });
    pressR({ shiftKey: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it("stops listening at the window once the last owner releases", () => {
    const handler = vi.fn();
    const release = claim(handler);
    const added = vi.spyOn(window, "removeEventListener");

    release();

    expect(added).toHaveBeenCalledWith("keydown", expect.any(Function));
    pressR(undefined);
    expect(handler).not.toHaveBeenCalled();
    added.mockRestore();
  });
});
