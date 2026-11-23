import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectExecSyncStdioScanFiles } from "../../../../shared/__tests__/exec-sync-stdio-checker";

// Round Q, P6 and P7: the sign-in's verdict and the store-backed rotation each
// have ONE reach. The CLI's production sources are read as text, so a new site
// that reads the verdict synchronously, or rotates around `refreshSignIn`, fails
// here by file and line.

const SRC = fileURLToPath(new URL("../..", import.meta.url));

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

// The shared source collector, narrowed to this package's non-test TypeScript.
const PRODUCTION_FILES: readonly string[] = collectExecSyncStdioScanFiles(
  REPO_ROOT,
)
  .map((path) => relative(SRC, path).replaceAll("\\", "/"))
  .filter((path) => !path.startsWith("..") && path.endsWith(".ts"))
  .sort();

function linesMatching(file: string, pattern: RegExp): readonly string[] {
  return readFileSync(join(SRC, file), "utf8")
    .split("\n")
    .flatMap((text, index) =>
      pattern.test(text) && !text.trimStart().startsWith("//")
        ? [`${relative(SRC, join(SRC, file))}:${index + 1}: ${text.trim()}`]
        : [],
    );
}

/** The 1-based lines of the two-space-indented `const <name> = ...` function in `file`, through its closing `  };`. */
function linesOfFunction(file: string, name: string): ReadonlySet<number> {
  const lines = readFileSync(join(SRC, file), "utf8").split("\n");
  const start = lines.findIndex((text) =>
    text.startsWith(`  const ${name} = `),
  );
  const length = lines.slice(start).findIndex((text) => text === "  };");
  if (start < 0 || length < 0)
    throw new Error(`${name} is not a two-space-indented function in ${file}`);
  return new Set(
    Array.from({ length: length + 1 }, (_unused, offset) => start + offset + 1),
  );
}

describe("the verdict has one reach (P6)", () => {
  // The synchronous read of the verdict, `tokens.signInRejected()`, is the
  // judge's own. Every exit that labels a sign-in rejected reads the one async
  // read that adopts the credentials file first.
  const SYNC_VERDICT_CALL = /\.signInRejected\(\)/;

  it("reads the synchronous verdict nowhere outside the token judge", () => {
    const readers = PRODUCTION_FILES.filter(
      (file) => file !== "internal/cli-host-tokens.ts",
    ).flatMap((file) => linesMatching(file, SYNC_VERDICT_CALL));

    expect(readers).toEqual([]);
  });

  it.each(["internal/host-rpc.ts", "host/credential-provisioning.ts"])(
    "has %s label a rejected sign-in through the async read",
    (file) => {
      expect(
        linesMatching(file, /\b(signInRejectionNow|refusalEndingCommandNow)\b/),
      ).not.toEqual([]);
    },
  );
});

describe("the store-backed rotation has one reach (P7)", () => {
  // `refreshSignIn` is the one writer of the rotation facts: it calls the
  // rotation. The store module defines the rotation, and the one in
  // cli-environment-cloud.ts is a different lease.
  const ROTATION_CALL = /\.(rotateSignIn|revalidateCurrentContext)\(/;
  const OWN_LEASE = new Set([
    "store/credentials-store.ts",
    "internal/cli-environment-cloud.ts",
  ]);
  const TOKENS_FILE = "internal/cli-host-tokens.ts";

  it("calls the rotation only from refreshSignIn", () => {
    const writer = linesOfFunction(TOKENS_FILE, "refreshSignIn");
    const calls = PRODUCTION_FILES.filter(
      (file) => !OWN_LEASE.has(file),
    ).flatMap((file) =>
      linesMatching(file, ROTATION_CALL).filter(
        (line) =>
          !(
            file === TOKENS_FILE &&
            writer.has(Number(line.split(":")[1]))
          ),
      ),
    );

    expect(calls).toEqual([]);
  });
});
