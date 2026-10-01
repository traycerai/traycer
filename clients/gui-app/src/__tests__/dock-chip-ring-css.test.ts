/// <reference types="node" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dock chip's attention ring, which is CSS and only CSS (no hook, no
 * `useAttentionRing`), so this is where its contract can be stated.
 *
 * Everything here compares two INDEPENDENT artefacts rather than re-writing a
 * declaration as a string: the variant rule that sets the ring's colour
 * against the rule that actually runs an animation, and both against the
 * `data-pulse` values the chip component can write. The failure this catches
 * is the cheap one to ship and the expensive one to find - a variant that
 * gives a chip a ring colour and no ring, or a chip that writes a value no
 * rule animates, which also strands `data-pulse` because nothing ever fires
 * `animationend` to take it off.
 */

const SOURCE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function read(relativePath: string): string {
  return readFileSync(path.join(SOURCE_DIR, relativePath), "utf8");
}

const css = read("index.css");
const chip = read("components/chat/chat-dock-compact-chip.tsx");

interface CssRule {
  readonly selector: string;
  readonly body: string;
}

/** The stylesheet as rules, comments stripped, so claims are about selectors. */
function rules(source: string): ReadonlyArray<CssRule> {
  const found: CssRule[] = [];
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(bare);
  while (match !== null) {
    found.push({ selector: match[1].trim(), body: match[2].trim() });
    match = pattern.exec(bare);
  }
  return found;
}

const chipRules = rules(css).filter((rule) =>
  rule.selector.includes("[data-chat-dock-chip]"),
);

/** The `data-pulse` values that start `chat-dock-chip-pulse`. */
function animatedPulseValues(): ReadonlyArray<string> {
  const rule = chipRules.find((candidate) =>
    candidate.body.includes("animation: chat-dock-chip-pulse"),
  );
  if (rule === undefined) throw new Error("no chip pulse animation rule");
  return [...rule.selector.matchAll(/\[data-pulse="([^"]+)"\]/g)].map(
    (match) => match[1],
  );
}

/**
 * The `data-pulse` values the chip component can put on the element.
 *
 * `pulseAttribute` is the one place they are spelled, and the attribute is
 * written from nothing else - both halves are asserted, so a second literal
 * smuggled straight into the JSX would fail rather than go unscanned.
 */
function writtenPulseValues(): ReadonlyArray<string> {
  const decision = /function pulseAttribute\([\s\S]*?\n\}/.exec(chip);
  if (decision === null) throw new Error("no pulseAttribute in the chip");
  const written = new Set<string>();
  for (const literal of decision[0].matchAll(/"([^"]+)"/g)) {
    written.add(literal[1]);
  }
  if (written.size === 0) throw new Error("chip writes no data-pulse value");
  return [...written];
}

describe("the dock chip's attention ring", () => {
  it("animates every value the chip can write", () => {
    // The scan below is exhaustive only while `pulseAttribute` is the one
    // writer. The SHAPE, not the locals' current names: one write, and it is
    // the decision function's return value rather than an expression
    // assembled at the call site. Renaming a local is not a behaviour change;
    // calling anything else there is.
    const attributes = [...chip.matchAll(/data-pulse=\{([^}]*)\}/g)].map(
      (match) => match[1],
    );
    expect(attributes).toHaveLength(1);
    expect(attributes[0]).toMatch(/^pulseAttribute\(/);

    const animated = animatedPulseValues();
    writtenPulseValues().forEach((value) => {
      expect(animated).toContain(value);
    });
  });

  it("rings in the primary tone by default and the destructive one for a failure", () => {
    const coloured = chipRules.filter((rule) =>
      rule.body.includes("--dock-chip-ring-color:"),
    );

    expect(coloured.length).toBeGreaterThan(0);
    const animated = animatedPulseValues();
    coloured.forEach((rule) => {
      const values = [...rule.selector.matchAll(/\[data-pulse="([^"]+)"\]/g)];
      expect(values.length).toBeGreaterThan(0);
      values.forEach((value) => {
        expect(animated).toContain(value[1]);
      });
    });
    expect(
      coloured.some((rule) => rule.selector.includes('[data-pulse="failure"]')),
    ).toBe(true);
    expect(
      coloured.some((rule) => rule.body.includes("var(--color-destructive)")),
    ).toBe(true);

    // The keyframe reads the tone through the variable, so a variant needs no
    // keyframe of its own, and falls back to the shipped primary.
    const keyframe = /@keyframes chat-dock-chip-pulse \{([\s\S]*?)\n\}/.exec(
      css,
    );
    if (keyframe === null) throw new Error("no chip pulse keyframe");
    expect(keyframe[1].replace(/\s+/g, " ")).toContain(
      "var(--dock-chip-ring-color, var(--color-primary))",
    );
  });

  it("keeps a literal duration in the shorthand and varies it in a longhand", () => {
    const rule = chipRules.find((candidate) =>
      candidate.body.includes("animation: chat-dock-chip-pulse"),
    );
    if (rule === undefined) throw new Error("no chip pulse animation rule");

    // A `var()` inside the `animation` shorthand makes the WHOLE declaration
    // invalid-at-computed-value if the variable ever is, taking `forwards`
    // with it - and a ring that never runs never fires `animationend`, which
    // is the event that takes `data-pulse` back off. So the variable goes in
    // its own longhand, after a shorthand that still names a real duration.
    expect(rule.body).not.toMatch(/animation:[^;]*var\(/);
    expect(rule.body).toContain(
      "animation-duration: var(--dock-chip-ring-duration, 620ms)",
    );
  });
});
