import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";

const HREF = "https://github.com/acme/widgets/pull/7";

// The seam returns a promise the caller voids; a bare `vi.fn()` answers
// `undefined` and takes the component down inside the handler.
const openLink = vi.hoisted(() => vi.fn(() => Promise.resolve()));
/** The bridge mutation's pending flag, driven per test. */
const bridge = vi.hoisted(() => ({ isPending: false }));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLink,
  useOpenLinkWithPending: () => ({ isPending: bridge.isPending, openLink }),
}));

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
  bridge.isPending = false;
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

  it("drops a click while an OS handoff is still in flight", () => {
    // Each call fires a fresh bridge request, so a click landing on top of one
    // would open a second OS tab (R10).
    bridge.isPending = true;
    renderLink();

    const link = screen.getByTestId("pr-external-github-link");
    fireEvent.click(link);

    expect(openLink).not.toHaveBeenCalled();
    expect(link.getAttribute("aria-disabled")).toBe("true");
  });
});
