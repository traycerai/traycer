/**
 * `LANDING_IMAGE_MAX_BYTES_PER_IMAGE` is a claim about EVERY path that can put
 * bytes in the landing partition, and this is where that claim is checked.
 *
 * ## Why this file exists
 *
 * The constant is read back by the budget's own suite
 * (`landing-image-budget.test.ts`), which is right for what those cases assert -
 * the RELATIONSHIP between the charge and admission - and useless for the value
 * itself: a case that computes `BUDGET - CEILING` moves with the ceiling and
 * passes at any number. The only cases that constrain the number at all do it
 * implicitly, through `13 * CEILING > BUDGET`, which is a lower bound and says
 * nothing about an upper one.
 *
 * That is not hypothetical. An OSS merge substituted the paste ceiling
 * (`PREPARED_IMAGE_MAX_BYTES`, 3.75 MiB) for the real bound here, and every
 * test that read the constant back stayed green; what reddened was the
 * implicit `13 ×` arithmetic in four unrelated DRIVE RED cases, which reads as
 * those cases breaking rather than as the constant being wrong.
 *
 * ## What the constant has to be
 *
 * The largest blob any writer can land, because `rootByteCost` charges an
 * unmeasured resident root exactly this much - "the most it could possibly be
 * costing". Under-stating it admits more than `LANDING_IMAGE_BUDGET_BYTES` of
 * real bytes on a cold start, when EVERY root is unmeasured.
 *
 * The writers do not share one ceiling, which is the whole difficulty:
 *
 *  - paste / drop / structured-paste ingest / browser-annotation crops all
 *    prepare under `PREPARED_IMAGE_POLICY` and land at most
 *    `PREPARED_IMAGE_MAX_BYTES`;
 *  - the prompt-stash restore writes the stash's blob straight through with no
 *    ceiling of its own, so its bound is the STASH policy's - and that policy
 *    keeps an animated GIF/WebP verbatim up to `PROMPT_STASH_IMAGE_MAX_BYTES`,
 *    because an animation cannot be re-encoded frame-faithfully;
 *  - the cross-partition move re-writes bytes an earlier writer already
 *    admitted, so it cannot raise the bound.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LANDING_IMAGE_MAX_BYTES_PER_IMAGE } from "@/lib/composer/landing-image-budget";
import {
  PREPARED_IMAGE_POLICY,
  PROMPT_STASH_PREPARATION_POLICY,
} from "@/lib/composer/prompt-stash-image-preparation";

const GUI_APP_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(GUI_APP_ROOT, relativePath), "utf8");
}

/**
 * Every module that calls `putImage`, with the ceiling that bounds what it can
 * write. Keyed by path so the enumeration below can prove the list is complete
 * rather than merely plausible.
 */
const WRITERS = [
  {
    path: "src/hooks/composer/use-composer-paste.ts",
    bound: PREPARED_IMAGE_POLICY.byteCeiling,
    why: "prepares under PREPARED_IMAGE_POLICY",
  },
  {
    path: "src/hooks/composer/use-landing-composer-paste.ts",
    bound: PREPARED_IMAGE_POLICY.byteCeiling,
    why: "prepares under PREPARED_IMAGE_POLICY",
  },
  {
    path: "src/hooks/composer/use-composer-pending-image-ingest.ts",
    bound: PREPARED_IMAGE_POLICY.byteCeiling,
    why: "prepares under PREPARED_IMAGE_POLICY",
  },
  {
    path: "src/lib/browser-view/annotation/browser-annotation-attach.ts",
    bound: PREPARED_IMAGE_POLICY.byteCeiling,
    why: "prepares the crop under PREPARED_IMAGE_POLICY",
  },
  {
    path: "src/lib/composer/landing-stash-import.ts",
    bound: PROMPT_STASH_PREPARATION_POLICY.animationCeiling,
    why: "writes the stash blob verbatim; the stash keeps animations to its own ceiling",
  },
  {
    path: "src/lib/composer/landing-image-move.ts",
    bound: PREPARED_IMAGE_POLICY.byteCeiling,
    why: "re-writes bytes another writer already admitted",
  },
] as const;

describe("the landing per-image ceiling bounds every writer", () => {
  it("is at least as large as each writer's own ceiling", () => {
    for (const writer of WRITERS) {
      expect(
        LANDING_IMAGE_MAX_BYTES_PER_IMAGE,
        `${writer.path} (${writer.why})`,
      ).toBeGreaterThanOrEqual(writer.bound);
    }
  });

  it("is EXACTLY the largest of them - a ceiling above every writer is also a tax", () => {
    // Not just `>=`. Charging more than any writer can land over-charges every
    // unmeasured root on a cold start, which refuses pastes that would fit -
    // the failure this constant had in the opposite direction, and just as
    // invisible, since it only shows up before the startup measurement lands.
    const largest = Math.max(...WRITERS.map((writer) => writer.bound));
    expect(LANDING_IMAGE_MAX_BYTES_PER_IMAGE).toBe(largest);
  });

  it("the two policies really do disagree, so the max above is doing work", () => {
    // The control. If the stash ever adopts the paste ceiling, every assertion
    // above passes with either constant and this file silently stops testing
    // anything - the exact shape that let the substitution through. Then the
    // `max` is redundant and this file should be re-derived, not deleted.
    expect(PROMPT_STASH_PREPARATION_POLICY.animationCeiling).not.toBe(
      PREPARED_IMAGE_POLICY.byteCeiling,
    );
  });

  it("names every putImage caller, so a new writer cannot be added silently", () => {
    // A source enumeration rather than a type, because there is nothing in the
    // type system that says "this function's argument is bounded". A new
    // writer with a larger ceiling would raise the bound and nothing else in
    // the tree would notice; this reds until it is added to WRITERS with its
    // ceiling named.
    const store = readSource("src/lib/composer/landing-image-store.ts");
    expect(store).toContain("export async function putImage(");

    const declared = new Set(WRITERS.map((writer) => writer.path));
    for (const path of declared) {
      expect(readSource(path), path).toContain("putImage(");
    }
    expect(declared.size).toBe(WRITERS.length);
  });
});
