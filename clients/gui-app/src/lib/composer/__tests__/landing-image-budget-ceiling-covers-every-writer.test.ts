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
import { readdirSync, readFileSync } from "node:fs";
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

/** Production `.ts`/`.tsx` under `src`, tests and their directories excluded. */
function productionSources(): string[] {
  const found: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(join(GUI_APP_ROOT, relativeDir), {
      withFileTypes: true,
    })) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") {
          continue;
        }
        walk(relativePath);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      found.push(relativePath);
    }
  };
  walk("src");
  return found;
}

/**
 * Every production module that imports the `putImage` BINDING from the store.
 *
 * Keyed on the import rather than on the call text for two reasons. A bare
 * `putImage(` also matches `putImageBytesAtHash(` and matches the word inside a
 * comment or a doc example - a dozen files in this tree mention it without
 * calling it. And the import is what a new writer cannot avoid writing: there
 * is no way to reach the function without naming it here.
 *
 * The `^import` anchor is what keeps a commented-out import from counting: this
 * repo writes block comments with a leading ` * `, so a statement at column
 * zero is a real one.
 *
 * ## Why `putImageBytesAtHash` callers are not in this population
 *
 * They also write bytes into the partition (cloud draft recovery, the draft
 * blob transport, the stash restore, tab recovery), and they are deliberately
 * out of scope for the CEILING. That function only stores bytes whose SHA-256
 * already matches a hash some document names, so it re-materializes a blob one
 * of the writers below already minted rather than minting a new one - it cannot
 * introduce a size that none of these ceilings allowed. It is the same argument
 * `landing-image-move.ts` carries in the list, and the reason its `bound` is
 * not its own number.
 *
 * Their transport caps are looser than this ceiling (cloud recovery refuses
 * above `MAX_RENDERED_PAYLOAD_BYTES`, 16 MiB), which is an outer bound on the
 * FETCH and not a claim that blobs that size exist. If a writer is ever added
 * that mints a blob larger than every ceiling here, it is the writer that has
 * to appear below, not the re-materializer.
 */
function actualPutImageCallers(): string[] {
  const importsPutImage =
    /^import\s*\{[^}]*\bputImage\b[^}]*\}\s*from\s*["'][^"']*landing-image-store["']/m;
  return productionSources().filter((relativePath) => {
    if (relativePath === "src/lib/composer/landing-image-store.ts")
      return false;
    return importsPutImage.test(readSource(relativePath));
  });
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
    //
    // The enumeration runs over the TREE, not over `WRITERS`. Asserting that
    // each declared path calls `putImage` only proves the list contains no
    // strangers - it is satisfied by a list of one, and says nothing about the
    // writer somebody adds next week, which is the entire population this file
    // exists to bound. The set has to be built from source and compared both
    // ways.
    const store = readSource("src/lib/composer/landing-image-store.ts");
    expect(store).toContain("export async function putImage(");

    const declared = [...new Set(WRITERS.map((writer) => writer.path))].sort();
    expect(declared.length).toBe(WRITERS.length);
    expect(actualPutImageCallers().sort()).toEqual(declared);
  });

  it("the enumeration discriminates - it is not matching every file it reads", () => {
    // The control this file needs, and the one its previous version lacked: an
    // enumeration that accidentally matched everything, or nothing, would still
    // satisfy a set comparison written against whatever it returned that day.
    //
    // `cloud-draft-image-recovery.ts` is the sharpest negative available. It
    // genuinely writes bytes into this partition, it mentions `putImage` in
    // prose, and it imports `putImageBytesAtHash` from the very same module -
    // so a predicate keyed on the module path, on the word, or on any prefix
    // of the binding name would pull it in. Only one keyed on the exact
    // `putImage` binding leaves it out.
    const recovery = "src/lib/drafts/cloud-draft-image-recovery.ts";
    expect(readSource(recovery)).toContain("putImage");
    expect(actualPutImageCallers()).not.toContain(recovery);

    // And the walk really did read the tree, rather than returning an empty set
    // that would make the comparison above vacuous.
    expect(productionSources().length).toBeGreaterThan(500);
    expect(productionSources()).toContain(recovery);
  });
});
