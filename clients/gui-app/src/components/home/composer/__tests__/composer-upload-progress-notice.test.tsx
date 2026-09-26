import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerUploadProgressNotice } from "@/components/home/composer/composer-upload-progress-notice";

afterEach(() => {
  cleanup();
});

describe("ComposerUploadProgressNotice", () => {
  it("renders nothing for a null progress", () => {
    render(<ComposerUploadProgressNotice progress={null} />);
    // Plain null check, not jest-dom's `toBeInTheDocument()`: this repo does
    // not register those matchers.
    expect(screen.queryByTestId("composer-upload-progress")).toBeNull();
  });

  it("shows the preparing line while total is still zero", () => {
    render(
      <ComposerUploadProgressNotice progress={{ completed: 0, total: 0 }} />,
    );
    // `total: 0` is the "diffing the plan against the memo" window - before the
    // leaf knows how many bodies it will actually send, and also the state
    // `dispatchByHashSubmission` resets to right before the inline fallback's
    // encode. Both must read the same "preparing", not a stale "k of N".
    expect(screen.getByText("Preparing images…")).not.toBeNull();
  });

  it("shows the k-of-N line once total is known", () => {
    render(
      <ComposerUploadProgressNotice progress={{ completed: 2, total: 5 }} />,
    );
    expect(screen.getByText("Uploading images 2 of 5…")).not.toBeNull();
  });

  it("renders nothing once progress clears to null", () => {
    const { rerender } = render(
      <ComposerUploadProgressNotice progress={{ completed: 5, total: 5 }} />,
    );
    expect(screen.getByTestId("composer-upload-progress")).not.toBeNull();

    rerender(<ComposerUploadProgressNotice progress={null} />);
    expect(screen.queryByTestId("composer-upload-progress")).toBeNull();
  });
});
