import { describe, expect, it } from "vitest";
import {
  buildHarnessUsageSeriesScale,
  buildUsageSeriesScale,
  USAGE_SERIES_OTHER_KEY,
} from "@/lib/usage-analytics/usage-series-scale";

describe("buildUsageSeriesScale", () => {
  it("assigns slots in the given order, never resorted", () => {
    const scale = buildUsageSeriesScale(["codex", "claude", "opencode"]);
    expect(scale.order).toEqual(["codex", "claude", "opencode"]);
    expect(scale.colorVar("codex")).toBe("var(--usage-series-1)");
    expect(scale.colorVar("claude")).toBe("var(--usage-series-2)");
    expect(scale.colorVar("opencode")).toBe("var(--usage-series-3)");
  });

  it("caps at sixteen slots and folds the rest into Other, never generating a 17th hue", () => {
    const seventeenKeys = [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "q",
    ];
    const scale = buildUsageSeriesScale(seventeenKeys);
    expect(scale.order).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      USAGE_SERIES_OTHER_KEY,
    ]);
    expect(scale.colorVar("p")).toBe("var(--usage-series-16)");
    expect(scale.colorVar("q")).toBe("var(--usage-series-other)");
    expect(scale.labelFor(USAGE_SERIES_OTHER_KEY)).toBe("Other");
  });

  it("does not fold when there are exactly sixteen keys", () => {
    const sixteen = [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
    ];
    const scale = buildUsageSeriesScale(sixteen);
    expect(scale.order).toEqual(sixteen);
    expect(scale.order).not.toContain(USAGE_SERIES_OTHER_KEY);
  });

  it("labelFor returns the raw harness id (no invented display-name catalog)", () => {
    const scale = buildUsageSeriesScale(["claude"]);
    expect(scale.labelFor("claude")).toBe("claude");
  });

  it("an unrecognized key (not in the built order) falls back to the Other color", () => {
    const scale = buildUsageSeriesScale(["claude"]);
    expect(scale.colorVar("some-unknown-id")).toBe("var(--usage-series-other)");
  });
});

describe("buildHarnessUsageSeriesScale", () => {
  it("keeps Claude orange, Codex blue, and OpenCode neutral regardless of input order", () => {
    const scale = buildHarnessUsageSeriesScale(["opencode", "codex", "claude"]);
    expect(scale.colorVar("claude")).toBe("var(--usage-harness-claude)");
    expect(scale.colorVar("codex")).toBe("var(--usage-harness-codex)");
    expect(scale.colorVar("opencode")).toBe("var(--usage-harness-opencode)");
  });

  it("uses distinct fallback slots when brand-adjacent preferences collide", () => {
    const scale = buildHarnessUsageSeriesScale([
      "claude",
      "omp",
      "codex",
      "reasonix",
      "qwen",
      "kiro",
    ]);
    const colors = scale.order.map((key) => scale.colorVar(key));
    expect(new Set(colors).size).toBe(colors.length);
    expect(scale.colorVar("omp")).not.toMatch(/--usage-series-(2|10)\)/);
    expect(scale.colorVar("reasonix")).not.toMatch(/--usage-series-(1|9)\)/);
    expect(scale.colorVar("qwen")).not.toBe(scale.colorVar("kiro"));
  });

  it("uses audited brand accents when their color family is available", () => {
    const scale = buildHarnessUsageSeriesScale([
      "amp",
      "huggingface",
      "omp",
      "reasonix",
    ]);
    expect(scale.colorVar("amp")).toBe("var(--usage-harness-amp)");
    expect(scale.colorVar("huggingface")).toBe(
      "var(--usage-harness-huggingface)",
    );
    expect(scale.colorVar("omp")).toBe("var(--usage-harness-omp)");
    expect(scale.colorVar("reasonix")).toBe("var(--usage-harness-reasonix)");
  });

  it("keeps all selected supported harnesses visually distinct", () => {
    const supportedHarnesses = [
      "amp",
      "claude",
      "codex",
      "copilot",
      "cursor",
      "devin",
      "droid",
      "grok",
      "hermes",
      "huggingface",
      "kilocode",
      "kimi",
      "kiro",
      "omp",
      "opencode",
      "openrouter",
    ];
    const scale = buildHarnessUsageSeriesScale(supportedHarnesses);
    const colors = scale.order.map((key) => scale.colorVar(key));
    expect(new Set(colors).size).toBe(colors.length);
  });
});
