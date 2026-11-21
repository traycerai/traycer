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
        showLater
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
        showLater
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
        showLater
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
        showLater
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
        showLater
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(toastDismissMock).toHaveBeenCalledWith("toast-1");
  });

  it("keeps Later when an existing caller passes a description", () => {
    render(
      <ActionToastContent
        toastId="toast-1"
        eyebrow={null}
        title="Update available"
        description="A new version is ready."
        actionLabel="Download"
        onAction={() => undefined}
        onLater={null}
        showLater
      />,
    );

    expect(screen.getByRole("button", { name: "Later" })).not.toBeNull();
    expect(screen.getByText("A new version is ready.")).not.toBeNull();
  });

  it("omits Later and the description line when both are off", () => {
    render(
      <ActionToastContent
        toastId="toast-1"
        eyebrow={null}
        title="Accounts synced with MacBook Air"
        description={null}
        actionLabel="Choose…"
        onAction={() => undefined}
        onLater={null}
        showLater={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose…" })).not.toBeNull();
    const title = screen.getByText("Accounts synced with MacBook Air");
    expect(title.parentElement?.textContent).toBe(
      "Accounts synced with MacBook Air",
    );
  });
});
