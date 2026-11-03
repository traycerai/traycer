import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTabSwitcherMount } from "@/components/epic-canvas/mobile/mobile-tab-switcher-mount";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";

// The sheet pulls the resolved-theme context and every embedded panel body with
// it; this file is about the mount's REGISTRATION, so stub it to a marker
// carrying the open flag it was handed.
vi.mock("@/components/epic-canvas/mobile/tab-switcher-sheet", () => ({
  TabSwitcherSheet: (props: { readonly open: boolean }) => (
    <div data-testid="sheet" data-open={props.open ? "true" : "false"} />
  ),
}));

function mountedFor(tabId: string): boolean {
  return (useMobileSwitcherStore.getState().mountCountByTabId[tabId] ?? 0) > 0;
}

describe("<MobileTabSwitcherMount />", () => {
  beforeEach(() => {
    useMobileSwitcherStore.setState({ openTabId: null, mountCountByTabId: {} });
  });
  afterEach(cleanup);

  it("registers its tab while mounted and unregisters on unmount", () => {
    expect(mountedFor("tab-1")).toBe(false);
    const { unmount } = render(
      <MobileTabSwitcherMount epicId="epic-1" tabId="tab-1" />,
    );
    expect(mountedFor("tab-1")).toBe(true);
    unmount();
    expect(mountedFor("tab-1")).toBe(false);
  });

  it("registers per tab, so one tab's mount says nothing about another's", () => {
    render(<MobileTabSwitcherMount epicId="epic-1" tabId="tab-1" />);
    expect(mountedFor("tab-2")).toBe(false);
  });

  /**
   * The count, not a set: two mounts for the same tab overlap across a canvas
   * branch swap, and the tab has to stay registered until the last one goes.
   */
  it("stays registered while a second mount for the same tab is alive", () => {
    const first = render(
      <MobileTabSwitcherMount epicId="epic-1" tabId="tab-1" />,
    );
    render(<MobileTabSwitcherMount epicId="epic-1" tabId="tab-1" />);
    first.unmount();
    expect(mountedFor("tab-1")).toBe(true);
  });

  it("renders the sheet open when the store opens its tab", () => {
    render(<MobileTabSwitcherMount epicId="epic-1" tabId="tab-1" />);
    expect(screen.getByTestId("sheet").getAttribute("data-open")).toBe("false");
    act(() => useMobileSwitcherStore.getState().setOpen("tab-1", true));
    expect(screen.getByTestId("sheet").getAttribute("data-open")).toBe("true");
  });

  /**
   * Losing the last mount is not the user closing the sheet. Clearing the flag
   * here would shut a sheet that is open across a branch swap; the trigger is
   * kept honest by the registration above instead.
   */
  it("leaves the open flag alone when it unmounts", () => {
    const { unmount } = render(
      <MobileTabSwitcherMount epicId="epic-1" tabId="tab-1" />,
    );
    act(() => useMobileSwitcherStore.getState().setOpen("tab-1", true));
    unmount();
    expect(useMobileSwitcherStore.getState().openTabId).toBe("tab-1");
  });
});
