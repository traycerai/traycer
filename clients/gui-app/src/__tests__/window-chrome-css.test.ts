/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The window-chrome variables, asserted on the stylesheet's text: jsdom has no
 * `env()`, so the values cannot be read back from computed style.
 */

const css = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "styles/window-chrome.css",
  ),
  "utf8",
);

/** The overlay top before the band-height variable existed. */
const PRE_CHANGE_OVERLAY_TOP =
  "max(env(titlebar-area-height, 0px), calc(var(--spacing) * 10))";

/** Selector to declarations, comments stripped and whitespace collapsed. */
function rules(source: string): ReadonlyMap<string, string> {
  const flat = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
  const map = new Map<string, string>();
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    const body = match[2].trim();
    map.set(selector, body);
  }
  return map;
}

const parsed = rules(css);

function body(selector: string): string {
  const found = parsed.get(selector);
  if (found === undefined) {
    throw new Error(`no rule for ${selector}`);
  }
  return found;
}

describe("window-chrome.css", () => {
  it("defaults the band height to the pre-change overlay top", () => {
    expect(body(":root")).toBe(
      `--app-title-band-height: ${PRE_CHANGE_OVERLAY_TOP};`,
    );
  });

  it("zeroes the band height when the column declares no band", () => {
    expect(body(':root[data-app-title-band="none"]')).toBe(
      "--app-title-band-height: 0px;",
    );
  });

  it("reserves the traffic-light inset under a window-controls overlay", () => {
    expect(body(".wco")).toBe(
      "--window-leading-inset: env(titlebar-area-x, 82px);",
    );
  });

  it("drops the app column to a plain gutter beside a left-docked inspector, never above the platform inset", () => {
    expect(body('.wco [data-layout-column][data-inspector-dock="left"]')).toBe(
      "--window-leading-inset: min(env(titlebar-area-x, 82px), 0.75rem);",
    );
  });

  it("starts modal overlays below the band height", () => {
    expect(
      body(
        '.wco :is([data-slot="dialog-overlay"], [data-slot="sheet-overlay"], [data-slot="drawer-overlay"])',
      ),
    ).toBe("top: var(--app-title-band-height);");
  });
});
