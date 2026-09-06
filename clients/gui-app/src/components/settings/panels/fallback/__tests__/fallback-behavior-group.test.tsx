import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
} from "@traycer/protocol/host/fallback-policy";
import { FallbackBehaviorGroup } from "@/components/settings/panels/fallback/fallback-behavior-group";

afterEach(() => {
  cleanup();
});

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), ...overrides };
}

/** Radix's select: open with the keyboard, then commit the named option. */
function openCombobox(name: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), {
    key: "ArrowDown",
  });
}

function chooseOption(name: string): void {
  const item = screen.getByRole("option", { name });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

describe("FallbackBehaviorGroup - out-of-range stored values", () => {
  it("renders a stored grace-window value outside the offered range as its own option, selected, instead of clamping it on load", () => {
    const onChange = vi.fn();
    // 42 is not one of GRACE_WINDOW_SECONDS (10-15) - only reachable via a
    // programmatic writer, which is exactly the case this rule protects.
    render(
      <FallbackBehaviorGroup
        policy={policy({ graceWindowSeconds: 42 })}
        onChange={onChange}
        status={null}
      />,
    );

    openCombobox("Time to cancel before switching");
    const option = screen.getByRole("option", { name: "42 seconds" });
    // `data-state` reflects selection alone (Radix's `isSelected`), unlike
    // `aria-selected`, which is additionally gated on focus timing.
    expect(option.getAttribute("data-state")).toBe("checked");

    // The pin: opening the page and reading the control must not itself save
    // anything. Stub `withStoredNumber` to drop the out-of-range value (or
    // clamp `value` to the nearest offered option on render) and this
    // assertion goes red - either the option above disappears or `onChange`
    // fires with a rewritten number nobody chose.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a stored max-wait value outside the offered range the same way", () => {
    const onChange = vi.fn();
    render(
      <FallbackBehaviorGroup
        policy={policy({ maxWaitMinutes: 999 })}
        onChange={onChange}
        status={null}
      />,
    );

    openCombobox("Longest wait for a reset");
    const option = screen.getByRole("option", { name: "999 minutes" });
    expect(option.getAttribute("data-state")).toBe("checked");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still offers every ordinary option alongside the out-of-range one, sorted into place", () => {
    render(
      <FallbackBehaviorGroup
        policy={policy({ graceWindowSeconds: 12 })}
        onChange={vi.fn()}
        status={null}
      />,
    );
    openCombobox("Time to cancel before switching");
    const labels = screen
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual([
      "10 seconds",
      "11 seconds",
      "12 seconds",
      "13 seconds",
      "14 seconds",
      "15 seconds",
    ]);
  });
});

describe("FallbackBehaviorGroup - selecting a value", () => {
  it("commits the picked value through onChange, leaving the rest of the policy untouched", () => {
    const onChange = vi.fn();
    render(
      <FallbackBehaviorGroup
        policy={policy({ graceWindowSeconds: 15 })}
        onChange={onChange}
        status={null}
      />,
    );
    openCombobox("Time to cancel before switching");
    chooseOption("11 seconds");
    expect(onChange).toHaveBeenCalledWith(policy({ graceWindowSeconds: 11 }));
  });
});
