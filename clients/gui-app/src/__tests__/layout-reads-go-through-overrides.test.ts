/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every layout preference a component DRAWS from must be read through
 * `lib/layout-overrides.ts`, never selected straight out of the store.
 *
 * The seam is what lets a Customize popover or a preset thumbnail wrap the
 * real component and get the real drawing under a different value. A file that
 * reads the store directly is invisible to that wrapper, so its element keeps
 * showing the user's live setting inside a picture of an alternative - the
 * failure is silent, looks like "that option does nothing", and is exactly the
 * kind of thing a reviewer stops noticing once ten call sites are converted and
 * the eleventh is added months later.
 *
 * Statically decidable, so it is a test rather than a convention.
 *
 * ## What is deliberately NOT converted
 *
 * A read that decides whether an element EXISTS is an ancestor seam, and D11
 * says an override must not reach one: wrapping it would make a preview mount
 * real chrome - a strip that registers keyboard slots, a stream that starts
 * polling. Those stay on the store, and each is listed in
 * {@link DIRECT_READ_EXEMPTIONS} with the reason. A read by a CONTROL that
 * writes the setting (the Layout page, the strip's own right-click menu) is
 * exempt for the mirror-image reason: a control must show and write the real
 * value, never a previewed one.
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The preference names the seam serves, as they appear inside a selector.
 *
 * `composer` and `statusBar` name the SLICES, because selecting a whole slice
 * (`(state) => state.composer`) reaches every leaf under it - which is what the
 * chat tile's dock chrome used to do.
 */
const MIGRATED_READS: ReadonlyArray<{
  readonly selector: RegExp;
  readonly hook: string;
}> = [
  {
    selector: /\bstate\s*\.\s*composer\b|\bs\s*\.\s*composer\b/,
    hook: "useComposerLayoutValue(key), or useComposerLayout() for a whole-slice reader",
  },
  {
    selector:
      /\bstate\s*\.\s*statusBar\s*\.\s*(?:rateLimits\s*\.\s*(?:percentMode|showModeWord|showBar|showTimer)|resources\s*\.\s*(?:scope|metrics))\b/,
    hook: "useStatusBarRateLimitValue(key) / useStatusBarResourceValue(key)",
  },
  {
    selector:
      /\b(?:state|s)\s*\.\s*(pinContextUsageBreakdown|pinnedContextBreakdownFields|pinnedContextBreakdownOrder|contextIndicatorStyle|chatTurnMinimapSide|navigatorResourceMetrics|homeTabEnabled)\b/,
    hook: "useLayoutSetting(...)",
  },
];

/**
 * Files allowed to keep reading the store directly, each with the reason.
 *
 * Two kinds only. An ANCESTOR decides whether an element is rendered at all,
 * and an override above one would make a preview mount live chrome. A CONTROL
 * shows and writes the real value, so a previewed one would be a switch that
 * lies about what it is about to do.
 */
const DIRECT_READ_EXEMPTIONS: Readonly<Record<string, string>> = {
  // The seam itself.
  "lib/layout-overrides.ts": "the seam",
  // Presets read and write whole slices; a bundle is about the stored values.
  "lib/layout-presets.ts": "reads and writes the stored values by definition",
  // ANCESTORS: mount decisions. `app-status-bar` belongs here in spirit and is
  // absent on purpose - the keys it reads (`rateLimits.enabled`,
  // `resources.enabled`) are not ones the seam serves, so it needs no waiver.
  "components/layout/top-level-tab-host.tsx":
    "ancestor - decides the Home tab's route host exists",
  "components/layout/shell/mobile-nav-drawer.tsx":
    "ancestor - decides the drawer's Home entry exists; phone only",
  "components/layout/header/mobile-app-header.tsx":
    "ancestor - decides the mobile header's Home affordance exists",
  "providers/resources-stream-mount.tsx":
    "ancestor - subscribing starts a resource stream, which a preview must never do",
  "lib/commands/sources/actions.source.ts":
    "ancestor - decides whether a palette command exists, not how one draws",
};

/**
 * The Layout settings page and its groups are controls, all of them: a control
 * shows and writes the real value, so a previewed one would be a switch that
 * lies about what it is about to do. The strip's own right-click menu and the
 * usage popover are controls in the same sense, and are absent from the waiver
 * list only because the keys they write are not ones the seam serves.
 */
const SETTINGS_PANEL_PREFIX = "components/settings/";

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
  const call = /use(?:Layout|Settings)Store\(/g;
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
    relative.startsWith(SETTINGS_PANEL_PREFIX) ||
    relative.startsWith(STORES_PREFIX)
  );
}

describe("layout preference reads go through the override seam", () => {
  it("finds no direct store read of a migrated preference", () => {
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
      // The seam reads the slices itself, by definition.
      if (!reads && relative !== "lib/layout-overrides.ts") {
        stale.push(relative);
      }
    }

    expect(stale).toEqual([]);
  });
});
