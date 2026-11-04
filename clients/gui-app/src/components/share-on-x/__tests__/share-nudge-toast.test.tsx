import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShareNudgeToastContent,
  type ShareNudgeChoice,
} from "@/components/share-on-x/share-nudge-toast";

function renderToast() {
  const onChoose = vi.fn<(choice: ShareNudgeChoice) => void>();
  render(<ShareNudgeToastContent onChoose={onChoose} />);
  return onChoose;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("<ShareNudgeToastContent />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("chooses a timeout once, after ten seconds", () => {
    const onChoose = renderToast();

    advance(9_800);
    expect(onChoose).not.toHaveBeenCalled();

    advance(200);
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("timeout");

    advance(30_000);
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("counts the seconds down on Remind me later", () => {
    renderToast();
    expect(
      screen.getByRole("button", { name: /Remind me later/ }).textContent,
    ).toContain("10s");

    advance(3_000);

    expect(
      screen.getByRole("button", { name: /Remind me later/ }).textContent,
    ).toContain("7s");
  });

  it("pauses while the pointer is over the toast, and resumes when it leaves", () => {
    const onChoose = renderToast();
    const toast = screen.getByTestId("share-nudge-toast");

    advance(4_000);
    fireEvent.pointerEnter(toast);
    advance(60_000);

    expect(onChoose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Remind me later/ }).textContent,
    ).toContain("6s");

    fireEvent.pointerLeave(toast);
    advance(6_000);

    expect(onChoose).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("pauses while focus is inside the toast, and resumes when it leaves", () => {
    const onChoose = renderToast();
    const share = screen.getByRole("button", { name: /Share on X/ });

    act(() => {
      share.focus();
    });
    advance(60_000);
    expect(onChoose).not.toHaveBeenCalled();

    act(() => {
      share.blur();
    });
    advance(10_000);

    expect(onChoose).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it.each([
    [/Share on X/, "share"],
    [/Remind me later/, "remind_later"],
    [/Don't ask again/, "opt_out"],
  ] as const)("%s chooses %s once", (name, choice) => {
    const onChoose = renderToast();
    const button = screen.getByRole("button", { name });

    fireEvent.click(button);
    fireEvent.click(button);
    advance(20_000);

    expect(onChoose).toHaveBeenCalledExactlyOnceWith(choice);
  });
});
