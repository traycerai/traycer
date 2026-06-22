import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
