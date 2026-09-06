import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";
import { FallbackOverridesMatrix } from "@/components/settings/panels/fallback/fallback-overrides-matrix";

const BASE_LADDER: readonly FallbackRungKind[] = [
  "profile",
  "tier",
  "wait",
  "notify",
];

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    ladder: [...BASE_LADDER],
    ...overrides,
  };
}

function renderMatrix(
  fallbackPolicy: FallbackPolicy,
  onChange: (next: FallbackPolicy) => void,
) {
  render(
    <FallbackOverridesMatrix
      policy={fallbackPolicy}
      rungOrder={BASE_LADDER}
      onChange={onChange}
      status={null}
    />,
  );
  // Collapsed by default - open it before any row assertion.
  fireEvent.click(
    screen.getByRole("button", { name: /Per-failure overrides/i }),
  );
}

afterEach(() => {
  cleanup();
});

describe("FallbackOverridesMatrix - the 'off' third state", () => {
  it("renders 'Nothing runs for this failure' for a row whose override is the literal 'off'", () => {
    const onChange = vi.fn();
    renderMatrix(policy({ reasonOverrides: { auth: "off" } }), onChange);
    const row = screen.getByTestId("fallback-override-row-auth");
    expect(
      within(row).getByText("Nothing runs for this failure."),
    ).not.toBeNull();
  });

  it("keeps an 'off' row's chips clickable, and turning one on starts from nothing rather than restoring the base ladder", () => {
    const onChange = vi.fn();
    renderMatrix(policy({ reasonOverrides: { auth: "off" } }), onChange);
    const label = FALLBACK_REASON_LABELS.auth;
    fireEvent.click(
      screen.getByRole("button", { name: `other profile for ${label}` }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as FallbackPolicy;
    // Only "profile" runs now - not the whole base ladder.
    expect(next.reasonOverrides?.auth).toEqual(["profile"]);
  });
});

describe("FallbackOverridesMatrix - ineligible chips are not buttons", () => {
  it("renders an ineligible cell as a non-interactive span, not a disabled button", () => {
    const onChange = vi.fn();
    // provider_unavailable's eligible set is ["tier"] only - "profile" and
    // "wait" are impossible for it.
    renderMatrix(policy({}), onChange);
    // `fallback-override-row-*` is the LABEL cell only - the three chip
    // elements are its grid siblings, not its DOM children - so this reads
    // through the whole document rather than scoping into that testid.
    const label = FALLBACK_REASON_LABELS.provider_unavailable;

    // The chip's own why-text is part of its visible content.
    expect(screen.getByText(/same servers/)).not.toBeNull();

    // A disabled <button> still exposes role="button" to accessibility
    // queries - this is the assertion that would go red if OverrideChip
    // rendered the impossible state as `<button disabled>` instead of a
    // plain `<span>`.
    expect(
      screen.queryByRole("button", { name: `other profile for ${label}` }),
    ).toBeNull();

    // Positive control: the SAME row's eligible chip ("tier") IS a real,
    // clickable button - proving the query above is capable of finding a
    // button when one is actually rendered.
    expect(
      screen.getByRole("button", {
        name: `equivalent model for ${label}`,
      }),
    ).not.toBeNull();
  });
});

describe("FallbackOverridesMatrix - the excluded reasons", () => {
  it("collapses the five excluded reasons into one read-only line, drawing no row for any of them", () => {
    renderMatrix(policy({}), vi.fn());
    expect(
      screen.queryByTestId("fallback-override-row-context_exhausted"),
    ).toBeNull();
    expect(screen.getByTestId("fallback-override-excluded-row")).not.toBeNull();
  });
});
