/// <reference types="node" />

import { build } from "cn/build";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * `src/lib/cn-tables.ts` is `cn build` output, committed rather than generated
 * at build time - see `cn.config.mjs` for the groups and `lib/utils.ts` for how
 * they are consumed. Committing it is what keeps Vitest and cloud-ui-v2's build
 * (which imports gui-app's `cn` through the submodule) off a generated file,
 * and `--full` is what makes the tables a function of the config alone rather
 * than of whichever sources were scanned.
 *
 * The cost of committing it is that the two can drift: a token added to
 * `cn.config.mjs` does nothing until someone rebuilds, and the symptom is the
 * silent one the config exists to prevent - the class merges as if it were
 * something else and is dropped when a real class of that kind joins the same
 * call. This test is the guard: it compiles the config in a scratch directory
 * and compares the result with what is on disk.
 *
 * The banner is stripped because it names the output file, which differs
 * between the scratch build and the committed one only in the path that
 * produced it.
 */
const GUI_APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const COMMITTED_TABLES = path.join(GUI_APP_ROOT, "src", "lib", "cn-tables.ts");

const withoutBanner = (source: string) => source.replace(/^(?:\/\/.*\n)+/, "");

it("the committed cn tables match cn.config.mjs", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "gui-app-cn-tables-"));
  try {
    const rebuilt = await build({
      cwd: GUI_APP_ROOT,
      config: "cn.config.mjs",
      full: true,
      out: path.join(scratch, "cn-tables.ts"),
    });

    expect(
      withoutBanner(readFileSync(COMMITTED_TABLES, "utf8")),
      "src/lib/cn-tables.ts is stale: run `bun run cn:build` in clients/gui-app and commit the result.",
    ).toBe(withoutBanner(rebuilt.source));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
