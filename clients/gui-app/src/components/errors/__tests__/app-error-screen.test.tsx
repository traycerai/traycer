import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppErrorScreen } from "@/components/errors/app-error-screen";

afterEach(() => {
  cleanup();
});

describe("<AppErrorScreen />", () => {
  it("renders the recovery card with both actions and the error detail", () => {
    const onRefresh = vi.fn();
    const onReturnHome = vi.fn();
    render(
      <AppErrorScreen
        error={new Error("Cannot subscribe with a closed WsStreamClient.")}
        onRefresh={onRefresh}
        onReturnHome={onReturnHome}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(
      screen.getByText("Cannot subscribe with a closed WsStreamClient."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /refresh window/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onReturnHome).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /return to home/i }));
    expect(onReturnHome).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("omits the detail line when the error carries no message", () => {
    render(
      <AppErrorScreen
        error={null}
        onRefresh={() => undefined}
        onReturnHome={() => undefined}
      />,
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /refresh window/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /return to home/i }),
    ).toBeTruthy();
  });

  it("truncates an overly long error message", () => {
    render(
      <AppErrorScreen
        error={new Error("x".repeat(500))}
        onRefresh={() => undefined}
        onReturnHome={() => undefined}
      />,
    );

    const detail = screen.getByText(/x{100,}/);
    const text = String(detail.textContent);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(301);
  });
});
