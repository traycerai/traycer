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

/**
 * Evaluates the nonce-read expression the launcher emits, with VBScript's
 * semantics for the pieces it uses: nested `Trim(...)` / `Replace(s, a, b)`
 * calls over string literals, the `vbCr` / `vbLf` constants, and the probe's
 * `nonceProbe.StdOut.ReadAll`, which is bound to `probeStdout`. The one
 * semantic that matters is pinned rather than assumed: VBScript `Trim`
 * strips SPACES only - not CR, not LF - which is exactly why `Trim` alone
 * never yielded a nonce the pattern accepted.
 */
function evaluateVbsStringExpression(
  expression: string,
  probeStdout: string,
): string {
  let index = 0;
  const peek = (): string => expression[index] ?? "";
  const skipSpaces = (): void => {
    while (peek() === " ") index += 1;
  };
  const parse = (): string => {
    skipSpaces();
    if (peek() === '"') {
      const start = index;
      index += 1;
      while (index < expression.length) {
        if (expression[index] === '"') {
          if (expression[index + 1] === '"') {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      return decodeVbsStringLiteral(expression.slice(start, index));
    }
    const start = index;
    while (/[A-Za-z0-9_.]/.test(peek())) index += 1;
    const name = expression.slice(start, index);
    skipSpaces();
    if (peek() !== "(") {
      if (name === "vbCr") return "\r";
      if (name === "vbLf") return "\n";
      if (name === "nonceProbe.StdOut.ReadAll") return probeStdout;
      throw new Error(`unknown VBScript identifier: ${name}`);
    }
    index += 1;
    const args: string[] = [];
    for (;;) {
      args.push(parse());
      skipSpaces();
      if (peek() === ",") {
        index += 1;
        continue;
      }
      if (peek() === ")") {
        index += 1;
        break;
      }
      throw new Error(`unterminated call in: ${expression}`);
    }
    if (name === "Trim" && args.length === 1) {
      return (args[0] ?? "").replace(/^ +/, "").replace(/ +$/, "");
    }
    if (name === "Replace" && args.length === 3) {
      const [subject, find, replacement] = args;
      return (subject ?? "").split(find ?? "").join(replacement ?? "");
    }
    throw new Error(`unsupported VBScript call: ${name}/${args.length}`);
  };
  const value = parse();
  skipSpaces();
  if (index !== expression.length) {
    throw new Error(`trailing input in: ${expression}`);
  }
  return value;
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
    // Three assignments: the unlabelled default, the nonce-bearing current
    // path, and the labelled/no-nonce compatibility fallback.
    expect(labelled).toHaveLength(3);
    expect(labelled[1]).toContain("--adoption-nonce");
    expect(labelled[2]).toContain("--service-label");
    const inner = labelled[2] ?? "";
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
    expect(script).toContain("adoption-nonce");
    expect(script).toContain("noncePattern.Pattern");
  });

  it("still passes the nonce to the pattern when the probe's stdout ends in LF or CRLF", () => {
    // `traycer host adoption-nonce` writes `${nonce}\n`. VBScript `Trim`
    // removes spaces only, and `noncePattern` is anchored with `$` on a
    // single-line RegExp, which does not match before a trailing LF - so a
    // `Trim(...)`-only read failed the pattern on EVERY launch and the task
    // started the host without `--adoption-nonce`; the supervisor then
    // refused the pending grant until it aged out (~60 s) and every
    // task-managed start reported failure while the host came up late.
    // Falsification recipe (this file cannot run cscript): on Windows,
    // `cscript //nologo t.vbs` with
    //   s = "0f6c1b2e-8a44-4d19-9c3e-5b7a0d21f8ac" & vbLf
    //   Set r = New RegExp : r.Pattern = "^[0-9A-Fa-f-]{36}$"
    //   WScript.Echo Len(Trim(s)) & " " & r.Test(Trim(s))
    // prints `37 False`; with the Replace pair it prints `36 True`
    // (observed 2026-09-06 on Windows 11 26200).
    const script = buildWindowsHiddenHostLauncher(cli, serviceLabel);
    const readLine = script
      .split("\r\n")
      .map((line) => line.trim())
      .find((line) => line.includes("nonceProbe.StdOut.ReadAll"));
    const prefix = "If nonceProbe.ExitCode = 0 Then adoptionNonce = ";
    expect(readLine?.startsWith(prefix)).toBe(true);
    const expression = (readLine ?? "").slice(prefix.length);
    // A JS RegExp without the `m` flag and a VBScript RegExp without
    // `Multiline` agree on `$`: only the very end of the string, never before
    // a trailing LF. The pattern is taken from the script, not restated.
    const pattern = new RegExp(
      decodeVbsStringLiteral(
        assignmentLiteral(script, "noncePattern.Pattern ="),
      ),
    );
    expect(script).not.toContain("noncePattern.Multiline");
    const nonce = "0f6c1b2e-8a44-4d19-9c3e-5b7a0d21f8ac";
    for (const stdout of [
      `${nonce}\n`,
      `${nonce}\r\n`,
      `${nonce} \r\n`,
      nonce,
    ]) {
      expect(
        pattern.test(evaluateVbsStringExpression(expression, stdout)),
      ).toBe(true);
    }
    // Control for the evaluator: with the pre-fix expression the same input
    // must FAIL the same pattern, or `Trim` above would be stripping the
    // newline and this test would be passing for the wrong reason.
    expect(
      pattern.test(
        evaluateVbsStringExpression(
          "Trim(nonceProbe.StdOut.ReadAll)",
          `${nonce}\n`,
        ),
      ),
    ).toBe(false);
    // The strip must not widen what the pattern accepts.
    expect(
      pattern.test(evaluateVbsStringExpression(expression, "not a nonce\n")),
    ).toBe(false);
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
