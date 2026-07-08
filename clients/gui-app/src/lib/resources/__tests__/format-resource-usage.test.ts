import { describe, expect, it } from "vitest";
import {
  formatCpuPercent,
  formatMemoryBytes,
  formatProcessCount,
} from "@/lib/resources/format-resource-usage";

describe("formatCpuPercent", () => {
  it("renders a bare zero for zero / negative / non-finite input", () => {
    expect(formatCpuPercent(0)).toBe("0%");
    expect(formatCpuPercent(-5)).toBe("0%");
    expect(formatCpuPercent(Number.NaN)).toBe("0%");
  });

  it("keeps one decimal below 10% and rounds at or above it", () => {
    expect(formatCpuPercent(2.34)).toBe("2.3%");
    expect(formatCpuPercent(9.99)).toBe("10.0%");
    expect(formatCpuPercent(12.4)).toBe("12%");
  });

  it("renders multi-core CPU above 100 verbatim, never clamped", () => {
    expect(formatCpuPercent(240)).toBe("240%");
  });
});

describe("formatMemoryBytes", () => {
  it("renders a bare zero for zero / negative / non-finite input", () => {
    expect(formatMemoryBytes(0)).toBe("0 B");
    expect(formatMemoryBytes(-1)).toBe("0 B");
    expect(formatMemoryBytes(Number.NaN)).toBe("0 B");
  });

  it("scales through units and rounds by magnitude", () => {
    expect(formatMemoryBytes(512)).toBe("512 B");
    expect(formatMemoryBytes(1024)).toBe("1.0 KB");
    expect(formatMemoryBytes(1_500_000)).toBe("1.4 MB");
    // >= 100 in a unit drops the decimal.
    expect(formatMemoryBytes(357 * 1024 * 1024)).toBe("357 MB");
    expect(formatMemoryBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe("formatProcessCount", () => {
  it("floors positive counts and renders zero for empty / invalid input", () => {
    expect(formatProcessCount(0)).toBe("0");
    expect(formatProcessCount(-2)).toBe("0");
    expect(formatProcessCount(Number.NaN)).toBe("0");
    expect(formatProcessCount(3)).toBe("3");
    expect(formatProcessCount(4.9)).toBe("4");
  });
});
