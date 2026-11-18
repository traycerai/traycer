import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// F10 (Ticket 05 review, round 5): the CLI adapter's own doc comment claims
// "an architecture check asserts that name never appears in this file's
// export surface" - but no such check existed. The reviewer showed the claim
// was decorative: `writeAdoptionProof` (the MINT half) could be re-exported
// from `update-adoption.ts`, or imported directly by any other CLI source
// file from `@traycer-clients/shared/host-update`, and nothing in the suite
// would catch it. This file binds that property for real, the same way
// `clients/shared/__tests__/host-update-contender-architecture.test.ts` binds
// its own lock-site allowlists: by walking real production source and
// failing on the exact identifier, not by trusting a comment.
//
// Ablated: temporarily re-added `export { writeAdoptionProof } from
// "@traycer-clients/shared/host-update";` to `update-adoption.ts` and ran
// this suite - both tests below went red (the adapter-export test on the
// re-export line itself, the whole-package test on the same line via the
// walker). Reverted immediately; not left in the tree.

const CLI_SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const MINT_IDENTIFIER_PATTERN = /\bwriteAdoptionProof\b/;

// Comments (this file's own docs use the identifier as prose - "there is no
// `writeAdoptionProof` here" - and must not trip the check) are stripped
// before matching; only real code tokens count.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Dependencies and gitignored build outputs (`**/dist/` etc. — no tracked
// source lives under these names) are pruned: scanning them would make the
// gate's verdict depend on whether a local build has run, and CI never sees
// them.
const PRUNED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "out",
  "dist",
  "dist-sea",
  "dist-npm",
  "build",
]);

async function walkSourceFiles(
  root: string,
  visited: Set<string>,
): Promise<string[]> {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (canonicalRoot === null || visited.has(canonicalRoot)) return [];
  const ancestry = new Set(visited);
  ancestry.add(canonicalRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (PRUNED_DIRECTORY_NAMES.has(entry.name)) return [];
      const path = join(root, entry.name);
      const info = await stat(path).catch(() => null);
      if (info === null) return [];
      if (info.isDirectory()) return walkSourceFiles(path, ancestry);
      if (!info.isFile()) return [];
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      return SOURCE_EXTENSIONS.has(extension) && !entry.name.endsWith(".d.ts")
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

describe("the CLI's export surface cannot mint an update-attempt adoption proof", () => {
  it("`update-adoption.ts` never re-exports `writeAdoptionProof`", async () => {
    const path = join(CLI_SRC_ROOT, "host", "update-adoption.ts");
    const source = stripComments(await readFile(path, "utf8"));
    expect(MINT_IDENTIFIER_PATTERN.test(source)).toBe(false);
  });

  it("no file under the CLI package imports the mint function from anywhere", async () => {
    const files = await walkSourceFiles(CLI_SRC_ROOT, new Set());
    const offenders: string[] = [];
    for (const path of files) {
      const relativePath = relative(CLI_SRC_ROOT, path).split(sep).join("/");
      if (relativePath.split("/").includes("__tests__")) continue;
      const source = stripComments(await readFile(path, "utf8"));
      if (MINT_IDENTIFIER_PATTERN.test(source)) offenders.push(relativePath);
    }
    // Zero, not "fewer than before": the CLI never holds a segment whose
    // children need to mint a proof (only Desktop, as the packaged-macOS
    // executor, does). A single offending import is enough to widen the mint
    // boundary silently.
    expect(offenders).toEqual([]);
  });
});
