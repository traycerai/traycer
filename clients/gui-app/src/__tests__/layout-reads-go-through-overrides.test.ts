/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every layout value a component DRAWS from must be read through
 * `lib/layout-overrides.ts`, never selected straight out of the layout store.
 *
 * The seam is what lets the inspector's specimen stage draw a REAL leaf under
 * a different value (L-11): it wraps the leaf in an override context, and the
 * hooks layer that context over the stored triple. A file that selects the
 * store directly is invisible to that wrapper, so its element keeps showing
 * the user's live value inside a picture of an alternative - the failure is
 * silent, looks like "that option does nothing", and is exactly the kind of
 * thing a reviewer stops noticing once ten call sites are converted and the
 * eleventh is added months later.
 *
 * Statically decidable, so it is a test rather than a convention.
 *
 * ## What is deliberately NOT converted
 *
 * A read that decides whether an element EXISTS is an ancestor seam, and D11
 * says an override must not reach one: wrapping it would make a specimen mount
 * real chrome - a strip that registers keyboard slots, a stream that starts
 * polling. Those stay on the store, and each is listed in
 * {@link DIRECT_READ_EXEMPTIONS} with the reason. A read by a CONTROL that
 * writes the value (the inspector, the Layout page, the strip's own right-click
 * menu) is exempt for the mirror-image reason: a control must show and write
 * the real value, never a previewed one.
 *
 * Writes are not reads: selecting `setArrangement` / `setRegionValues` names an
 * action, and there is nothing for an override to layer over it.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The three fields the seam serves, as they appear inside a selector. */
const MIGRATED_READS: ReadonlyArray<{
  readonly selector: RegExp;
  readonly hook: string;
}> = [
  {
    selector: /\b(?:state|s)\s*\.\s*(?:overrides|basePreset)\b/,
    hook: "useRegionValues(regionId) / useRegionValue(regionId, key) / useRegionShown(regionId) / useRailVisibility(regionId)",
  },
  {
    selector: /\b(?:state|s)\s*\.\s*arrangement\b/,
    hook: "useArrangementValue(key)",
  },
];

/**
 * Files allowed to read the layout store directly, each with the reason.
 *
 * Two kinds only. An ANCESTOR decides whether an element is rendered at all,
 * and an override above one would make a specimen mount live chrome. A CONTROL
 * shows and writes the real value, so a previewed one would be a switch that
 * lies about what it is about to do.
 */
const DIRECT_READ_EXEMPTIONS: Readonly<Record<string, string>> = {
  // The seam itself.
  "lib/layout-overrides.ts": "the seam",
  // The rail's derivation and its writers. What it answers is which panels
  // EXIST on the rail and in what order - an ancestor seam by D11, and the one
  // the sidebar's own mount decisions are made from. Layering a specimen's
  // preview over it would mount real panels.
  "lib/layout/rail-view.ts": "the rail's shape: an ancestor seam",
};

/**
 * The inspector and the Layout page are controls, all of them: a control shows
 * and writes the real value, so a previewed one would be a switch that lies
 * about what it is about to do. The strip's own right-click menu and the usage
 * popover are controls in the same sense, and are absent from this list only
 * because they select ACTIONS rather than values.
 */
const CONTROL_PREFIXES: ReadonlyArray<string> = [
  "components/layout-editor/",
  "components/settings/",
];

/** Stores own their own state. */
const STORES_PREFIX = "stores/";

function collectSourceFiles(dir: string): ReadonlyArray<string> {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/**
 * The selector bodies in one file: everything between a store hook call and
 * the end of its argument list, approximated by the next `);` - long enough to
 * span a multi-line selector, short enough not to swallow the next statement.
 */
function selectorBodies(source: string): ReadonlyArray<string> {
  const bodies: string[] = [];
  const call = /useLayoutStore\(/g;
  let match = call.exec(source);
  while (match !== null) {
    const start = match.index + match[0].length;
    const end = source.indexOf(");", start);
    bodies.push(source.slice(start, end === -1 ? start + 200 : end));
    match = call.exec(source);
  }
  return bodies;
}

function isExempt(relative: string): boolean {
  return (
    relative in DIRECT_READ_EXEMPTIONS ||
    CONTROL_PREFIXES.some((prefix) => relative.startsWith(prefix)) ||
    relative.startsWith(STORES_PREFIX)
  );
}

describe("layout value reads go through the override seam", () => {
  it("finds no direct store read of a layout value", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const relative = path.relative(SRC_DIR, file).split(path.sep).join("/");
      if (isExempt(relative)) continue;
      const bodies = selectorBodies(readFileSync(file, "utf8"));
      for (const body of bodies) {
        for (const migrated of MIGRATED_READS) {
          if (!migrated.selector.test(body)) continue;
          offenders.push(`${relative} -> read it through ${migrated.hook}`);
        }
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  // A file that stops reading the store should lose its exemption, or the list
  // silently grows into a permission to regress.
  it("keeps no exemption for a file that no longer reads the store", () => {
    const stale: string[] = [];
    for (const relative of Object.keys(DIRECT_READ_EXEMPTIONS)) {
      const source = readFileSync(path.join(SRC_DIR, relative), "utf8");
      const reads = selectorBodies(source).some((body) =>
        MIGRATED_READS.some((migrated) => migrated.selector.test(body)),
      );
      // The seam reads the triple itself, by definition.
      if (!reads && relative !== "lib/layout-overrides.ts") {
        stale.push(relative);
      }
    }

    expect(stale).toEqual([]);
  });
});
