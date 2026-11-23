import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Round Q, P6 and P7: the sign-in's verdict and the store-backed rotation each
// have ONE reach. The CLI's production sources are read as text, so a new site
// that reads the verdict synchronously, or rotates around `refreshSignIn`, fails
// here by file and line.

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function productionSources(): readonly string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".d.ts") &&
        !path.split("/").includes("__tests__") &&
        !path.endsWith(".test.ts"),
    )
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
}

function linesMatching(file: string, pattern: RegExp): readonly string[] {
  return readFileSync(join(SRC, file), "utf8")
    .split("\n")
    .flatMap((text, index) =>
      pattern.test(text) && !text.trimStart().startsWith("//")
        ? [`${relative(SRC, join(SRC, file))}:${index + 1}: ${text.trim()}`]
        : [],
    );
}

describe("the verdict has one reach (P6)", () => {
  // The synchronous read of the verdict, `tokens.signInRejected()`, is the
  // judge's own. Every exit that labels a sign-in rejected reads the one async
  // read that adopts the credentials file first.
  const SYNC_VERDICT_CALL = /\.signInRejected\(\)/;

  it("reads the synchronous verdict nowhere outside the token judge", () => {
    const readers = productionSources()
      .filter((file) => file !== "internal/cli-host-tokens.ts")
      .flatMap((file) => linesMatching(file, SYNC_VERDICT_CALL));

    expect(readers).toEqual([]);
  });

  it.each(["internal/host-rpc.ts", "host/credential-provisioning.ts"])(
    "has %s label a rejected sign-in through the async read",
    (file) => {
      expect(linesMatching(file, /\bsignInRejectedNow\b/)).not.toEqual([]);
    },
  );
});

describe("the store-backed rotation has one reach (P7)", () => {
  // `refreshSignIn` is the writer of the rotation facts, and the token options'
  // `refresh` is what it calls. The store module defines the rotation, and the
  // login flow's own revalidator (sign-in-environments.ts) is a different
  // lease, as is the one in cli-environment-cloud.ts.
  const ROTATION_CALL = /\.(rotateSignIn|revalidateCurrentContext)\(/;
  const OWN_LEASE = new Set([
    "store/credentials-store.ts",
    "internal/sign-in-environments.ts",
    "internal/cli-environment-cloud.ts",
  ]);

  it("calls the rotation only as the token options' refresh", () => {
    const calls = productionSources()
      .filter((file) => !OWN_LEASE.has(file))
      .flatMap((file) => linesMatching(file, ROTATION_CALL))
      .filter((line) => !/refresh: \(\) => revalidator\.rotateSignIn\(\)/.test(line));

    expect(calls).toEqual([]);
  });
});
