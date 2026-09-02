import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";

const HREF = "https://github.com/acme/widgets/pull/7";

const openLink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => openLink }));

function renderLink(): void {
  render(
    <PrExternalGitHubLink
      href={HREF}
      className="link"
      testId="pr-external-github-link"
    >
      View on GitHub
    </PrExternalGitHubLink>,
  );
}

afterEach(() => {
  cleanup();
  openLink.mockReset();
});

describe("PrExternalGitHubLink", () => {
  it("routes a click through openLink exactly once, and prevents the native navigation", () => {
    renderLink();

    const link = screen.getByTestId<HTMLAnchorElement>(
      "pr-external-github-link",
    );
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith(HREF, "github", expect.anything());
  });

  it("carries no target/rel - the click never navigates natively", () => {
    renderLink();

    const link = screen.getByTestId<HTMLAnchorElement>(
      "pr-external-github-link",
    );
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("rel")).toBeNull();
    expect(link.getAttribute("href")).toBe(HREF);
  });

  it("routes a rapid second click through openLink as well - no in-flight guard anymore", () => {
    renderLink();

    const link = screen.getByTestId("pr-external-github-link");
    fireEvent.click(link);
    fireEvent.click(link);

    expect(openLink).toHaveBeenCalledTimes(2);
  });
});
