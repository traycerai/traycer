import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUsageSummaryRequest } from "@/hooks/usage-analytics/use-usage-summary-query";
import { getViewerTimeZone } from "@/lib/usage-analytics/viewer-timezone";

type ResolvedOptionsStub = Omit<
  Intl.ResolvedDateTimeFormatOptions,
  "timeZone"
> & {
  timeZone: string | undefined;
};

function stubResolvedTimeZone(timeZone: string | undefined): void {
  const real = new Intl.DateTimeFormat().resolvedOptions();
  const resolved: ResolvedOptionsStub = { ...real, timeZone };
  const formatter = new Intl.DateTimeFormat();
  vi.spyOn(formatter, "resolvedOptions").mockReturnValue(
    // The stub deliberately violates the lib typing, as V8 does for an
    // unresolvable host zone.
    resolved as Intl.ResolvedDateTimeFormatOptions,
  );
  vi.spyOn(Intl, "DateTimeFormat").mockReturnValue(formatter);
}

describe("getViewerTimeZone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to UTC when the runtime resolves no time zone", () => {
    stubResolvedTimeZone(undefined);
    expect(getViewerTimeZone()).toBe("UTC");
  });

  it("sends UTC on the usage summary request when the runtime resolves no time zone", () => {
    stubResolvedTimeZone(undefined);
    expect(
      buildUsageSummaryRequest({ windowDays: 7, epicId: null, plane: null })
        .timezone,
    ).toBe("UTC");
  });

  it("falls back to UTC for an empty time zone", () => {
    stubResolvedTimeZone("");
    expect(getViewerTimeZone()).toBe("UTC");
  });

  it("passes a resolved IANA zone through unchanged", () => {
    stubResolvedTimeZone("Asia/Kolkata");
    expect(getViewerTimeZone()).toBe("Asia/Kolkata");
  });
});
