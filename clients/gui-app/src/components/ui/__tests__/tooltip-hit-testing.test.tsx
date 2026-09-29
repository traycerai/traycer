/**
 * Regression coverage for traycerai/traycer#466 (and the click half of #446):
 * a label-only tooltip swallowing clicks meant for whatever it covers.
 *
 * jsdom has no layout and cannot hit-test, so this only pins the CSS rule
 * exists and targets the tooltip positioner. The end-to-end proof that a
 * click reaches the covered control needs a real browser and lives in
 * `scripts/primitive-gate-browser.mjs`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const INDEX_CSS = readFileSync(
  path.resolve(__dirname, "../../../index.css"),
  "utf8",
);

/** The `pointer-events: none` rule guarding tooltip positioners, as authored. */
function tooltipPositionerRule(): { selector: string; body: string } | null {
  for (const match of INDEX_CSS.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const selector = match[1].trim();
    const body = match[2];
    if (
      selector.includes('[data-slot="tooltip-positioner"]') &&
      /pointer-events\s*:\s*none/.test(body)
    ) {
      return { selector, body };
    }
  }
  return null;
}

describe("tooltip hit-testing", () => {
  it("index.css takes the tooltip positioner out of hit-testing", () => {
    expect(tooltipPositionerRule()).not.toBeNull();
  });
});
