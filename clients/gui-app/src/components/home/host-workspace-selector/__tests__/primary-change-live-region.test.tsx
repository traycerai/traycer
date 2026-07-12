import "../../../../../__tests__/test-browser-apis";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PrimaryChangeLiveRegion } from "../primary-change-live-region";
import { usePrimaryChangeAnnouncement } from "../use-primary-change-announcement";

// Minimal harness mirroring HomeWorkspaceRows' wiring: the hook owns the
// announcement, the region renders it, and the announce callback is exposed
// (via an effect, never during render) for the test to drive like a row
// action would.
let announceRef: ((folderName: string) => void) | null = null;

function Harness() {
  const { announcement, announcePrimaryChange } =
    usePrimaryChangeAnnouncement();
  useEffect(() => {
    announceRef = announcePrimaryChange;
  }, [announcePrimaryChange]);
  return <PrimaryChangeLiveRegion announcement={announcement} />;
}

afterEach(() => {
  cleanup();
  announceRef = null;
});

describe("PrimaryChangeLiveRegion", () => {
  it("renders a polite live region and announces an explicit primary switch", () => {
    render(<Harness />);
    const region = screen.getByTestId("primary-change-live-region");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");

    act(() => announceRef?.("traycer"));

    expect(region.textContent).toBe("traycer is now primary");
  });

  it("announces a removal-fallback reassignment after a prior switch", () => {
    render(<Harness />);
    const region = screen.getByTestId("primary-change-live-region");

    // Explicit switch, then removing that primary falls back to another
    // folder - two distinct messages, both must land in the region.
    act(() => announceRef?.("repo-b"));
    expect(region.textContent).toBe("repo-b is now primary");
    act(() => announceRef?.("repo-a"));
    expect(region.textContent).toBe("repo-a is now primary");
  });

  it("re-announces consecutive IDENTICAL messages (duplicate folder basenames) by remounting the text node", () => {
    render(<Harness />);
    const region = screen.getByTestId("primary-change-live-region");

    // Two folders with the same basename ("repo" at /a/repo and /b/repo):
    // switching to one, then removal-falling-back to the other produces the
    // SAME message twice. A plain-string state would bail in React on the
    // second announce and never mutate the live-region DOM.
    act(() => announceRef?.("repo"));
    const firstNode = region.firstElementChild;
    expect(firstNode?.textContent).toBe("repo is now primary");

    act(() => announceRef?.("repo"));
    const secondNode = region.firstElementChild;
    expect(secondNode?.textContent).toBe("repo is now primary");
    // The seq-keyed child was REMOUNTED - a real DOM mutation, which is what
    // screen readers need to re-announce identical text.
    expect(secondNode).not.toBe(firstNode);
  });
});
