import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The host picker's paid-plan gating: on a free plan, remote rows are inert
 * with a "Paid plan" affordance and the upsell notice links to subscription
 * management; on a paid plan the same rows select normally. The plan verdict
 * itself is `useRemoteHostsPlanRestricted`'s (tested separately) — here it is
 * driven directly.
 */

const mocks = vi.hoisted(() => ({
  planRestricted: vi.fn<() => boolean>(() => false),
  selectById: vi.fn(),
  openExternalLink: vi.fn(() => Promise.resolve()),
  requestClose: vi.fn(),
}));

vi.mock("@/hooks/host/use-remote-hosts-plan-gate", () => ({
  useRemoteHostsPlanRestricted: mocks.planRestricted,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.traycer.ai",
    openExternalLink: mocks.openExternalLink,
    hostPicker: {
      isOpen: true,
      onChange: () => ({ dispose: () => undefined }),
      requestOpen: () => undefined,
      requestClose: mocks.requestClose,
    },
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: {
      selectById: mocks.selectById,
      onChange: () => ({ dispose: () => undefined }),
    },
    hostClient: {
      onChange: () => () => undefined,
      getActiveHostId: () => "local-1",
    },
  }),
}));

vi.mock("@/hooks/host/use-refresh-host-directory-on-open", () => ({
  useRefreshHostDirectoryOnOpen: () => undefined,
}));

vi.mock("@/hooks/host/use-host-picker-list", () => ({
  registerHostPickerDirectory: () => "picker-directory-1",
  useHostPickerList: () => ({
    isLoading: false,
    isError: false,
    data: [
      {
        hostId: "local-1",
        label: "This Mac",
        kind: "local",
        status: "available",
      },
      {
        hostId: "remote-1",
        label: "Office workstation",
        kind: "remote",
        status: "available",
      },
    ],
  }),
}));

import { HostPicker } from "@/components/layout/header/host-picker";

beforeEach(() => {
  mocks.planRestricted.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HostPicker paid-plan gating", () => {
  it("free plan: remote rows are inert with a Paid plan affordance, and the upsell links to subscription management", () => {
    mocks.planRestricted.mockReturnValue(true);
    render(<HostPicker />);

    const remote = screen.getByTestId("host-picker-option-remote-1");
    expect(remote.getAttribute("data-plan-restricted")).toBe("true");
    expect((remote as HTMLButtonElement).disabled).toBe(true);
    expect(remote.textContent).toContain("Paid plan");
    fireEvent.click(remote);
    expect(mocks.selectById).not.toHaveBeenCalled();

    // Local operation stays fully available on the free plan.
    const local = screen.getByTestId("host-picker-option-local-1");
    expect((local as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(local);
    expect(mocks.selectById).toHaveBeenCalledWith("local-1");

    expect(screen.getByTestId("host-picker-remote-upsell")).toBeDefined();
    fireEvent.click(screen.getByTestId("host-picker-remote-upsell-upgrade"));
    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "https://platform.traycer.ai",
    );
  });

  it("paid plan: remote rows select normally and no upsell renders", () => {
    mocks.planRestricted.mockReturnValue(false);
    render(<HostPicker />);

    expect(screen.queryByTestId("host-picker-remote-upsell")).toBeNull();
    const remote = screen.getByTestId("host-picker-option-remote-1");
    expect(remote.getAttribute("data-plan-restricted")).toBe("false");
    expect((remote as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(remote);
    expect(mocks.selectById).toHaveBeenCalledWith("remote-1");
    expect(mocks.requestClose).toHaveBeenCalled();
  });
});
