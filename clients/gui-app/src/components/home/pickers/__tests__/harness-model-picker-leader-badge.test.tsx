import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";

describe("<PickerLeaderBadge />", () => {
  afterEach(() => cleanup());

  it("renders indexes 0-8 as the digits 1-9", () => {
    for (let index = 0; index < 9; index += 1) {
      render(
        <PickerLeaderBadge
          show
          index={index}
          hintAction="to switch"
          hintTarget="Runtime Core"
          testId={`leader-badge-${index}`}
          placement="corner"
        />,
      );
      const badge = screen.getByTestId(`leader-badge-${index}`);
      expect(badge.textContent).toBe(String(index + 1));
      expect(badge.getAttribute("aria-label")).toBe(
        `Press ${index + 1} to switch Runtime Core`,
      );
      cleanup();
    }
  });

  it("renders index 9 (the 10th and last slot) as 0, matching the dispatched physical key", () => {
    render(
      <PickerLeaderBadge
        show
        index={9}
        hintAction="to switch"
        hintTarget="Runtime Core"
        testId="leader-badge-9"
        placement="corner"
      />,
    );
    const badge = screen.getByTestId("leader-badge-9");
    expect(badge.textContent).toBe("0");
    expect(badge.getAttribute("aria-label")).toBe(
      "Press 0 to switch Runtime Core",
    );
  });
});
