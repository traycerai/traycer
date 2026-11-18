import { describe, expect, it } from "vitest";
import { detailsNowSummary } from "@/components/settings/details/environment-details-providers";
import type { DetailsHostStatus } from "@/lib/settings-details-entry";

function host(
  hostId: string,
  state: string,
  item: string | null,
): DetailsHostStatus {
  return {
    hostId,
    name: `${hostId}-box`,
    item,
    state,
    reason: null,
    at: 1,
    lastReportedAt: 1,
    recovery: null,
  };
}

describe("detailsNowSummary", () => {
  it("counts the hosts a configuration is applied on", () => {
    expect(
      detailsNowSummary([
        host("a", "applied", "x"),
        host("a", "applied", "y"),
        host("b", "applied", "x"),
      ]),
    ).toBe("Applied on 2 hosts");
    expect(detailsNowSummary([host("a", "applied", null)])).toBe(
      "Applied on 1 host",
    );
  });

  it("counts a host's own failed items, ahead of a host still applying", () => {
    expect(
      detailsNowSummary([
        host("a", "received", "x"),
        host("b", "not_applied", "x"),
        host("b", "not_applied", "y"),
        host("b", "applied", "z"),
        host("c", "not_applied", "x"),
      ]),
    ).toBe("2 not applied on b-box");
  });

  it("names the host that is still applying", () => {
    expect(
      detailsNowSummary([
        host("a", "applied", null),
        host("b", "received", null),
      ]),
    ).toBe("Applying on b-box…");
  });
});
