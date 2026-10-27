import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { nextSettledTabIdentity } from "@/lib/browser-view/browser-tab-display";
import { BrowserDeviceGroup } from "../browser-device-group";
import type { BrowserDeviceGroupModel } from "../use-browser-list-model";
import type { BrowserSidebarTabRow } from "../use-browser-tab-rows";

function row(tabId: string): BrowserSidebarTabRow {
  const tab = {
    tabId,
    url: `https://${tabId}.example`,
    title: tabId,
    status: null,
    drivenBy: [],
  };
  return {
    key: tabId,
    session: {
      hostId: "host-2",
      sessionId: "s",
      profile: null,
      tabs: [tab],
    },
    tab,
    identity: nextSettledTabIdentity(null, tab),
  };
}

function group(
  overrides: Partial<BrowserDeviceGroupModel>,
): BrowserDeviceGroupModel {
  return {
    hostId: "host-2",
    name: "Work Mac",
    isLocal: false,
    offline: false,
    expanded: true,
    rows: [row("a"), row("b")],
    ...overrides,
  };
}

function mount(
  model: BrowserDeviceGroupModel,
  onExpandedChange: Mock<(hostId: string, expanded: boolean) => void>,
) {
  render(
    <BrowserDeviceGroup
      group={model}
      onExpandedChange={onExpandedChange}
      mobile={false}
    >
      <div data-testid="rows">rows</div>
    </BrowserDeviceGroup>,
  );
}

describe("BrowserDeviceGroup", () => {
  afterEach(cleanup);

  it("names the device, shows its visible tab count and exposes expansion on a native button", () => {
    mount(group({}), vi.fn());
    const header = screen.getByRole("button", { name: /Work Mac/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("2 tabs").textContent).toBe("2");
    expect(screen.queryByText("Local")).toBeNull();
    expect(screen.queryByText("Offline")).toBeNull();
  });

  it("labels the co-located device Local and a known-offline one Offline", () => {
    mount(group({ isLocal: true, offline: true }), vi.fn());
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it("hides the rows, not the header, when collapsed", () => {
    mount(group({ expanded: false }), vi.fn());
    expect(
      screen
        .getByRole("button", { name: /Work Mac/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.getByTestId("rows").parentElement?.hidden).toBe(true);
  });

  it("toggles on click, Enter and Space, and expands or collapses on the arrow keys", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(hostId: string, expanded: boolean) => void>();
    mount(group({ expanded: true }), onChange);
    const header = screen.getByRole("button", { name: /Work Mac/ });

    await user.click(header);
    expect(onChange).toHaveBeenLastCalledWith("host-2", false);

    header.focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("host-2", false);
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith("host-2", false);

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("host-2", false);
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("host-2", true);
  });
});
