import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatSettingsDate,
  onSettingsDate,
} from "@/lib/settings/settings-date";

const NOW = new Date(2026, 9, 25, 12, 0);

function at(year: number, month: number, day: number): number {
  return new Date(year, month, day, 8, 35).getTime();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("formatSettingsDate", () => {
  it("reads today as the time alone, with or without the time asked for", () => {
    expect(formatSettingsDate(at(2026, 9, 25), false)).toBe("08:35");
    expect(formatSettingsDate(at(2026, 9, 25), true)).toBe("08:35");
  });

  it("reads earlier this year as day and month, with the time only when asked", () => {
    expect(formatSettingsDate(at(2026, 9, 24), false)).toBe("24 Oct");
    expect(formatSettingsDate(at(2026, 0, 3), false)).toBe("3 Jan");
    expect(formatSettingsDate(at(2026, 9, 24), true)).toBe("24 Oct 08:35");
  });

  it("reads another year with the year and no time", () => {
    expect(formatSettingsDate(at(2025, 9, 25), false)).toBe("25 Oct 2025");
    expect(formatSettingsDate(at(2025, 9, 25), true)).toBe("25 Oct 2025");
  });
});

describe("onSettingsDate", () => {
  it("puts at before today's time and on before a date", () => {
    expect(onSettingsDate(at(2026, 9, 25))).toBe("at 08:35");
    expect(onSettingsDate(at(2026, 9, 20))).toBe("on 20 Oct");
    expect(onSettingsDate(at(2025, 9, 20))).toBe("on 20 Oct 2025");
  });
});
