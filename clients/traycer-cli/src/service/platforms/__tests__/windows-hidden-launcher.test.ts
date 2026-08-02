import { describe, expect, it, vi } from "vitest";

import { buildWindowsHiddenHostLauncher } from "../windows";
import type { ServiceLabel } from "../../label";

vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: vi.fn(),
  removeHostPidMetadata: vi.fn(),
}));

/**
 * The Windows Scheduled Task launcher, decoded the way Windows decodes it.
 *
 * WHAT THIS FILE CANNOT DO: it never runs `cscript`. Darwin has no Windows
 * Script Host, so the VBScript is not executed anywhere in CI or here, and no
 * claim below should be read as "this ran on Windows". What it DOES do is
 * execute the two decode steps the OS performs before any process starts -
 * VBScript string-literal un-doubling, then `CommandLineToArgvW` - and assert
 * the resulting argv exactly. That is the layer the blocker lived in.
 *
 * The blocker: the capability probe used to be a `cmd.exe /d /s /c` line
 * quoted with `quoteWindowsArg`, i.e. MSVCRT argv rules (`"` -> `\"`).
 * cmd.exe does not honour `\"`; it saw a leading literal backslash, could not
 * resolve the command token, and returned non-zero. The `If` was therefore
 * always false and the task started the host UNLABELLED at every login,
 * permanently and silently. The fix drops cmd.exe entirely - `shell.Run`
 * takes CreateProcess argv rules, the same dialect as the line beside it.
 */

/**
 * VBScript string literal -> the string the interpreter yields. The only
 * escape inside a `"..."` literal is a doubled quote.
 */
