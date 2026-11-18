import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUsageSummaryRequest } from "@/hooks/usage-analytics/use-usage-summary-query";
import { getViewerTimeZone } from "@/lib/usage-analytics/viewer-timezone";

type ResolvedOptionsStub = Omit<
  Intl.ResolvedDateTimeFormatOptions,
  "timeZone"
> & {
  timeZone: string | undefined;
};

const RealDateTimeFormat = Intl.DateTimeFormat;

/**
 * Makes the runtime's default zone resolve to `timeZone`. A formatter built
 * with an explicit `timeZone` option still comes from the real `Intl`, so
 * whether the engine accepts a zone stays the engine's answer.
 */
function stubResolvedTimeZone(timeZone: string | undefined): void {
  const real = new RealDateTimeFormat().resolvedOptions();
  const resolved: ResolvedOptionsStub = { ...real, timeZone };
  const formatter = new RealDateTimeFormat();
  vi.spyOn(formatter, "resolvedOptions").mockReturnValue(
    // The stub deliberately violates the lib typing, as V8 does for an
    // unresolvable host zone.
    resolved as Intl.ResolvedDateTimeFormatOptions,
  );
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation((locales, options) =>
    options?.timeZone === undefined
      ? formatter
      : new RealDateTimeFormat(locales, options),
  );
}

function requestTimeZone(): string {
  return buildUsageSummaryRequest({ windowDays: 7, epicId: null, plane: null })
    .timezone;
}

describe("getViewerTimeZone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends UTC on the usage summary request when the runtime resolves no time zone", () => {
    stubResolvedTimeZone(undefined);
    expect(requestTimeZone()).toBe("UTC");
  });

  it("sends UTC on the usage summary request when the runtime resolves a zone Intl rejects", () => {
    stubResolvedTimeZone("Etc/Unknown");
    expect(requestTimeZone()).toBe("UTC");
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
