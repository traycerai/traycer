import { describe, expect, it } from "vitest";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";
import {
  buildUsageHostFilterOptions,
  buildUsageHostSplitRows,
  resolveUsageHostName,
  usageHostFallbackName,
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

describe("usageHostFallbackName", () => {
  it("truncates a long id rather than rendering a blank", () => {
    expect(usageHostFallbackName("01JX7Q2M9K4B8Z6T5N3P1V0WYD")).toBe(
      "01JX7Q2M…",
    );
  });

  it("leaves a short id whole - nothing to hide", () => {
    expect(usageHostFallbackName("host-1")).toBe("host-1");
  });
});

describe("resolveUsageHostName", () => {
  it("prefers the directory name", () => {
    expect(
      resolveUsageHostName("host-a", new Map([["host-a", "Studio Mac"]])),
    ).toBe("Studio Mac");
  });

  it("falls back to a truncated id for a host the directory doesn't list", () => {
    // The cloud plane summarizes every host on the ACCOUNT, including one
    // this client cannot dial or that has since been removed. That gap is
    // ordinary, and a blank there would read as a rendering fault.
    expect(resolveUsageHostName("01JX7Q2M9K4B8Z6T5N3P1V0WYD", new Map())).toBe(
      "01JX7Q2M…",
    );
  });

  it("treats a blank directory label as no name at all", () => {
    expect(resolveUsageHostName("host-a", new Map([["host-a", "   "]]))).toBe(
      "host-a",
    );
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
    expect(rows[1].name).toBe("host-a");
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
    // Named hosts as a block, so the machine the reader recognizes is not
    // scattered among truncated ids by locale collation ("host-c" otherwise
    // sorts between "Air" and "Studio Mac").
    expect(options.map((option) => option.name)).toEqual([
      "Air",
      "Studio Mac",
      "host-c",
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
