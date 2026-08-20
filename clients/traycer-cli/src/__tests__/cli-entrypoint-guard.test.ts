import { describe, expect, it } from "vitest";
import {
  argvSelectsSupervisedHostStart,
  isTraycerCliEntrypoint,
} from "../index";

// Native-packaging fixup: the script-entry guard at the bottom of
// `traycer-cli/src/index.ts` is what gates the auto `parseAsync` so
// `import { buildProgram }` from a test never triggers commander
// against `process.argv`. Before this fixup the regex only matched
// `traycer` (no extension) so a Windows SEA binary
// (`bun build --compile --target=bun-windows-x64` → `traycer.exe`)
// was treated as "this module was imported, do nothing" and the CLI
// silently no-op'd in production.
//
// These tests pin the matrix that the script-entry guard cares about:
// POSIX dev path, POSIX prod path, Windows prod path (`traycer.exe`),
// plus the negative cases (undefined / unrelated paths) so importing
// the module from tests stays safe.

describe("isTraycerCliEntrypoint", () => {
  it("accepts the tsx dev path (POSIX)", () => {
    expect(
      isTraycerCliEntrypoint("/repo/clients/traycer-cli/src/index.ts"),
    ).toBe(true);
  });

  it("accepts the tsx dev path (Windows backslashes)", () => {
    expect(
      isTraycerCliEntrypoint(
        "C:\\repo\\traycer-clients\\traycer-cli\\src\\index.ts",
      ),
    ).toBe(true);
  });

  it("accepts the compiled SEA binary on POSIX", () => {
    expect(isTraycerCliEntrypoint("/usr/local/bin/traycer")).toBe(true);
    expect(
      isTraycerCliEntrypoint(
        "/Applications/Traycer.app/Contents/Resources/cli/traycer",
      ),
    ).toBe(true);
  });

  it("accepts the compiled SEA binary on Windows (traycer.exe)", () => {
    // The actual argv[1] the Electron main process feeds into the
    // packaged Windows shell: `<resourcesPath>\cli\traycer.exe`.
    expect(
      isTraycerCliEntrypoint(
        "C:\\Program Files\\Traycer\\resources\\cli\\traycer.exe",
      ),
    ).toBe(true);
    // Forward-slash variant (some Windows toolchains normalise to /).
    expect(
      isTraycerCliEntrypoint("C:/Program Files/Traycer/cli/traycer.exe"),
    ).toBe(true);
    // Bare basename.
    expect(isTraycerCliEntrypoint("traycer.exe")).toBe(true);
    // Case-insensitive - Windows filesystems are case-preserving but
    // not case-sensitive, and PowerShell / cmd may upcase the suffix.
    expect(isTraycerCliEntrypoint("C:\\bin\\Traycer.EXE")).toBe(true);
  });

  it("rejects undefined / empty argv[1] so importing the module is safe", () => {
    expect(isTraycerCliEntrypoint(undefined)).toBe(false);
    expect(isTraycerCliEntrypoint("")).toBe(false);
  });

  it("rejects unrelated executables and substring near-matches", () => {
    expect(isTraycerCliEntrypoint("/usr/local/bin/node")).toBe(false);
    expect(isTraycerCliEntrypoint("/repo/node_modules/.bin/vitest")).toBe(
      false,
    );
    // Substring match guard: a path that *contains* "traycer" but the
    // basename is something else (e.g. a wrapper) should not match.
    expect(isTraycerCliEntrypoint("/repo/clients/cli/wrapper.sh")).toBe(false);
    // `.exe` on a non-traycer binary must not match either.
    expect(isTraycerCliEntrypoint("C:\\bin\\not-traycer.exe")).toBe(false);
  });
});

// `argvSelectsSupervisedHostStart` gates the long-lived supervised entry
// (`traycer host start`, invoked by launchd / systemd-user / the Windows
// Scheduled Task) against a Node-style argv. It shares the same "drop the
// `--` tail, filter out option tokens, read the command path" rule as
// `rewriteHostUpdateVersion`'s host-update rewrite - pinned here by unit
// test rather than by spawning a subprocess.
describe("argvSelectsSupervisedHostStart", () => {
  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly argv: readonly string[];
    readonly expected: boolean;
  }> = [
    {
      name: "bare `host start`",
      argv: ["node", "/x/traycer", "host", "start"],
      expected: true,
    },
    {
      name: "a leading global option before the command path",
      argv: ["node", "/x/traycer", "--json", "host", "start"],
      expected: true,
    },
    {
      name: "a different host subcommand",
      argv: ["node", "/x/traycer", "host", "status"],
      expected: false,
    },
    {
      name: "`host` with no subcommand",
      argv: ["node", "/x/traycer", "host"],
      expected: false,
    },
    {
      name: "no command at all",
      argv: ["node", "/x/traycer"],
      expected: false,
    },
    {
      name: "`host start` entirely after the `--` separator",
      argv: ["node", "/x/traycer", "--", "host", "start"],
      expected: false,
    },
    {
      name: "`host start` is not the first two command tokens",
      argv: ["node", "/x/traycer", "agent", "host", "start"],
      expected: false,
    },
  ];

  it.each(CASES)("$name -> $expected", ({ argv, expected }) => {
    expect(argvSelectsSupervisedHostStart(argv)).toBe(expected);
  });
});
