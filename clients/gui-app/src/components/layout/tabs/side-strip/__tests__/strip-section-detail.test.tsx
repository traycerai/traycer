import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PairNeedsYouDetail } from "../strip-section-detail";
import type { NeedsYouRow } from "../strip-sections";

afterEach(() => {
  cleanup();
});

function needsYou(
  reason: NeedsYouRow["reason"],
  agentTitle: string,
  createdAt: number | null,
): NeedsYouRow {
  return { section: "needs-you", reason, agentTitle, count: 1, createdAt };
}

function line(): string {
  return screen.getByTestId("side-tab-section-detail").textContent;
}

describe("PairNeedsYouDetail", () => {
  it("names the one half that needs the person: its request, task and agent", () => {
    render(
      <PairNeedsYouDetail
        halves={[
          { row: needsYou("approval", "Perf agent", 5), title: "React UI" },
        ]}
        className=""
      />,
    );
    expect(line()).toBe("Approve · React UI · Perf agent");
  });

  it("names the half that has waited longer when both need the person, and says there is one more", () => {
    render(
      <PairNeedsYouDetail
        halves={[
          { row: needsYou("approval", "Perf agent", 20), title: "Cookie Sync" },
          { row: needsYou("reply", "Sync agent", 10), title: "React UI" },
        ]}
        className=""
      />,
    );
    expect(line()).toBe("Reply · React UI · Sync agent· +1 more");
  });

  it("names the left half when neither wait is known", () => {
    render(
      <PairNeedsYouDetail
        halves={[
          { row: needsYou("reply", "Sync agent", null), title: "Cookie Sync" },
          { row: needsYou("approval", "Perf agent", null), title: "React UI" },
        ]}
        className=""
      />,
    );
    expect(line()).toBe("Reply · Cookie Sync · Sync agent· +1 more");
  });

  it("draws nothing when neither half needs the person", () => {
    render(<PairNeedsYouDetail halves={[]} className="" />);
    expect(screen.queryByTestId("side-tab-section-detail")).toBeNull();
  });
});
