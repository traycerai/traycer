import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHarnessUsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";

const CSS = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../styles/usage-analytics-chart.css",
  ),
  "utf8",
);

function colorIn(blockSelector: string, token: string): string {
  const start = CSS.indexOf(blockSelector);
  if (start < 0) throw new Error(`missing block ${blockSelector}`);
  const scope = CSS.slice(start, CSS.indexOf("}", start));
  const match = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(scope);
  if (match?.[1] === undefined) throw new Error(`missing ${token}`);
  return match[1];
}

function relativeLuminance(color: string): number {
  const hex = color.replace("#", "");
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const hi = Math.max(first, second);
  const lo = Math.min(first, second);
  return (hi + 0.05) / (lo + 0.05);
}

function resolveColor(blockSelector: string, colorVar: string): string {
  const token = colorVar.slice("var(".length, -1);
  return colorIn(blockSelector, token);
}

const TOKENS = [
  "--usage-harness-amp",
  "--usage-harness-claude",
  "--usage-harness-codex",
  "--usage-harness-huggingface",
  "--usage-harness-omp",
  "--usage-harness-opencode",
  "--usage-harness-reasonix",
];

describe("usage harness brand anchors", () => {
  it("pins the audited brand accents in both themes", () => {
    expect(
      TOKENS.map((token) => colorIn(".usage-chart-root {", token)),
    ).toEqual([
      "#d93e34",
      "#d47628",
      "#2a78d6",
      "#9a6700",
      "#c65300",
      "#303030",
      "#0153e5",
    ]);
    expect(
      TOKENS.map((token) => colorIn(".dark .usage-chart-root {", token)),
    ).toEqual([
      "#f35a4e",
      "#e58a45",
      "#3987e5",
      "#ffd21e",
      "#f97316",
      "#d8d8d8",
      "#4f82ff",
    ]);
  });

  it("keeps every anchor visible on the surfaces the usage UI renders on", () => {
    const lightSurface = "#ffffff";
    const darkestLightContrast = Math.min(
      ...TOKENS.map((token) =>
        contrastRatio(colorIn(".usage-chart-root {", token), lightSurface),
      ),
    );
    expect(darkestLightContrast).toBeGreaterThan(3);

    const darkSurfaces = ["#343434", "#313244", "#3b4252"];
    for (const token of TOKENS) {
      const color = colorIn(".dark .usage-chart-root {", token);
      for (const surface of darkSurfaces) {
        expect(contrastRatio(color, surface)).toBeGreaterThan(2.5);
      }
    }
  });

  it("resolves every supported harness to a distinct color in both themes", () => {
    const scale = buildHarnessUsageSeriesScale([
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
    ]);

    for (const selector of [
      ".usage-chart-root {",
      ".dark .usage-chart-root {",
    ]) {
      const colors = scale.order.map((key) =>
        resolveColor(selector, scale.colorVar(key)),
      );
      expect(new Set(colors).size).toBe(colors.length);
    }
  });
});
