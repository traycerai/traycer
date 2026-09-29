import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostUnsupported } from "../empty-states/host-unsupported";

describe("HostUnsupported", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title and reason", () => {
    render(<HostUnsupported reason="git not found in PATH" />);

    expect(screen.getByText("Git panel unavailable")).toBeDefined();
    expect(screen.getByText("git not found in PATH")).toBeDefined();
  });

  it("renders update host link with placeholder href", () => {
    render(<HostUnsupported reason="host too old (no git.* methods)" />);

    const link = screen.getByRole("link", { name: /Update Traycer Host/i });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("#update-host");
    // A real <a>: no aria-role override (the button-styling classes must not
    // carry `role="button"` along with them).
    expect(link.getAttribute("role")).toBeNull();
    expect(link.tagName).toBe("A");
  });

  it("keeps real link keyboard semantics: Enter activates it, Space does not", async () => {
    // Regression for the Base UI Button(nativeButton=false) mistake this
    // reverted from - that primitive also activates on Space even when it
    // renders an <a>, which a real link must not.
    const user = userEvent.setup();
    render(<HostUnsupported reason="git not found in PATH" />);
    const link = screen.getByRole("link", { name: /Update Traycer Host/i });
    const onClick = vi.fn();
    link.addEventListener("click", onClick);
    link.focus();

    await user.keyboard(" ");
    expect(onClick).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders with various reason strings", () => {
    const reasons = [
      "git not found in PATH",
      "host too old (no git.* methods)",
      "repo exceeds 5M files (refused mode)",
      "git unavailable",
    ];

    reasons.forEach((reason) => {
      const { unmount } = render(<HostUnsupported reason={reason} />);
      expect(screen.getByText(reason)).toBeDefined();
      unmount();
    });
  });
});
