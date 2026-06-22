import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RootErrorBoundary } from "@/components/errors/root-error-boundary";
import { router } from "@/router";

function Boom(): never {
  throw new Error("boom from a provider");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<RootErrorBoundary />", () => {
  it("renders children when nothing throws", () => {
    render(
      <RootErrorBoundary router={router}>
        <div data-testid="ok-child" />
      </RootErrorBoundary>,
    );

    expect(screen.getByTestId("ok-child")).toBeTruthy();
    expect(screen.queryByTestId("app-error-screen")).toBeNull();
  });

  it("catches a child crash and shows the recovery card", () => {
    // The thrown error is logged by React and by `componentDidCatch`; silence
    // the noise and assert the boundary logged it.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <RootErrorBoundary router={router}>
        <Boom />
      </RootErrorBoundary>,
    );

    expect(screen.getByTestId("app-error-screen")).toBeTruthy();
    expect(consoleError).toHaveBeenCalled();
  });

  it("navigates home when Return to Home is clicked", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const navigateSpy = vi
      .spyOn(router, "navigate")
      .mockResolvedValue(undefined);

    render(
      <RootErrorBoundary router={router}>
        <Boom />
      </RootErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /return to home/i }));
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/" });
  });
});
