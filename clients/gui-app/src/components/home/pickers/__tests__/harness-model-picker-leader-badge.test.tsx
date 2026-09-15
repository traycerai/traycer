import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";

const platformMock = vi.hoisted(() => ({ mac: false }));

vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";

describe("<PickerLeaderBadge />", () => {
  beforeEach(() => {
    platformMock.mac = false;
  });

  afterEach(() => cleanup());

  it("renders indexes 0-8 as the digits 1-9", () => {
    for (let index = 0; index < 9; index += 1) {
      render(
        <PickerLeaderBadge
          index={index}
          modifier="mod"
          hintAction="to switch"
          hintTarget="Runtime Core"
          testId={`leader-badge-${index}`}
          placement="corner"
        />,
      );
      const badge = screen.getByTestId(`leader-badge-${index}`);
      expect(badge.textContent).toBe(String(index + 1));
      expect(badge.getAttribute("aria-label")).toBe(
        `Press Control+${index + 1} to switch Runtime Core`,
      );
      cleanup();
    }
  });

  it("renders index 9 (the 10th and last slot) as 0, matching the dispatched physical key", () => {
    render(
      <PickerLeaderBadge
        index={9}
        modifier="alt"
        hintAction="to switch"
        hintTarget="Runtime Core"
        testId="leader-badge-9"
        placement="corner"
      />,
    );
    const badge = screen.getByTestId("leader-badge-9");
    expect(badge.textContent).toBe("0");
    expect(badge.getAttribute("aria-label")).toBe(
      "Press Alt+0 to switch Runtime Core",
    );
  });

  it("names the accessible modifier per platform (mod -> Command on macOS)", () => {
    platformMock.mac = true;
    render(
      <PickerLeaderBadge
        index={0}
        modifier="mod"
        hintAction="to switch"
        hintTarget="Runtime Core"
        testId="leader-badge-mac"
        placement="corner"
      />,
    );
    expect(
      screen.getByTestId("leader-badge-mac").getAttribute("aria-label"),
    ).toBe("Press Command+1 to switch Runtime Core");
  });

  it("renders nothing when modifier is null - the surface's leader is not held", () => {
    render(
      <PickerLeaderBadge
        index={0}
        modifier={null}
        hintAction="to switch"
        hintTarget="Runtime Core"
        testId="leader-badge-hidden"
        placement="corner"
      />,
    );
    expect(screen.queryByTestId("leader-badge-hidden")).toBeNull();
  });
});
