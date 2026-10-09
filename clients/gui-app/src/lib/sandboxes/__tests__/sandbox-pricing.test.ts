import { describe, expect, it } from "vitest";
import type { SandboxShapeBounds } from "@traycer/protocol/host/sandbox-control";
import {
  formatCredits,
  formatCreditsRequired,
  formatMemory,
  roundSandboxShape,
  roundUpToStep,
  sandboxShapeProblem,
} from "@/lib/sandboxes/sandbox-pricing";

const BOUNDS: SandboxShapeBounds = {
  cpuMin: 1,
  cpuMax: 16,
  cpuStep: 1,
  memoryPerCpuMinMb: 1024,
  memoryPerCpuMaxMb: 8192,
  memoryMinMb: 1024,
  memoryMaxMb: 65536,
  memoryStepMb: 512,
  diskMinMb: 10240,
  diskMaxMb: 102400,
  diskDefaultMb: 20480,
};

describe("formatCredits", () => {
  it("shows two decimals under ten credits and whole credits from ten up", () => {
    expect(formatCredits(0)).toBe("0.00");
    expect(formatCredits(120)).toBe("0.12");
    expect(formatCredits(9_994)).toBe("9.99");
    expect(formatCredits(10_000)).toBe("10");
    expect(formatCredits(12_600)).toBe("13");
  });

  it("rounds a balance to nearest, unlike an amount to add", () => {
    expect(formatCredits(10_100)).toBe("10");
  });
});

describe("formatCreditsRequired", () => {
  it("rounds an amount to add UP to the hundredth, then shows two decimals under ten credits", () => {
    expect(formatCreditsRequired(1_000)).toBe("1.00");
    expect(formatCreditsRequired(1_001)).toBe("1.01");
    expect(formatCreditsRequired(300)).toBe("0.30");
  });

  it("shows whole credits, rounded up, from ten up", () => {
    expect(formatCreditsRequired(10_000)).toBe("10");
    expect(formatCreditsRequired(10_100)).toBe("11");
    // Rounds up to ten credits, so it reads as a whole number.
    expect(formatCreditsRequired(9_995)).toBe("10");
  });
});

describe("formatMemory", () => {
  it("shows MB under a gigabyte and GB from it, one decimal when not whole", () => {
    expect(formatMemory(512)).toBe("512 MB");
    expect(formatMemory(1024)).toBe("1 GB");
    expect(formatMemory(1536)).toBe("1.5 GB");
    expect(formatMemory(4096)).toBe("4 GB");
  });
});

describe("roundUpToStep", () => {
  it("rounds up from the minimum, never down", () => {
    expect(roundUpToStep(1.2, 0.5, 1)).toBe(1.5);
    expect(roundUpToStep(2, 1, 1)).toBe(2);
    expect(roundUpToStep(2.01, 1, 1)).toBe(3);
  });

  it("returns the minimum for anything at or under it, and the value for a zero step", () => {
    expect(roundUpToStep(0.2, 1, 1)).toBe(1);
    expect(roundUpToStep(3.3, 0, 1)).toBe(3.3);
  });

  it("is not thrown a step up by float noise on an exact multiple", () => {
    expect(roundUpToStep(1.1 + 0.2, 0.1, 1)).toBeCloseTo(1.3, 5);
  });
});

describe("roundSandboxShape", () => {
  it("rounds memory up to the step and clamps both to the maximum", () => {
    expect(roundSandboxShape(BOUNDS, { cpus: 2, memoryMb: 2100 })).toEqual({
      cpus: 2,
      memoryMb: 2560,
    });
    expect(roundSandboxShape(BOUNDS, { cpus: 99, memoryMb: 999_999 })).toEqual({
      cpus: 16,
      memoryMb: 65536,
    });
  });
});

describe("sandboxShapeProblem", () => {
  it("accepts a shape inside every bound", () => {
    expect(sandboxShapeProblem(BOUNDS, { cpus: 2, memoryMb: 4096 })).toBeNull();
  });

  it("names the vCPU range first, as the server checks it first", () => {
    expect(sandboxShapeProblem(BOUNDS, { cpus: 0, memoryMb: 999_999 })).toBe(
      "vCPU must be between 1 and 16.",
    );
    expect(sandboxShapeProblem(BOUNDS, { cpus: 17, memoryMb: 4096 })).toBe(
      "vCPU must be between 1 and 16.",
    );
    expect(
      sandboxShapeProblem(BOUNDS, { cpus: Number.NaN, memoryMb: 4096 }),
    ).toBe("vCPU must be between 1 and 16.");
  });

  it("names the memory range second", () => {
    expect(sandboxShapeProblem(BOUNDS, { cpus: 1, memoryMb: 512 })).toBe(
      "Memory must be between 1 GB and 64 GB.",
    );
  });

  it("checks the memory per vCPU of the ROUNDED shape last, and says what is allowed", () => {
    expect(sandboxShapeProblem(BOUNDS, { cpus: 8, memoryMb: 2048 })).toBe(
      "With 8 vCPU, memory must be between 8 GB and 64 GB.",
    );
    expect(sandboxShapeProblem(BOUNDS, { cpus: 1, memoryMb: 16384 })).toBe(
      "With 1 vCPU, memory must be between 1 GB and 8 GB.",
    );
  });

  it("judges the ratio on what the server will create: 1.5 vCPU rounds to 2, which 1.5 GB cannot fill", () => {
    // 1.5 GB over the requested 1.5 vCPU is exactly the 1 GB/vCPU minimum, but
    // the server rounds the vCPU up first and checks the ratio of THAT shape.
    expect(sandboxShapeProblem(BOUNDS, { cpus: 1.5, memoryMb: 1536 })).toBe(
      "With 2 vCPU, memory must be between 2 GB and 16 GB.",
    );
  });
});
