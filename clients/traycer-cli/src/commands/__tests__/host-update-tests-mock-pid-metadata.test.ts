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

// The cutover MOVED the hazard this gate exists for. `readActivationState`
// now lives in `host/update-run.ts`, so `runHostUpdate` is the function that
// reads the real `pid.json` and can restart a developer's own host; the
// command file is a thin shell that calls it. Both entry points are therefore
// scanned, and the pid-metadata mock is recognised at either depth
// (`../../host/pid-metadata` from `commands/__tests__`, `../pid-metadata`
// from `host/__tests__`).
const EXECUTES = ["buildHostUpdateCommand(", "runHostUpdate("];

// A file that mocks the module under test never executes the real thing.
const MOCKS_ENTRY_POINT =
  /vi\.mock\(\s*["'](?:\.\.\/)*(?:commands\/)?host-update["']|vi\.mock\(\s*["'](?:\.\.\/)*(?:host\/)?update-run["']/;

const MOCKS_PID_METADATA =
  /vi\.mock\(\s*["'](?:\.\.\/)+(?:host\/)?pid-metadata["']/;

describe("every test that executes host update mocks host/pid-metadata", () => {
  it("no test file under src runs the real command against the real pid.json", () => {
    const offenders = testFilesUnder(SRC_ROOT)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        const executes =
          EXECUTES.some((marker) => source.includes(marker)) &&
          !MOCKS_ENTRY_POINT.test(source);
        return executes && !MOCKS_PID_METADATA.test(source);
      })
      .map((path) => relative(SRC_ROOT, path));
    expect(offenders).toEqual([]);
  });

  it("the gate sees the files it guards", () => {
    // A predicate that matches nothing passes vacuously; pin that the scan
    // reaches BOTH entry points' own suites, so an empty offender list means
    // "every caller mocks", not "no caller was found". The legacy
    // `commands/__tests__/host-update.test.ts` this used to name was retired
    // by the executor cutover and its pins live in `update-run.test.ts`.
    const guarded = testFilesUnder(SRC_ROOT)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return EXECUTES.some((marker) => source.includes(marker));
      })
      .map((path) => relative(SRC_ROOT, path));
    expect(guarded).toContain(join("host", "__tests__", "update-run.test.ts"));
    expect(guarded).toContain(
      join("commands", "__tests__", "host-update-dispatch-ack-guard.test.ts"),
    );
  });
});
