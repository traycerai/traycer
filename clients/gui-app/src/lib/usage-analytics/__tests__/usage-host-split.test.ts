import { describe, expect, it } from "vitest";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  buildUsageHostFilterOptions,
  buildUsageHostSplitRows,
  resolveUsageHostName,
  usageHostFilterHostId,
  usageHostFilterValue,
} from "@/lib/usage-analytics/usage-host-split";

type UsageHostBucket = UsageSummaryResponse["summary"]["hostBuckets"][number];

function hostBucket(
  overrides: Partial<UsageHostBucket> & { readonly hostId: string },
): UsageHostBucket {
  return {
    factCount: 1,
    tokens: {
      uncachedInputTokens: 100,
      cacheReadInputTokens: 10,
      cacheCreationTokens: 0,
      outputTokens: 40,
    },
    knownCostUsd: 1,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    ...overrides,
  };
}

describe("resolveUsageHostName", () => {
  it("prefers the directory name", () => {
    expect(
      resolveUsageHostName("host-a", new Map([["host-a", "Studio Mac"]])),
    ).toBe("Studio Mac");
  });

  it("uses the plain label for a host the directory does not list", () => {
    expect(resolveUsageHostName("host-unavailable", new Map())).toBe(
      "Unnamed computer",
    );
  });

  it("treats a blank directory label as no name at all", () => {
    expect(resolveUsageHostName("host-a", new Map([["host-a", "   "]]))).toBe(
      "Unnamed computer",
    );
  });

  it("treats a directory label equal to the host id as no name", () => {
    expect(
      resolveUsageHostName("host-a", new Map([["host-a", "host-a"]])),
    ).toBe("Unnamed computer");
  });
});

describe("buildUsageHostSplitRows", () => {
  it("names each host, sorts by cost descending, and foots shares to 100%", () => {
    const rows = buildUsageHostSplitRows(
      [
        hostBucket({ hostId: "host-a", knownCostUsd: 1 }),
        hostBucket({ hostId: "host-b", knownCostUsd: 3 }),
      ],
      new Map([["host-b", "Studio Mac"]]),
    );

    expect(rows.map((row) => row.hostId)).toEqual(["host-b", "host-a"]);
    expect(rows[0].name).toBe("Studio Mac");
    expect(rows[0].nameIsFallback).toBe(false);
    expect(rows[1].name).toBe("Unnamed computer");
    expect(rows[1].nameIsFallback).toBe(true);
    expect(rows[0].shareOfCost).toBeCloseTo(0.75);
    expect(rows[1].shareOfCost).toBeCloseTo(0.25);
    expect(rows[0].shareOfCost + rows[1].shareOfCost).toBeCloseTo(1);
  });

  it("gives every row a 0 share - never NaN - when the window has no priced cost", () => {
    const rows = buildUsageHostSplitRows(
      [
        hostBucket({
          hostId: "host-a",
          knownCostUsd: 0,
          costProvenance: "unpriced",
        }),
      ],
      new Map(),
    );
    expect(rows[0].shareOfCost).toBe(0);
  });

  it("sums the bucket's tokens into one figure", () => {
    const rows = buildUsageHostSplitRows(
      [hostBucket({ hostId: "host-a" })],
      new Map(),
    );
    expect(rows[0].tokens).toBe(150);
  });
});

describe("buildUsageHostFilterOptions", () => {
  it("gives unnamed and duplicate named options distinct labels without changing values", () => {
    const options = buildUsageHostFilterOptions({
      hostNames: new Map([
        ["named-a", "Studio Mac"],
        ["named-b", "Studio Mac"],
        ["named-suffix", "Studio Mac 2"],
      ]),
      hostIdsWithUsage: ["unnamed-a", "unnamed-b"],
      selectedHostId: "unnamed-b",
    });
    expect(options.map(({ hostId, name }) => ({ hostId, name }))).toEqual([
      { hostId: "named-a", name: "Studio Mac" },
      { hostId: "named-b", name: "Studio Mac 3" },
      { hostId: "named-suffix", name: "Studio Mac 2" },
      { hostId: "unnamed-a", name: "Unnamed computer" },
      { hostId: "unnamed-b", name: "Unnamed computer 2" },
    ]);
  });

  it("offers directory hosts and hosts with usage alike, named ones first then by name", () => {
    const options = buildUsageHostFilterOptions({
      hostNames: new Map([
        ["host-a", "Studio Mac"],
        ["host-b", "Air"],
      ]),
      // Present in the window but absent from the directory.
      hostIdsWithUsage: ["host-a", "host-c"],
      selectedHostId: null,
    });
    // Named hosts as a block, before the plain fallback row.
    expect(options.map((option) => option.name)).toEqual([
      "Air",
      "Studio Mac",
      "Unnamed computer",
    ]);
  });

  it("keeps the selected host present even when it resolved to an empty window", () => {
    // Otherwise the control would show a selection it could not re-offer:
    // filtering to a host with no usage empties `hostBuckets`, and a
    // directory that never listed that host would empty the option list too.
    const options = buildUsageHostFilterOptions({
      hostNames: new Map(),
      hostIdsWithUsage: [],
      selectedHostId: "host-gone",
    });
    expect(options.map((option) => option.hostId)).toEqual(["host-gone"]);
  });

  it("never lists a host twice when it is in both sources", () => {
    const options = buildUsageHostFilterOptions({
      hostNames: new Map([["host-a", "Studio Mac"]]),
      hostIdsWithUsage: ["host-a"],
      selectedHostId: "host-a",
    });
    expect(options).toHaveLength(1);
  });
});

describe("usage host filter value mapping", () => {
  it("round-trips All hosts through a sentinel Radix will accept", () => {
    // Radix `Select` refuses an empty-string item value and has no concept of
    // `null`, so "no filter" needs a value of its own - and that value must
    // never be mistaken for a host id on the way back.
    expect(usageHostFilterHostId(usageHostFilterValue(null))).toBeNull();
    expect(usageHostFilterValue(null)).not.toBe("");
  });

  it("round-trips a real host id unchanged", () => {
    expect(usageHostFilterHostId(usageHostFilterValue("host-a"))).toBe(
      "host-a",
    );
  });
});
