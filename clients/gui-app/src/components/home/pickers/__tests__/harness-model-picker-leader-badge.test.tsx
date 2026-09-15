import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";

// The badge is purely visual now - digit only, `aria-hidden`. The spoken
// modifier name lives on the parent control's own `aria-label`, built by
// `pickerLeaderControlLabel` (see harness-model-picker-shortcut-hint.test.ts)
// - CodeRabbit flagged the old `aria-label` here as unreachable through a
// parent that already owns an accessible name.
describe("<PickerLeaderBadge />", () => {
  afterEach(() => cleanup());

  it("renders indexes 0-8 as the digits 1-9, hidden from the accessibility tree", () => {
    for (let index = 0; index < 9; index += 1) {
      render(
        <PickerLeaderBadge
          index={index}
          modifier="mod"
          testId={`leader-badge-${index}`}
          placement="corner"
        />,
      );
      const badge = screen.getByTestId(`leader-badge-${index}`);
      expect(badge.textContent).toBe(String(index + 1));
      expect(badge.getAttribute("aria-hidden")).toBe("true");
      expect(badge.hasAttribute("aria-label")).toBe(false);
      cleanup();
    }
  });

  it("renders index 9 (the 10th and last slot) as 0, matching the dispatched physical key", () => {
    render(
      <PickerLeaderBadge
        index={9}
        modifier="alt"
        testId="leader-badge-9"
        placement="corner"
      />,
    );
    const badge = screen.getByTestId("leader-badge-9");
    expect(badge.textContent).toBe("0");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders nothing when modifier is null - the surface's leader is not held", () => {
    render(
      <PickerLeaderBadge
        index={0}
        modifier={null}
        testId="leader-badge-hidden"
        placement="corner"
      />,
    );
    expect(screen.queryByTestId("leader-badge-hidden")).toBeNull();
  });
});