function decodeVbsStringLiteral(literal: string): string {
  if (!literal.startsWith('"') || !literal.endsWith('"')) {
    throw new Error(`not a VBScript string literal: ${literal}`);
  }
  const body = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? "";
    if (ch === '"') {
      if (body[i + 1] !== '"') {
        throw new Error(`unescaped quote inside VBScript literal: ${literal}`);
      }
      out += '"';
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Reference `CommandLineToArgvW`, post-argv[0]. Rules, per Microsoft's
 * "Parsing C++ Command-Line Arguments":
 *   - a run of `2n` backslashes before `"` -> `n` backslashes, quote toggles;
 *   - a run of `2n+1` backslashes before `"` -> `n` backslashes + a literal
 *     `"`, quote does not toggle;
 *   - backslashes not followed by `"` are literal;
 *   - unquoted whitespace separates arguments.
 * Pinned against the documented examples in the first test below, so a bug
 * in this decoder cannot quietly agree with a bug in the emitter.
 */
function commandLineToArgv(commandLine: string): readonly string[] {
  const argv: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;
  let backslashes = 0;

  const flushBackslashes = (count: number): void => {
    current += "\\".repeat(count);
  };

  for (const ch of commandLine) {
    if (ch === "\\") {
      backslashes += 1;
      started = true;
      continue;
    }
    if (ch === '"') {
      flushBackslashes(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) {
        current += '"';
      } else {
        inQuotes = !inQuotes;
      }
      backslashes = 0;
      started = true;
      continue;
    }
    flushBackslashes(backslashes);
    backslashes = 0;
    if ((ch === " " || ch === "\t") && !inQuotes) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  flushBackslashes(backslashes);
  if (started) argv.push(current);
  return argv;
}

function label(id: string): ServiceLabel {
  return {
    id,
    displayName: "Traycer Host",
    environment: "production",
    devSlot: null,
  };
}

/** The RHS of `<name> = <vbs-string-literal>` in the emitted script. */
function assignmentLiteral(script: string, statement: string): string {
  const line = script
    .split("\r\n")
    .find((candidate) => candidate.trimStart().startsWith(statement));
  if (line === undefined) {
    throw new Error(`no statement starting with ${statement}:\n${script}`);
  }
  return line.slice(line.indexOf("=") + 1).trim();
}

/** The single argument of the `shell.Run(<literal>, 0, True)` call in `line`. */
function shellRunLiteral(script: string, marker: string): string {
  const line = script
    .split("\r\n")
    .find((candidate) => candidate.includes(marker));
  if (line === undefined) {
    throw new Error(`no line containing ${marker}:\n${script}`);
  }
  const open = line.indexOf("shell.Run(");
  const literal = line.slice(open + "shell.Run(".length);
  const end = literal.lastIndexOf(", 0, True)");
  if (end < 0) throw new Error(`malformed shell.Run call: ${line}`);
  return literal.slice(0, end);
}

describe("reference CommandLineToArgvW", () => {
  // Microsoft's own documented examples. If these drift, every assertion in
  // this file is worthless, so they are checked first.
  it.each([
    ['"a b c" d e', ["a b c", "d", "e"]],
    ['"ab\\"c" "\\\\" d', ['ab"c', "\\", "d"]],
    ['a\\\\\\b d"e f"g h', ["a\\\\\\b", "de fg", "h"]],
    ['a\\\\\\"b c d', ['a\\"b', "c", "d"]],
    ['a\\\\\\\\"b c" d e', ["a\\\\b c", "d", "e"]],
  ])("parses %s", (commandLine, expected) => {
    expect(commandLineToArgv(commandLine)).toEqual(expected);
  });
});

describe("Windows hidden host launcher — decoded as Windows decodes it", () => {
  const cli = {
    command: "C:\\Users\\Traycer Dev\\.traycer\\cli\\bin\\traycer.exe",
    args: [],
  };
  const serviceLabel = label("ai.traycer.host.prod");

  it("hands the capability probe an argv Windows can actually resolve", () => {
    const script = buildWindowsHiddenHostLauncher(cli, serviceLabel);
    const probe = commandLineToArgv(
      decodeVbsStringLiteral(shellRunLiteral(script, "probeStatus =")),
    );

    // The regression: this used to decode to
    // ["cmd.exe","/d","/s","/c", '\\"C:\\Users\\...\\traycer.exe\\" ...'],
    // whose leading literal backslash cmd.exe could not resolve.
    expect(probe).toEqual([
      "C:\\Users\\Traycer Dev\\.traycer\\cli\\bin\\traycer.exe",
      "host",
      "capabilities",
      "--has",
      "service-label",
    ]);
  });

  it("no longer shells through cmd.exe or findstr for the probe", () => {
    const script = buildWindowsHiddenHostLauncher(cli, serviceLabel);
    expect(script).not.toContain("cmd.exe");
    expect(script).not.toContain("findstr");
    expect(script).not.toContain("--help");
  });

  it("decodes the unlabelled start line to the exact argv", () => {
    const script = buildWindowsHiddenHostLauncher(cli, serviceLabel);
    expect(
      commandLineToArgv(
        decodeVbsStringLiteral(assignmentLiteral(script, "commandLine =")),
      ),
    ).toEqual([
      "C:\\Users\\Traycer Dev\\.traycer\\cli\\bin\\traycer.exe",
      "host",
      "start",
    ]);
  });

  it("decodes the labelled start line to the exact argv, including leading invocation args", () => {
    const script = buildWindowsHiddenHostLauncher(
      {
        command: "C:\\Program Files\\Traycer\\traycer.exe",
        args: ["--entry=cli-entry.js"],
      },
      serviceLabel,
    );
    const labelled = script
      .split("\r\n")
      .filter((line) => line.trimStart().startsWith("commandLine ="));
    // Two assignments: the default and the one inside the `If`.
    expect(labelled).toHaveLength(2);
    const inner = labelled[1] ?? "";
    expect(
      commandLineToArgv(
        decodeVbsStringLiteral(inner.slice(inner.indexOf("=") + 1).trim()),
      ),
    ).toEqual([
      "C:\\Program Files\\Traycer\\traycer.exe",
      "--entry=cli-entry.js",
      "host",
      "start",
      "--service-label",
      "ai.traycer.host.prod",
    ]);
  });

  it("degrades to the unlabelled start when the probe cannot even be launched", () => {
    const script = buildWindowsHiddenHostLauncher(cli, serviceLabel);
    // `Option Explicit` with no handler makes a `shell.Run` failure a fatal
    // runtime error, which would abort the script BEFORE the fallback start.
    // The probe is therefore wrapped, and any error forced to a non-zero
    // status so the fallback is what runs.
    const lines = script.split("\r\n");
    const guardStart = lines.indexOf("On Error Resume Next");
    const probeLine = lines.findIndex((line) =>
      line.startsWith("probeStatus ="),
    );
    const guardEnd = lines.indexOf("On Error Goto 0");
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(probeLine).toBeGreaterThan(guardStart);
    expect(guardEnd).toBeGreaterThan(probeLine);
    expect(lines).toContain("If Err.Number <> 0 Then probeStatus = 1");
    // The unlabelled default is assigned before the probe ever runs, so the
    // fallback holds no matter how the probe fails.
    expect(
      lines.findIndex((line) => line.startsWith("commandLine =")),
    ).toBeLessThan(guardStart);
  });

  it("emits CRLF-terminated VBScript with a trailing newline", () => {
    const script = buildWindowsHiddenHostLauncher(cli, serviceLabel);
    expect(script.startsWith("Option Explicit\r\n")).toBe(true);
    expect(script.endsWith("WScript.Quit exitCode\r\n")).toBe(true);
    expect(script).not.toMatch(/[^\r]\n/);
  });

  it("declares every variable it assigns, so Option Explicit cannot reject the script", () => {
    const script = buildWindowsHiddenHostLauncher(cli, serviceLabel);
    const lines = script.split("\r\n");
    const declared = new Set(
      lines
        .filter((line) => line.startsWith("Dim "))
        .map((line) => line.slice("Dim ".length).trim()),
    );
    const assigned = lines
      .map((line) => /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(line.trimStart()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
      // `Set shell = ...` declares via the Dim above; `If ... Then x = 1` is
      // matched separately below.
      .filter((name) => name !== "Set");
    for (const name of assigned) {
      expect(declared).toContain(name);
    }
    expect(declared).toContain("probeStatus");
  });
});
