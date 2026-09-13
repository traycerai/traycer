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

describe("FallbackBehaviorGroup - AX8: the return-to-preferred radiogroup is named and described", () => {
  // jest-dom's `toHaveAccessibleName`/`toHaveAccessibleDescription` are not
  // wired into this repo's vitest setup (`vitest.config.ts`'s `setupFiles`
  // registers only `@testing-library/react`'s `configure`, and
  // `@testing-library/jest-dom` is not a dependency of any package.json in
  // this repo), so the name/description are resolved by hand through
  // `aria-labelledby`/`aria-describedby` - the same pattern as the AX7 cell
  // in `fallback-ladder-editor.test.tsx`.
  function textOf(id: string | null): string | undefined {
    if (id === null) return undefined;
    return document.getElementById(id)?.textContent;
  }

  it("the radiogroup's accessible name is the setting's own heading, and its description carries the switching-back cost", () => {
    render(
      <FallbackBehaviorGroup
        policy={policy({ returnToPreferred: "prompt" })}
        onChange={vi.fn()}
        status={null}
      />,
    );
    const group = screen.getByRole("radiogroup");
    // Falsification: drop `aria-labelledby`/`aria-describedby` from the
    // `<RadioGroup>` in `fallback-behavior-group.tsx` - both lookups below
    // then resolve `undefined`.
    //
    // The apostrophe is ASCII U+0027, not the typographic U+2019. This was
    // asserted the other way round first, on the assumption that JSX's
    // `&apos;` yields a curly quote - it does not: `&apos;` IS the ASCII
    // apostrophe entity (U+2019 would be `&rsquo;`), and the JSX transform
    // resolves it to U+0027 in the rendered text node. The copy in
    // `fallback-behavior-group.tsx` predates this wave and is unchanged; only
    // the expectation was wrong. Compared with `toBe` rather than `toContain`
    // deliberately, so a future copy change to a real curly quote fails here
    // instead of passing on a substring.
    expect(textOf(group.getAttribute("aria-labelledby"))).toBe(
      "When the original provider's limit resets",
    );
    expect(textOf(group.getAttribute("aria-describedby"))).toContain(
      "Switching back costs a fresh session",
    );
  });

  it("the 'Switch back automatically' radio carries its own consequence as an accessible description", () => {
    render(
      <FallbackBehaviorGroup
        policy={policy({ returnToPreferred: "prompt" })}
        onChange={vi.fn()}
        status={null}
      />,
    );
    const auto = screen.getByRole("radio", {
      name: "Switch back automatically",
    });
    expect(textOf(auto.getAttribute("aria-describedby"))).toContain(
      "Starts a fresh session and moves queued messages back",
    );
  });

  it("the 'Ask me' radio has NO description - it has no consequence to read out", () => {
    render(
      <FallbackBehaviorGroup
        policy={policy({ returnToPreferred: "prompt" })}
        onChange={vi.fn()}
        status={null}
      />,
    );
    const askMe = screen.getByRole("radio", { name: "Ask me" });
    // Falsification: point every option's radio at a description element
    // unconditionally (drop the `copy.description === null ? undefined : ...`
    // branch) - this radio would then pick up SOME id, even though "Ask me"
    // renders no consequence paragraph.
    expect(askMe.getAttribute("aria-describedby")).toBeNull();
  });
});
