import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffLineDeltas } from "@/components/chat/diff-line-deltas";

/**
 * `+N −N`, and the one decision this component takes from its caller: whether
 * those two numbers ROLL.
 *
 * The roll itself is invisible here - jsdom can start no animation, so a
 * rolling number renders as plain text - so what these read is the structure
 * only the rolling branch produces: the digits inside an element of their own,
 * beside a sign that stays a bare text node whatever happens. That is the
 * independent output of the prop. How the digits travel is the rolling
 * primitive's own concern (`components/ui/__tests__/rolling-number.test.tsx`).
 */
function deltas(counts: { additions: number; deletions: number }) {
  return render(
    <span data-testid="host">
      <DiffLineDeltas counts={counts} className={undefined} rolling />
      <DiffLineDeltas counts={counts} className={undefined} rolling={false} />
    </span>,
  );
}

function side(marker: string, index: number): Element {
  const found = [...screen.getByTestId("host").querySelectorAll(`[${marker}]`)];
  const element = found.at(index);
  if (element === undefined) throw new Error(`no ${marker} at ${index}`);
  return element;
}

describe("<DiffLineDeltas />", () => {
  afterEach(() => {
    cleanup();
  });

  it("reads identically whether it rolls or not", () => {
    deltas({ additions: 12, deletions: 4 });

    expect(side("data-diff-additions", 0).textContent).toBe("+12");
    expect(side("data-diff-additions", 1).textContent).toBe("+12");
    // U+2212 MINUS SIGN, not a hyphen, and static either way: a sign that
    // rolled would be a digit reel printing punctuation.
    expect(side("data-diff-deletions", 0).textContent).toBe("−4");
    expect(side("data-diff-deletions", 1).textContent).toBe("−4");
  });

  // Above 999 is where the claim above stops being free: the rolling branch
  // formats through `Intl.NumberFormat`, which GROUPS by default, while the
  // plain branch is the number as JavaScript prints it. A lockfile rewrite
  // reaches four figures routinely, and the header would then read `+1,420`
  // over per-file rows reading `+1420`.
  it("groups neither side at four figures", () => {
    deltas({ additions: 1420, deletions: 1118 });

    expect(side("data-diff-additions", 0).textContent).toBe("+1420");
    expect(side("data-diff-additions", 1).textContent).toBe("+1420");
    expect(side("data-diff-deletions", 0).textContent).toBe("−1118");
    expect(side("data-diff-deletions", 1).textContent).toBe("−1118");
  });

  it("wraps only the rolling numbers, and never the signs", () => {
    deltas({ additions: 12, deletions: 4 });

    expect(side("data-diff-additions", 0).childElementCount).toBe(1);
    expect(side("data-diff-deletions", 0).childElementCount).toBe(1);
    // A per-file row: plain text, so a turn touching twelve files cannot roll
    // twelve rows at once.
    expect(side("data-diff-additions", 1).childElementCount).toBe(0);
    expect(side("data-diff-deletions", 1).childElementCount).toBe(0);
  });

  it("keeps the tones on the sides, not on the numbers", () => {
    deltas({ additions: 12, deletions: 4 });

    // The colour is on the span that owns the pair, so it inherits into the
    // rolling number - which carries no tone of its own, and whose digits live
    // behind a shadow boundary a class could not reach anyway.
    expect(side("data-diff-additions", 0).getAttribute("class")).toContain(
      "text-success-foreground",
    );
    expect(side("data-diff-deletions", 0).getAttribute("class")).toContain(
      "text-destructive",
    );
    expect(
      side("data-diff-additions", 0).firstElementChild?.getAttribute("class"),
    ).not.toContain("text-success-foreground");
  });

  it("omits a zero side entirely, rolling or not", () => {
    deltas({ additions: 12, deletions: 0 });

    expect(screen.getByTestId("host").textContent).toBe("+12+12");
    expect(
      screen.getByTestId("host").querySelectorAll("[data-diff-deletions]"),
    ).toHaveLength(0);
  });
});
