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

// The THIRD way in, and the one neither function marker sees: a registration
// suite reaches exactly the same code through
// `program.parseAsync(["host", "update", ...])`. That is the caller "one
// directory over" this gate exists for, and it was missed until a
// package-wide run under a redirected HOME caught the suite writing into the
// host home. Anchored on `parseAsync` on purpose - the bare literal also
// appears in a `findByPath(program, ["host", "update"])` lookup and in an
// argv FIXTURE that is never parsed, neither of which executes anything.
const EXECUTES_VIA_ARGV = /parseAsync\([^)]*"host",\s*"update"/s;

// A file that mocks - or stubs out - the module under test never executes the
// real thing. A `vi.spyOn(module, "buildHostUpdateCommand")` counts: it
// replaces the command factory for the whole test just as a module mock does,
// which is how the argv-contract suite parses real `host update` invocations
// without running one.
const MOCKS_ENTRY_POINT =
  /vi\.mock\(\s*["'](?:\.\.\/)*(?:commands\/)?host-update["']|vi\.mock\(\s*["'](?:\.\.\/)*(?:host\/)?update-run["']|\.spyOn\([^,]+,\s*["']buildHostUpdateCommand["']\)/;

const MOCKS_PID_METADATA =
  /vi\.mock\(\s*["'](?:\.\.\/)+(?:host\/)?pid-metadata["']/;

// The SECOND hazard class, and a different one: the pid-metadata mock
// isolates a READ, and nothing about it isolates a WRITE. `host update` on
// the executor takes a real attempt lock, reads and writes a real attempt
// record, and publishes a real dispatch ACK - all under
// `hostHomeDir(environment)`, which no per-module mock intercepts because
// only the PATHS decide where a write lands. A unit test was observed
// publishing the developer's own `~/.traycer/host/update-dispatch-ack.json`
// exactly this way.
const MOCKS_PATHS = /vi\.mock\(\s*["'](?:\.\.\/)+store\/paths["']/;

/** Reaches the real command, by either name or argv, without stubbing it. */
function executesHostUpdate(source: string): boolean {
  const reaches =
    EXECUTES.some((marker) => source.includes(marker)) ||
    EXECUTES_VIA_ARGV.test(source);
  return reaches && !MOCKS_ENTRY_POINT.test(source);
}

describe("every test that executes host update mocks host/pid-metadata", () => {
  it("no test file under src runs the real command against the real pid.json", () => {
    const offenders = testFilesUnder(SRC_ROOT)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return executesHostUpdate(source) && !MOCKS_PID_METADATA.test(source);
      })
      .map((path) => relative(SRC_ROOT, path));
    expect(offenders).toEqual([]);
  });

  it("no test file under src runs the real command against the real host home", () => {
    const offenders = testFilesUnder(SRC_ROOT)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return executesHostUpdate(source) && !MOCKS_PATHS.test(source);
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
        return (
          EXECUTES.some((marker) => source.includes(marker)) ||
          EXECUTES_VIA_ARGV.test(source)
        );
      })
      .map((path) => relative(SRC_ROOT, path));
    expect(guarded).toContain(join("host", "__tests__", "update-run.test.ts"));
    expect(guarded).toContain(
      join("commands", "__tests__", "host-update-dispatch-ack-guard.test.ts"),
    );
    // ...and the argv caller, which neither of the two function markers sees.
    expect(guarded).toContain(
      join("commands", "__tests__", "cli-entrypoint-registration.test.ts"),
    );
  });
});
