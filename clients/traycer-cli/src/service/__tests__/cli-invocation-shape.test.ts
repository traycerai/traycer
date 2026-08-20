import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSelfNamingCliInvocation } from "../cli-invocation-shape";

// `isSelfNamingCliInvocation` recognizes the pre-fix packaged fallback's
// broken vector - `<SEA> traycer host start`, `<SEA> /usr/local/bin/traycer
// host start`, `<SEA> ./traycer host start` - so callers that would
// otherwise preserve an existing registration verbatim can re-resolve
// instead. See the doc comment on the function under test for the full
// rationale; these cases pin the shape it must (and must not) recognize.
//
// Several cases need REAL files: the predicate preserves only what it can
// positively verify is an interpreter registration, which means comparing
// filesystem identity rather than path strings.
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "traycer-cli-invocation-shape-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("isSelfNamingCliInvocation", () => {
  it("is true for a bare command-name leading arg matching the command's basename", async () => {
    await expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["traycer"],
      }),
    ).resolves.toBe(true);
  });

  it("is true when the leading arg IS the command's own absolute path", async () => {
    await expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["/usr/local/bin/traycer"],
      }),
    ).resolves.toBe(true);
  });

  it("is true for a relative './traycer' leading arg naming the same command", async () => {
    await expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["./traycer"],
      }),
    ).resolves.toBe(true);
  });

  // The symlink-alias cohort: `process.execPath` reports the RESOLVED
  // binary while `argv[1]` keeps the raw spelling, so a CLI reached through
  // a differently named symlink registers a pair that is neither
  // path-equal nor basename-equal. Only filesystem identity catches it.
  // Skipped on Windows, where creating a symlink needs Developer Mode or an
  // elevated prompt: `symlinkSync` would throw before the predicate under
  // test ever ran, so a Windows developer would see a failure that says
  // nothing about `isSelfNamingCliInvocation`. Same guard the sibling
  // well-known-cli suite uses for its POSIX-mode cases.
  it.skipIf(process.platform === "win32")(
    "is true when the leading arg is a differently named symlink to the command",
    async () => {
      const realBinary = join(work, "traycer");
      const alias = join(work, "tr");
      writeFileSync(realBinary, "binary bytes");
      symlinkSync(realBinary, alias);

      await expect(
        isSelfNamingCliInvocation({ command: realBinary, args: [alias] }),
      ).resolves.toBe(true);
    },
  );

  // A leading argument that is not a file under any interpretation cannot
  // be the entry script a real interpreter registration would name, so the
  // registration is not preservable regardless of which failure it is.
  it("is true when the leading arg does not exist on disk at all", async () => {
    await expect(
      isSelfNamingCliInvocation({
        command: "/usr/bin/node",
        args: [join(work, "missing-entry.js")],
      }),
    ).resolves.toBe(true);
  });

  it("is false for an empty args list", async () => {
    await expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: [],
      }),
    ).resolves.toBe(false);
  });

  it("is false for a legitimate interpreter registration naming a different existing entry file", async () => {
    const entry = join(work, "index.js");
    writeFileSync(entry, "console.log('entry');");

    await expect(
      isSelfNamingCliInvocation({ command: "/usr/bin/node", args: [entry] }),
    ).resolves.toBe(false);
  });

  it("is false when there are two or more leading args, even if the first would self-name alone", async () => {
    await expect(
      isSelfNamingCliInvocation({
        command: "/usr/local/bin/traycer",
        args: ["traycer", "start"],
      }),
    ).resolves.toBe(false);
  });
});
