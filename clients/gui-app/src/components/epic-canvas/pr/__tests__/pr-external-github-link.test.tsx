import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";

const HREF = "https://github.com/acme/widgets/pull/7";

// The seam returns a promise the in-flight guard chains on; a bare `vi.fn()`
// answers `undefined` and takes the component down inside the handler.
const openLink = vi.hoisted(() => vi.fn(() => Promise.resolve()));
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
  openLink.mockImplementation(() => Promise.resolve());
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

  it("hands the modifier keys to openLink so ctrl-click can force external", () => {
    renderLink();

    fireEvent.click(screen.getByTestId("pr-external-github-link"), {
      ctrlKey: true,
    });

    // `github` is a CONFIGURABLE kind, so the modifiers are the only way a
    // click overrides the setting - dropping the event would kill them.
    expect(openLink).toHaveBeenCalledWith(
      HREF,
      "github",
      expect.objectContaining({ ctrlKey: true, metaKey: false, altKey: false }),
    );
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

  it("drops a rapid second click while the first OS handoff is in flight", () => {
    let settle = (): void => undefined;
    openLink.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    renderLink();

    const link = screen.getByTestId("pr-external-github-link");
    fireEvent.click(link);
    fireEvent.click(link);

    // Each call fires a fresh bridge request, so an unguarded double click
    // opens two OS tabs (R10).
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(link.getAttribute("aria-disabled")).toBe("true");
    settle();
  });
});
