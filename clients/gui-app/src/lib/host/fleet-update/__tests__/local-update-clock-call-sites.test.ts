/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `LocalUpdateClock` has TWO slots that must be fed from two DIFFERENT
 * instants, and getting them the wrong way round is silent.
 *
 * The wire leg reads the status query's own `dataUpdatedAt`; the record leg
 * reads a renderer tick. Feeding the tick to both demotes a live attempt and
 * drops the page-wide lifecycle gate once per slow round trip (F3); feeding
 * `dataUpdatedAt` to both freezes a liveness proof that nothing ever ages out.
 * Both are well-typed calls that `projectLocalUpdate` will faithfully honour,
 * so no pin on the PROJECTOR can see either one — the mistake is made at the
 * call site, and only a mounted mirror at that call site catches it.
 *
 * This seam has needed a new mirror in two consecutive review rounds. So the
 * count is pinned: a THIRD call site is fine, but it arrives with its own two
 * mounted mirrors, and updating this list is where that gets noticed.
 *
 * Today's two, and where their mirrors live:
 *
 * | call site                             | wire slot                                  | record slot                                |
 * | ------------------------------------- | ------------------------------------------ | ------------------------------------------ |
 * | `host-overview-panel.tsx`             | `host-overview-lifecycle-gate.test.tsx`    | `host-overview-lifecycle-gate.test.tsx`    |
 * | `hooks/host/use-local-host-update-operation.ts` | `use-local-host-update-operation.test.tsx` | `use-local-host-update-operation.test.tsx` |
 *
 * Matching on `recordNowMs` rather than on the type name is deliberate: a call
 * site constructs the clock as an object literal and need never name the type,
 * so a type-name scan would miss exactly the addition this guards against.
 *
 * KNOWN HOLE, noted rather than fixed: the guard is TEXTUAL, so a call site
 * that passes a clock it did not build inline — `clock: someClock`, or one
 * assembled by a helper — names no field here and is not seen. That is a
 * narrower hole than the one this closes (today both call sites build the
 * literal in place, which is also the shape that makes the two-instant mistake
 * easy to make and easy to miss), and closing it properly means type-aware
 * analysis rather than a scan. If a helper ever does assemble one, add the
 * helper to {@link DEFINITION_MODULES} and its callers to
 * {@link EXPECTED_CALL_SITES} — the mirrors are owed per CALL SITE either way.
 */
const SRC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * The modules that DEFINE the clock rather than fill one in — the type and the
 * projection that destructures it. They mention the field by necessity and are
 * not call sites.
 */
const DEFINITION_MODULES = [
  "lib/host/fleet-update/fleet-update-view.ts",
  "lib/host/fleet-update/local-update-projection.ts",
];

const EXPECTED_CALL_SITES = [
  "components/settings/panels/host-overview-panel.tsx",
  "hooks/host/use-local-host-update-operation.ts",
];

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests fill in clocks constantly — that is what a pin on this seam
      // looks like — so they are not call sites in the sense this guards.
      if (entry === "__tests__" || entry === "test-support") continue;
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

describe("LocalUpdateClock — the call sites that must each carry two mounted mirrors", () => {
  it("has exactly the two known non-test call sites", () => {
    const callSites = collectSourceFiles(SRC_DIR)
      .filter((file) =>
        /(^|[^A-Za-z])recordNowMs\s*:/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(SRC_DIR, file).split(path.sep).join("/"))
      .filter((relative) => !DEFINITION_MODULES.includes(relative))
      .sort();

    // A LIST, not a count: a replacement — one call site deleted and another
    // added — keeps the count at two and would slip through, and the failure
    // message should name the file whose mirrors are missing.
    expect(callSites).toEqual([...EXPECTED_CALL_SITES].sort());
  });
});
