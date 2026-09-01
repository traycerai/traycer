import { describe, expect, it } from "vitest";
import {
  clampPercentage,
  resourceMemoryBytes,
  resourceMemoryLabel,
  selectResourceMemoryMetric,
  sumCompleteMemoryBytes,
  type ResourceMemoryProjection,
  type ResourceMemoryUsage,
} from "../memory-metric";

function usage(pssBytes: number | null): ResourceMemoryUsage {
  return { rssBytes: 100, pssBytes, privateBytes: pssBytes };
}

function projection(pssBytes: number | null): ResourceMemoryProjection {
  return {
    app: { ...usage(pssBytes), process: usage(pssBytes) },
    hostTree: usage(pssBytes),
    other: { ...usage(pssBytes), processes: [usage(pssBytes)] },
    restricted: null,
    owners: [{ ...usage(pssBytes), processes: [usage(pssBytes)] }],
  };
}

describe("resource memory metric selection", () => {
  it("uses PSS consistently only for a complete host-only scope", () => {
    const complete = projection(40);
    const metric = selectResourceMemoryMetric(complete, false);
    expect(metric).toBe("pss");
    expect(resourceMemoryBytes(complete.hostTree ?? usage(null), metric)).toBe(
      40,
    );
    expect(resourceMemoryLabel(metric, false)).toContain("PSS");
  });

  it("falls back to RSS for incomplete detail and mixed Desktop/Host views", () => {
    expect(selectResourceMemoryMetric(projection(null), false)).toBe("rss");
    expect(selectResourceMemoryMetric(projection(40), true)).toBe("rss");
    expect(resourceMemoryLabel("rss", true)).toContain("working-set");
    expect(
      resourceMemoryBytes({ ...usage(null), rssBytes: null }, "rss"),
    ).toBeNull();
  });

  it("makes a containing memory sum unavailable when any reading is unavailable", () => {
    expect(sumCompleteMemoryBytes([10, 20, 30])).toBe(60);
    expect(sumCompleteMemoryBytes([10, null, 30])).toBeNull();
  });

  it("clamps the visual and accessible percentage source", () => {
    expect(clampPercentage(-1)).toBe(0);
    expect(clampPercentage(35)).toBe(35);
    expect(clampPercentage(125)).toBe(100);
    expect(clampPercentage(Number.NaN)).toBe(0);
  });
});
