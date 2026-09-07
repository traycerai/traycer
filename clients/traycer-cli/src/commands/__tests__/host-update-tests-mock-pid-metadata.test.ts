import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `TRAYCER_HOME` is `homedir()`-derived and nothing redirects it under vitest
// (no `setupFiles`, no env override), so a test that executes
// `buildHostUpdateCommand` unmocked reads the developer's REAL
// `~/.traycer/host/pid.json`. Since the activation-debt half landed, that
// read is not merely a leak: an install record ahead of the live version
// classifies the developer's own host as debt and the command RESTARTS it -
// from a unit test. CI never sees the hazard (`~/.traycer` does not exist
// there), so a green CI run proves nothing about it.
//
// This gate is the enforceable half of that discipline. It does not install a
// default mock from a setup file on purpose: a suite-wide mock of
// `host/pid-metadata` would replace the module under test for its own three
// suites and relocate the invariant to a file no reader of the command test
// ever opens. The mock belongs beside the command it protects, and this test
// asserts it is there - across the whole `src` tree, not only this directory,
// because a caller one directory over is exactly the one a local grep misses.

const SRC_ROOT = resolve(__dirname, "..", "..");

function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules") continue;
      found.push(...testFilesUnder(path));
    } else if (name.endsWith(".test.ts") && path !== __filename) {
      // This file names the command in prose and never executes it.
      found.push(path);
    }
  }
  return found;
}

describe("every test that executes buildHostUpdateCommand mocks host/pid-metadata", () => {
  it("no test file under src runs the real command against the real pid.json", () => {
    const offenders = testFilesUnder(SRC_ROOT)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        const executesCommand =
          source.includes("buildHostUpdateCommand(") &&
          // A file that mocks the command module itself never executes it.
          !/vi\.mock\(\s*["'](?:\.\.\/)*(?:commands\/)?host-update["']/.test(
            source,
          );
        const mocksPidMetadata =
          /vi\.mock\(\s*["'](?:\.\.\/)+host\/pid-metadata["']/.test(source);
        return executesCommand && !mocksPidMetadata;
      })
      .map((path) => relative(SRC_ROOT, path));
    expect(offenders).toEqual([]);
  });

  it("the gate sees the files it guards", () => {
    // A predicate that matches nothing passes vacuously; pin that the scan
    // reaches the command's own suite so an empty offender list means
    // "every caller mocks", not "no caller was found".
    const guarded = testFilesUnder(SRC_ROOT).filter((path) =>
      readFileSync(path, "utf8").includes("buildHostUpdateCommand("),
    );
    expect(guarded.map((path) => relative(SRC_ROOT, path))).toContain(
      join("commands", "__tests__", "host-update.test.ts"),
    );
  });
});
