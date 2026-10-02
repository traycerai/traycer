import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PairNeedsYouDetail,
  PairToReviewDetail,
} from "../strip-section-detail";
import type { NeedsYouRow, ToReviewRow } from "../strip-sections";

const MINUTE_MS = 60_000;

afterEach(() => {
  cleanup();
});

/** `minutesAgo` null: no prompt row is loaded, so no wait is known. */
function needsYou(
  reason: NeedsYouRow["reason"],
  agentTitle: string,
  minutesAgo: number | null,
): NeedsYouRow {
  return {
    section: "needs-you",
    reason,
    agentTitle,
    count: 1,
    createdAt: minutesAgo === null ? null : Date.now() - minutesAgo * MINUTE_MS,
  };
}

function toReview(
  outcome: ToReviewRow["outcome"],
  minutesAgo: number,
): ToReviewRow {
  return {
    section: "to-review",
    outcome,
    at: Date.now() - minutesAgo * MINUTE_MS,
  };
}

function line(): string {
  return screen.getByTestId("side-tab-section-detail").textContent;
}

function time(): string | null {
  return screen.queryByTestId("side-tab-section-time")?.textContent ?? null;
}

describe("PairNeedsYouDetail", () => {
  it("says the one waiting half's request and agent, not its task, and how long it has waited", () => {
    render(
      <PairNeedsYouDetail
        halves={[needsYou("approval", "Perf agent", 5)]}
        className=""
      />,
    );
    expect(line()).toBe("Approve · Perf agent5m");
    expect(time()).toBe("5m");
  });

  it("says the request that has waited longer when both halves need the person, and that there is one more", () => {
    render(
      <PairNeedsYouDetail
        halves={[
          needsYou("approval", "Perf agent", 10),
          needsYou("reply", "Sync agent", 20),
        ]}
        className=""
      />,
    );
    expect(line()).toBe("Reply · Sync agent· +1 more20m");
  });

  it("says the left half's request, and no wait, when neither wait is known", () => {
    render(
      <PairNeedsYouDetail
        halves={[
          needsYou("reply", "Sync agent", null),
          needsYou("approval", "Perf agent", null),
        ]}
        className=""
      />,
    );
    expect(line()).toBe("Reply · Sync agent· +1 more");
    expect(time()).toBeNull();
  });

  it("draws nothing when neither half needs the person", () => {
    render(<PairNeedsYouDetail halves={[]} className="" />);
    expect(screen.queryByTestId("side-tab-section-detail")).toBeNull();
  });
});

describe("PairToReviewDetail", () => {
  it("leads with a failure and its time over a later done", () => {
    render(
      <PairToReviewDetail
        halves={[toReview("done", 2), toReview("failed", 9)]}
        className=""
      />,
    );
    expect(line()).toBe("Failed9m");
  });

  it("says done, from the later finish, when both halves are", () => {
    render(
      <PairToReviewDetail
        halves={[toReview("done", 7), toReview("done", 3)]}
        className=""
      />,
    );
    expect(line()).toBe("Done3m");
  });
});
