import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/layout/header/app-header";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The header's two clusters (L-156).
 *
 * The desktop header's own children need host, query and auth providers, so
 * they are stubbed to the markers this suite is about: what is asserted is
 * WHERE each reading is drawn and under whose name, which is the header's own
 * decision, not what the gauge or the monitor draw inside it.
 */
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
  isMobileViewport: () => false,
}));
vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div role="tablist" aria-label="Open tabs" />,
}));
vi.mock("@/hooks/appearance/use-header-tab-appearance", () => ({
  useHeaderTabAppearance: () => null,
}));
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => null,
}));
vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => null,
}));
vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => null,
}));
vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => null,
}));
vi.mock("@/components/auth/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => null,
}));
vi.mock("@/components/layout/header/desktop-menu-bar", () => ({
  DesktopMenuBar: () => null,
}));
/**
 * The two live triggers, stubbed at their own boundary.
 *
 * Both reach for the host runtime, the query client and the rate-limit
 * subscription the moment they mount, which is a provider stack this suite
 * has no business standing up to answer a question about WHERE the header
 * draws them. What the stubs keep is the two props the header decides:
 * `claimsOpenAction` (the header's claim on `app.resources.open`) and `form`
 * (readings at their own width in the header, `"inline"`, since G6 - not the
 * glyph either trigger drew here before).
 */
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: (props: { readonly form: string }) => (
    <button
      type="button"
      data-testid="header-usage-trigger"
      data-form={props.form}
    />
  ),
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: (props: {
    readonly claimsOpenAction: boolean;
    readonly form: string;
  }) => (
    <button
      type="button"
      data-testid="header-resource-trigger"
      data-claims-open-action={props.claimsOpenAction ? "true" : "false"}
      data-form={props.form}
    />
  ),
}));

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

function place(patch: Partial<LayoutArrangement>): void {
  useLayoutStore
    .getState()
    .setArrangement({ ...DEFAULT_ARRANGEMENT, ...patch });
}

/** The region names the header is carrying, in document order. */
function headerRegions(): ReadonlyArray<string> {
  return [
    ...screen
      .getByTestId("app-header")
      .querySelectorAll("[data-layout-region]"),
  ].map((node) => node.getAttribute("data-layout-region") ?? "");
}

/** Whether a node sits before the tab strip in the header's own row. */
function beforeTabs(node: Element): boolean {
  const tabs = screen.getByRole("tablist", { name: "Open tabs" });
  return Boolean(
    node.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe("the header's bar clusters (L-156)", () => {
  it("draws neither reading while both are in the strip", () => {
    render(<AppHeader variant="app" />);

    expect(headerRegions()).toEqual([]);
    expect(screen.queryByTestId("header-usage-trigger")).toBeNull();
    expect(screen.queryByTestId("header-resource-trigger")).toBeNull();
  });

  it("draws the reading that named the header, at the end it named", () => {
    place({ usageHost: "header", usageSide: "left" });
    render(<AppHeader variant="app" />);

    expect(headerRegions()).toEqual(["usageLimits"]);
    expect(screen.getByTestId("header-usage-trigger")).not.toBeNull();
    expect(beforeTabs(screen.getByTestId("header-usage-trigger"))).toBe(true);
    cleanup();

    place({ usageHost: "header", usageSide: "right" });
    render(<AppHeader variant="app" />);

    expect(beforeTabs(screen.getByTestId("header-usage-trigger"))).toBe(false);
    cleanup();

    // The monitor ships on the right, so moving it up without touching its
    // side puts it after the tabs.
    place({ usageHost: "header", resourceHost: "header" });
    render(<AppHeader variant="app" />);

    expect(beforeTabs(screen.getByTestId("header-resource-trigger"))).toBe(
      false,
    );
  });

  it("hands both readings the header's own form, not the strip's glyph (G6)", () => {
    place({ usageHost: "header", resourceHost: "header" });
    render(<AppHeader variant="app" />);

    expect(screen.getByTestId("header-usage-trigger").dataset.form).toBe(
      "inline",
    );
    expect(screen.getByTestId("header-resource-trigger").dataset.form).toBe(
      "inline",
    );
  });

  it("moves the resource monitor up on its own, leaving usage in the strip", () => {
    place({ resourceHost: "header", resourceSide: "right" });
    render(<AppHeader variant="app" />);

    // The monitor's trigger is here and the gauge is not: before L-156 this
    // state was unreachable, because one field moved both.
    expect(headerRegions()).toEqual(["resourceMonitor"]);
    expect(screen.queryByTestId("header-usage-trigger")).toBeNull();
    // One handler slot, two possible owners, and they are exclusive by
    // placement on a desktop viewport: the strip draws the monitor only while
    // `resourceHost` names the strip, so the header's claim is unconditional
    // wherever the header is the one drawing it.
    expect(
      screen.getByTestId("header-resource-trigger").dataset.claimsOpenAction,
    ).toBe("true");
  });

  it("keeps a hidden reading pointable in the header, under its own name", () => {
    place({ resourceHost: "header" });
    useLayoutStore
      .getState()
      .setRegionValues("resourceMonitor", { shown: "hidden" });
    render(<AppHeader variant="app" />);

    // The region is still the header's, named by its own id, so a right-click
    // lands on it and the editor can point at it (L-129) - and the live
    // control, which streams, is not mounted (L-62).
    expect(headerRegions()).toEqual(["resourceMonitor"]);
    expect(screen.queryByTestId("header-resource-trigger")).toBeNull();
  });
});
