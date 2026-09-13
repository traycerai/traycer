import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  path.resolve(__dirname, "../theme-surfaces.css"),
  "utf8",
);

describe("panel motion duration bridge", () => {
  it("routes core animated surfaces through the effective duration variable", () => {
    const durationRule =
      /:root\s*:is\(([^()]*)\)\s*\{([^{}]*animation-duration:\s*var\(--panel-motion-duration\)[^{}]*transition-duration:\s*var\(--panel-motion-duration\)[^{}]*)\}/s.exec(
        CSS,
      );
    expect(durationRule).not.toBeNull();
    const selectors = durationRule?.[1] ?? "";
    for (const selector of [
      '[data-slot="dialog-content"]',
      '[data-slot="dialog-overlay"]',
      '[data-slot="popover-content"]',
      '[data-slot="dropdown-menu-content"]',
      '[data-slot="dropdown-menu-sub-content"]',
      '[data-slot="context-menu-content"]',
      '[data-slot="context-menu-sub-content"]',
      '[data-slot="select-content"]',
      '[data-slot="hover-card-content"]',
      '[data-slot="tooltip-content"]',
      '[data-slot="sheet-content"]',
      '[data-slot="sheet-overlay"]',
      '[data-slot="drawer-content"]',
      '[data-slot="drawer-overlay"]',
      '[data-slot="collapsible-content"]',
      '[data-slot="sidebar-gap"]',
      "[data-landing-terminal-panel]",
    ]) {
      expect(selectors).toContain(selector);
    }
    expect(CSS).toContain("--panel-motion-duration");
    expect(CSS).toMatch(/animation-duration:\s*var\(--panel-motion-duration\)/);
    expect(CSS).toMatch(
      /transition-duration:\s*var\(--panel-motion-duration\)/,
    );
  });
});
