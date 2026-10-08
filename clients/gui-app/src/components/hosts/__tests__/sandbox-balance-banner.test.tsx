import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import type { SandboxRunwayWarning } from "@/lib/sandboxes/sandbox-balance";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const mocks = vi.hoisted(() => ({
  list: undefined as SandboxListResponse | undefined,
  warning: { kind: "none" } as SandboxRunwayWarning,
  warningReads: vi.fn(),
  refreshMounts: vi.fn(),
}));

vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: mocks.list }),
}));
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => {
    mocks.refreshMounts();
  },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => {
    mocks.warningReads();
    return mocks.warning;
  },
}));

import {
  SandboxBalanceBanner,
  SandboxRunwayWarningLine,
} from "@/components/hosts/sandbox-balance-banner";

beforeEach(() => {
  mocks.list = undefined;
  mocks.warning = { kind: "none" };
  mocks.warningReads.mockClear();
  mocks.refreshMounts.mockClear();
});
afterEach(cleanup);

describe("<SandboxRunwayWarningLine />", () => {
  it("renders nothing while the balance covers more than two hours", () => {
    const { container } = render(
      <SandboxRunwayWarningLine warning={{ kind: "none" }} />,
    );
    expect(container.textContent).toBe("");
  });

  it("warns that credits cover about the runway at the current burn (under two hours)", () => {
    render(
      <SandboxRunwayWarningLine
        warning={{ kind: "low", runwayMinutes: 100 }}
      />,
    );
    const line = screen.getByTestId("sandbox-balance-warning");
    expect(line.getAttribute("data-level")).toBe("low");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe(
      "Credits cover about 1 h 40 min at your sandboxes' current burn. Add credits to keep them running.",
    );
  });

  it("warns louder, and says what freezes, under thirty minutes", () => {
    render(
      <SandboxRunwayWarningLine
        warning={{ kind: "critical", runwayMinutes: 25 }}
      />,
    );
    const line = screen.getByTestId("sandbox-balance-warning");
    expect(line.getAttribute("data-level")).toBe("critical");
    expect(line.textContent).toBe(
      "Credits run out in 25 min at your sandboxes' current burn. Awake sandboxes freeze when they do; add credits to keep them running.",
    );
  });
});

describe("<SandboxBalanceBanner />", () => {
  it("reads no cost, mounts no refresher and renders nothing for a user with no sandboxes", () => {
    mocks.list = { sandboxes: [] };
    mocks.warning = { kind: "critical", runwayMinutes: 5 };
    const { container } = render(<SandboxBalanceBanner />);
    expect(container.textContent).toBe("");
    expect(mocks.warningReads).not.toHaveBeenCalled();
    expect(mocks.refreshMounts).not.toHaveBeenCalled();
  });

  it("reads no cost before the sandbox list has answered", () => {
    mocks.list = undefined;
    render(<SandboxBalanceBanner />);
    expect(mocks.warningReads).not.toHaveBeenCalled();
  });

  it("shows the live warning once the user has a sandbox, and refreshes the figures", () => {
    mocks.list = { sandboxes: [sandboxSummaryFixture({})] };
    mocks.warning = { kind: "low", runwayMinutes: 90 };
    render(<SandboxBalanceBanner />);
    expect(mocks.refreshMounts).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("sandbox-balance-warning").textContent).toContain(
      "1 h 30 min",
    );
  });

  it("shows nothing for a user with sandboxes whose balance is comfortable", () => {
    mocks.list = { sandboxes: [sandboxSummaryFixture({})] };
    mocks.warning = { kind: "none" };
    render(<SandboxBalanceBanner />);
    expect(screen.queryByTestId("sandbox-balance-warning")).toBeNull();
  });
});
