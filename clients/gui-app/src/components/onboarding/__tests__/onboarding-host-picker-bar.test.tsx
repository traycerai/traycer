import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OnboardingHostPicker } from "@/components/onboarding/onboarding-host-picker-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

// The switcher reads the host binding for its update badges, and the bar opts
// into the liveness poll; this suite is about which rows the bar offers.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

import { OnboardingHostPickerBar } from "@/components/onboarding/onboarding-host-picker";

afterEach(cleanup);

const LAPTOP = hostScopeOptionFixture({
  hostId: "laptop",
  name: "Laptop",
  isActive: true,
});
const DESKTOP = hostScopeOptionFixture({
  hostId: "desktop",
  name: "Desktop",
  isLocalMachine: false,
  isActive: false,
});
const SANDBOX = hostScopeOptionFixture({
  hostId: "sbx-awake",
  name: "Build box",
  isLocalMachine: false,
  isActive: false,
  connectable: true,
  kind: "sandbox",
  sandbox: {
    state: "awake",
    frozen: false,
    summary: sandboxSummaryFixture({ hostId: "sbx-awake", burst: false }),
  },
});

function pickerOver(
  hosts: readonly HostScopeOption[],
  selected: HostScopeOption,
): OnboardingHostPicker {
  return {
    scope: hostScopeFixture({ host: selected, hosts }),
    onSelectHost: () => undefined,
    hasExplicitPick: false,
    streamOnPickedHost: true,
  };
}

function renderBar(picker: OnboardingHostPicker): void {
  render(<OnboardingHostPickerBar picker={picker} className="" />);
}

describe("<OnboardingHostPickerBar /> credential targets", () => {
  it("never offers a sandbox among the hosts the tour can pick", () => {
    renderBar(pickerOver([LAPTOP, DESKTOP, SANDBOX], LAPTOP));
    fireEvent.click(screen.getByTestId("settings-host-switcher"));

    expect(
      screen.getByTestId("settings-host-switcher-option-desktop"),
    ).toBeDefined();
    expect(
      screen.queryByTestId("settings-host-switcher-option-sbx-awake"),
    ).toBeNull();
    expect(screen.queryByText("Build box")).toBeNull();
  });

  it("shows the single-host name, not a switcher, for one personal host beside a sandbox", () => {
    renderBar(pickerOver([LAPTOP, SANDBOX], LAPTOP));

    expect(screen.getByTestId("onboarding-host-name").textContent).toBe(
      "Laptop",
    );
    expect(screen.queryByTestId("settings-host-switcher")).toBeNull();
  });
});
