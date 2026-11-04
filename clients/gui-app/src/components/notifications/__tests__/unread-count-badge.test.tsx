import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UnreadCountBadge } from "../unread-count-badge";

afterEach(() => cleanup());

describe("<UnreadCountBadge />", () => {
  it("draws an inline count as the quiet muted tag, announced as unread", () => {
    render(
      <UnreadCountBadge count={3} size="sm" testId="count" corner={null} />,
    );

    const badge = screen.getByTestId("count");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.getAttribute("data-variant")).toBe("muted");
    expect(badge.classList.contains("border-border/60")).toBe(true);
    expect(badge.classList.contains("text-muted-foreground")).toBe(true);
    expect(badge.getAttribute("aria-hidden")).toBeNull();
    expect(badge.textContent).toBe("3 unread");
  });

  it("seats a corner count as the solid fill, hidden from assistive tech and placed by the caller", () => {
    render(
      <UnreadCountBadge
        count={120}
        size="xs"
        testId="count"
        corner="absolute -top-1 -right-1"
      />,
    );

    const badge = screen.getByTestId("count");
    expect(badge.getAttribute("data-variant")).toBe("default");
    expect(badge.classList.contains("bg-primary")).toBe(true);
    expect(badge.classList.contains("text-primary-foreground")).toBe(true);
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.classList.contains("absolute")).toBe(true);
    expect(badge.classList.contains("-top-1")).toBe(true);
    expect(badge.textContent).toBe("99+");
  });

  it("draws nothing at zero", () => {
    render(
      <UnreadCountBadge count={0} size="sm" testId="count" corner={null} />,
    );

    expect(screen.queryByTestId("count")).toBeNull();
  });
});
