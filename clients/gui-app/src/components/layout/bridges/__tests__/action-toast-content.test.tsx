import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionToastContent } from "@/components/layout/bridges/action-toast-content";

const toastDismissMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { dismiss: toastDismissMock },
}));

beforeEach(() => {
  toastDismissMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("<ActionToastContent />", () => {
  it("renders eyebrow, title and description", () => {
    render(
      <ActionToastContent
        toastId="toast-1"
        eyebrow="New in this release"
        title="Bring your logins with you"
        description="Import the sites you're signed into."
        actionLabel="Import logins…"
        onAction={() => undefined}
        onLater={null}
      />,
    );

    expect(screen.getByText("New in this release")).not.toBeNull();
    expect(screen.getByText("Bring your logins with you")).not.toBeNull();
    expect(
      screen.getByText("Import the sites you're signed into."),
    ).not.toBeNull();
  });

  it("renders no eyebrow line when eyebrow is null", () => {
    render(
      <ActionToastContent
        toastId="toast-1"
        eyebrow={null}
        title="Update available"
        description="A new version is ready."
        actionLabel="Download"
        onAction={() => undefined}
        onLater={null}
      />,
    );

    expect(screen.queryByText("New in this release")).toBeNull();
  });

  it("fires the action once across two clicks and disables the button after firing", () => {
    const onAction = vi.fn();
    render(
      <ActionToastContent
        toastId="toast-1"
        eyebrow={null}
        title="Update available"
        description="A new version is ready."
        actionLabel="Download"
        onAction={onAction}
        onLater={null}
      />,
    );

    const actionButton = screen.getByRole("button", { name: "Download" });
    fireEvent.click(actionButton);
    fireEvent.click(actionButton);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(actionButton.hasAttribute("disabled")).toBe(true);
    expect(toastDismissMock).toHaveBeenCalledWith("toast-1");
  });

  it("Later dismisses the toast by id and calls onLater when given", () => {
    const onLater = vi.fn();
    render(
      <ActionToastContent
        toastId="toast-1"
        eyebrow={null}
        title="Update available"
        description="A new version is ready."
        actionLabel="Download"
        onAction={() => undefined}
        onLater={onLater}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(toastDismissMock).toHaveBeenCalledWith("toast-1");
    expect(onLater).toHaveBeenCalledTimes(1);
  });

  it("Later dismisses without calling anything when onLater is null", () => {
    render(
      <ActionToastContent
        toastId="toast-1"
        eyebrow={null}
        title="Update available"
        description="A new version is ready."
        actionLabel="Download"
        onAction={() => undefined}
        onLater={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(toastDismissMock).toHaveBeenCalledWith("toast-1");
  });
});
