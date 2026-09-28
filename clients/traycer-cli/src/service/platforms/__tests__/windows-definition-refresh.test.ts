import { mkdtempSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cliInvocationRecordPath,
  parseCliInvocationRecord,
} from "@traycer/protocol/config/cli-invocation-record";

// `resolveServiceCliInvocation`'s real staging path
// (`stageWellKnownCliBinary`) reaches `ensureCliInstallHomeDir`, whose body
// - defined INSIDE the real `store/paths` module - calls that module's OWN
// internal `cliInstallHomeDir`, not the override the mock factory below
// installs for external importers. A plain ESM closure reference is not
// rerouted by `vi.mock`, so that internal call would otherwise resolve
// through the REAL `os.homedir()` and create a directory under this
// worktree's actual `~/.traycer`. Redirecting `homedir()` itself closes that
// gap for every caller, mocked-export or not.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: mkdtempSyncForHome } = await import("node:fs");
  const { join: joinForHome } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSyncForHome(
      joinForHome(
        actual.tmpdir(),
        "traycer-windows-definition-refresh-os-home-",
      ),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

// Test isolation: `cliInstallHomeDir`/`hostHomeDir` normally resolve through
// the real `os.homedir()`. `hostHomeDir` in particular is the invocation
// record's home (`cli-invocation.json`) - unlike `windows.test.ts` (which
// only redirects `cliInstallHomeDir`, because none of ITS tests reach the
// record transaction), this file's record tests DO reach it, so BOTH are
// redirected into a private temp root: this worktree's real
// `~/.traycer/host/...` is a live host's actual runtime home and must never
// be written by a test.
const TEST_STORE_ROOT = mkdtempSync(
  join(tmpdir(), "traycer-windows-definition-refresh-store-"),
);
vi.mock("../../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) =>
      join(TEST_STORE_ROOT, "cli-install", environment),
    hostHomeDir: (environment: string | undefined) =>
      join(TEST_STORE_ROOT, "host-home", environment ?? "shared"),
  };
});

// `runCommandForBytes` is the seam ONLY the decode-coverage describe block
// below uses (by leaving `queryTaskXml` at its default so the real
// `queryScheduledTaskXml` decodes real bytes). Every other test in this file
// overrides `queryTaskXml` via `setWindowsDefinitionDepsForTests` and never
// reaches this mock at all.
const runCommandForBytesMock = vi.hoisted(() => ({
  impl: null as
    | ((
        command: string,
        args: readonly string[],
      ) => Promise<{
        stdout: Buffer;
        exitCode: number;
        stderr: string;
      }>)
    | null,
}));
vi.mock("../../process-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process-runner")>();
  return {
    ...actual,
    runCommandForBytes: async (command: string, args: readonly string[]) => {
      if (runCommandForBytesMock.impl === null) {
        throw new Error(
          "runCommandForBytes called without a configured mock impl",
        );
      }
      return runCommandForBytesMock.impl(command, args);
    },
  };
});

afterAll(async () => {
  await rm(TEST_STORE_ROOT, { recursive: true, force: true });
  if (osHome.current !== "") {
    await rm(osHome.current, { recursive: true, force: true });
  }
});

import {
  buildScheduledTaskXml,
  buildWindowsHiddenHostLauncher,
  inspectWindowsServiceDefinition,
  refreshWindowsServiceDefinition,
  setWindowsDefinitionDepsForTests,
  type ProcessRunner,
} from "../windows";
import { windowsTaskName, type ServiceLabel } from "../../label";
import {
  cliInstallHomeDir,
  cliManifestPath,
  hostHomeDir,
} from "../../../store/paths";
import { wellKnownCliBinaryPath } from "../../../store/well-known-cli";
import type { CliInvocation } from "../../cli-binary";

/**
 * `refreshWindowsServiceDefinition` / `inspectWindowsServiceDefinition`:
 * rewrite the hidden VBS launcher and, only when the task's ACTION
 * itself predates the launcher (`redefineTask`), redefine the task with
 * `schtasks /Create ... /F` - never `/Run`, `/End`, `/Change`, `/Delete` or
 * `taskkill`.
 *
 * W1 = the launcher-less generation where the CLI itself is the task's
 * `<Exec>` action ("direct-action"). W2 = the task action already runs the
 * wscript launcher, but the launcher FILE's content is stale
 * ("launcher-vbs"). Both fixtures go through
 * `setWindowsDefinitionDepsForTests` to fully control `queryTaskXml` /
 * `resolveCli`, the same seam `windows.test.ts` uses for install/start deps.
 */

function labelFor(id: string): ServiceLabel {
  return {
    id,
    displayName: "Traycer Host (test)",
    // Unique per test, not just "dev": `hostHomeDir`/`cliInstallHomeDir` are
    // keyed by environment, and the invocation-record state directory
    // (`ensureCliInvocationStateDir`) is created 0700 on FIRST use and
    // rejected as unsafe if a later run finds it already there with a
    // looser mode - sharing one environment across tests in this file
    // races exactly that check.
    environment: id,
    devSlot: null,
  };
}

// The `<UserId>` this file's fixture XML carries. The builder takes it from
// its caller (the install resolves it in front of its install edge;
// `windows-task-user-id.test.ts` covers that resolution), and no refresh here
// resolves one, so a constant is the whole identity this file needs.
const TEST_TASK_USER_ID = "traycer-test-user";

const DIRECT_CLI_COMMAND = "C:\\Program Files\\Traycer\\traycer.exe";
// `[...cli.args, "host", "start"].map(quoteWindowsArg).join(" ")` for
// `cli.args: []` - each token individually double-quoted.
const DIRECT_ARGUMENTS_LINE = '"host" "start"';

function launcherVbsPath(label: ServiceLabel): string {
  return join(cliInstallHomeDir(label.environment), "host-start-hidden.vbs");
}

/** A minimal, valid single-`<Exec>` Scheduled Task XML - `parseTaskExecAction`
 * only ever looks at the `<Exec>` block, so nothing else needs to be real. */
function execTaskXml(command: string, argumentsLine: string): string {
  const escapedCommand = command.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const escapedArgs = argumentsLine
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author">
    <Exec>
      <Command>${escapedCommand}</Command>
      <Arguments>${escapedArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// Exact copies of windows.ts's private `quoteWindowsArg`/`quoteVbsString` -
// needed only to CONSTRUCT a byte-accurate "old launcher" fixture whose
// `commandLine = <literal>` line `launcherRunsInvocation` (also private)
// recognises. Fixture construction, not a re-test of production's own
// quoting - the W1/current mechanism tests below independently compare
// against `buildWindowsHiddenHostLauncher`'s OWN output, not this copy.
function testQuoteWindowsArg(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}
function testQuoteVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** The pre-current "run-only" VBS launcher generation the code comment in
 * `launcherRunsInvocation` names: just `commandLine = <literal>` then
 * `shell.Run`, no capability probe, no adoption-nonce dance. */
function oldRunOnlyLauncherBody(cli: CliInvocation): string {
  const commandLine = [cli.command, ...cli.args, "host", "start"]
    .map(testQuoteWindowsArg)
    .join(" ");
  const literal = testQuoteVbsString(commandLine);
  return [
    "Option Explicit",
    "Dim shell",
    "Dim exitCode",
    "Dim commandLine",
    'Set shell = CreateObject("WScript.Shell")',
    `commandLine = ${literal}`,
    "exitCode = shell.Run(commandLine, 0, True)",
    "WScript.Quit exitCode",
    "",
  ].join("\r\n");
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** Records every call, and - because the temp task.xml `refresh` writes is
 * deleted in a `finally` before the call returns - captures that XML's
 * decoded text (minus its BOM) the moment a `/XML <path>` call is seen, the
 * only window it is still on disk. */
function recordingRunner(
  calls: RecordedCall[],
  xmlCapture: { text: string | null },
): ProcessRunner {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    const xmlIndex = args.indexOf("/XML");
    if (xmlIndex !== -1) {
      const xmlPath = args[xmlIndex + 1];
      if (xmlPath !== undefined) {
        const bytes = await readFile(xmlPath);
        xmlCapture.text = bytes.toString("utf16le").replace(/^\ufeff/, "");
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function currentVbsBytes(cli: CliInvocation, label: ServiceLabel): Buffer {
  return Buffer.from(
    `\ufeff${buildWindowsHiddenHostLauncher(cli, label)}`,
    "utf16le",
  );
}

afterEach(() => {
  setWindowsDefinitionDepsForTests(null);
  runCommandForBytesMock.impl = null;
});

describe("W1: the CLI itself is the task action (direct-action, launcher-less)", () => {
  it("stale{direct-action, next-start}; refresh writes the VBS (UTF-16LE+BOM, === buildWindowsHiddenHostLauncher); exactly one schtasks /Create with [/Create,/TN,<task>,/XML,<path>,/F]; none of /Run,/End,/Change,/Delete,taskkill", async () => {
    const label = labelFor("w1-direct-action");
    const resolvedCli: CliInvocation = {
      command: DIRECT_CLI_COMMAND,
      args: [],
    };
    const queriedXml = execTaskXml(DIRECT_CLI_COMMAND, DIRECT_ARGUMENTS_LINE);
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: queriedXml,
      }),
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({
      kind: "stale",
      form: "direct-action",
      appliesAt: "next-start",
    });

    const calls: RecordedCall[] = [];
    const xmlCapture = { text: null as string | null };
    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner(calls, xmlCapture),
    );

    expect(result).toEqual({
      kind: "refreshed",
      form: "direct-action",
      appliesAt: "next-start",
    });

    const newVbs = await readFile(launcherVbsPath(label));
    expect(newVbs.equals(currentVbsBytes(resolvedCli, label))).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.command).toBe("schtasks");
    expect(call.args[0]).toBe("/Create");
    expect(call.args[1]).toBe("/TN");
    expect(call.args[2]).toBe(windowsTaskName(label));
    expect(call.args[3]).toBe("/XML");
    expect(typeof call.args[4]).toBe("string");
    expect(call.args[5]).toBe("/F");
    expect(call.args).toHaveLength(6);
    for (const forbidden of ["/Run", "/End", "/Change", "/Delete"]) {
      expect(call.args).not.toContain(forbidden);
    }
    expect(call.command).not.toBe("taskkill");

    // The registered task redefined, not replaced: its own XML with only the
    // `<Exec>` swapped for the launcher action. This row used to expect a
    // fresh `buildScheduledTaskXml` - the earlier defect, a refresh that dropped
    // whatever the registered task carried (`<Enabled>`, battery and other
    // user settings); the describe below pins those carrying over.
    const newExecBlock = buildScheduledTaskXml(
      { label, cli: resolvedCli },
      TEST_TASK_USER_ID,
    ).match(/<Exec>[\s\S]*?<\/Exec>/)?.[0];
    if (newExecBlock === undefined) throw new Error("unreachable");
    expect(xmlCapture.text).toBe(
      queriedXml.replace(/<Exec>[\s\S]*?<\/Exec>/, newExecBlock),
    );
  });
});

/** A minimal-but-full Scheduled Task XML with a direct-action `<Exec>` PLUS a
 * `<Settings>` block carrying values a fresh `buildScheduledTaskXml` would
 * never emit - the user-disabled task with battery customisations this suite
 * exists to preserve. */
function execTaskXmlWithSettings(
  command: string,
  argumentsLine: string,
): string {
  const escapedCommand = command.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const escapedArgs = argumentsLine
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Settings>
    <Enabled>false</Enabled>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapedCommand}</Command>
      <Arguments>${escapedArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

describe("refresh's /Create XML carries over the queried task's Settings, replacing only <Exec>", () => {
  it("W1 direct-action, task disabled + battery-customised: the written XML === the queried XML with only its <Exec> body replaced", async () => {
    const label = labelFor("f17-preserve-settings");
    const resolvedCli: CliInvocation = {
      command: DIRECT_CLI_COMMAND,
      args: [],
    };
    const queriedXml = execTaskXmlWithSettings(
      DIRECT_CLI_COMMAND,
      DIRECT_ARGUMENTS_LINE,
    );
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({ kind: "xml", xml: queriedXml }),
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({
      kind: "stale",
      form: "direct-action",
      appliesAt: "next-start",
    });

    const calls: RecordedCall[] = [];
    const xmlCapture = { text: null as string | null };
    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner(calls, xmlCapture),
    );
    expect(result).toEqual({
      kind: "refreshed",
      form: "direct-action",
      appliesAt: "next-start",
    });

    // The new `<Exec>` block, exactly as production's own emitter produces
    // it - not a re-implementation of its shape or quoting.
    const freshXml = buildScheduledTaskXml(
      { label, cli: resolvedCli },
      TEST_TASK_USER_ID,
    );
    const newExecBlock = freshXml.match(/<Exec>[\s\S]*?<\/Exec>/)?.[0];
    if (newExecBlock === undefined) throw new Error("unreachable");
    const expectedXml = queriedXml.replace(
      /<Exec>[\s\S]*?<\/Exec>/,
      newExecBlock,
    );

    expect(xmlCapture.text).toBe(expectedXml);
    expect(xmlCapture.text).toContain("<Enabled>false</Enabled>");
    expect(xmlCapture.text).toContain(
      "<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>",
    );
    expect(xmlCapture.text).toContain(
      "<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>",
    );
  });
});

describe("W2: the task action already runs the wscript launcher, but the launcher FILE is an old 'run-only' generation", () => {
  it("stale{launcher-vbs, next-start}; refresh rewrites ONLY the VBS, ZERO runner calls (the task action is already current)", async () => {
    const label = labelFor("w2-launcher-current-vbs-old");
    const resolvedCli: CliInvocation = {
      command: DIRECT_CLI_COMMAND,
      args: [],
    };
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: buildScheduledTaskXml(
          { label, cli: resolvedCli },
          TEST_TASK_USER_ID,
        ),
      }),
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });
    await mkdir(dirname(launcherVbsPath(label)), { recursive: true });
    await writeFile(
      launcherVbsPath(label),
      Buffer.from(`\ufeff${oldRunOnlyLauncherBody(resolvedCli)}`, "utf16le"),
    );

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({
      kind: "stale",
      form: "launcher-vbs",
      appliesAt: "next-start",
    });

    const calls: RecordedCall[] = [];
    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner(calls, { text: null }),
    );

    expect(result).toEqual({
      kind: "refreshed",
      form: "launcher-vbs",
      appliesAt: "next-start",
    });
    const newVbs = await readFile(launcherVbsPath(label));
    expect(newVbs.equals(currentVbsBytes(resolvedCli, label))).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("current: no writes, no runner calls", () => {
  it("a current task action + current VBS: zero runner calls, VBS bytes+mtime unchanged", async () => {
    const label = labelFor("w-current");
    const resolvedCli: CliInvocation = {
      command: DIRECT_CLI_COMMAND,
      args: [],
    };
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: buildScheduledTaskXml(
          { label, cli: resolvedCli },
          TEST_TASK_USER_ID,
        ),
      }),
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });
    await mkdir(dirname(launcherVbsPath(label)), { recursive: true });
    const bytes = currentVbsBytes(resolvedCli, label);
    await writeFile(launcherVbsPath(label), bytes);
    const before = await stat(launcherVbsPath(label));

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({ kind: "current" });

    const calls: RecordedCall[] = [];
    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner(calls, { text: null }),
    );

    expect(result).toEqual({ kind: "current" });
    expect(calls).toEqual([]);
    const after = await stat(launcherVbsPath(label));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await readFile(launcherVbsPath(label))).equals(bytes)).toBe(true);
  });
});

describe("not-registered and unrecognized", () => {
  it("queryTaskXml 'absent': not-registered, zero writes", async () => {
    const label = labelFor("w-not-registered");
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({ kind: "absent" }),
      predictCli: async () => {
        throw new Error("must not be called: no task means nothing to predict");
      },
      resolveCli: async () => {
        throw new Error("must not be called: no task means nothing to resolve");
      },
    });

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({ kind: "not-registered" });

    const calls: RecordedCall[] = [];
    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner(calls, { text: null }),
    );
    expect(result).toEqual({ kind: "not-registered" });
    expect(calls).toEqual([]);
  });

  it("an action that is not a Traycer host start: unrecognized; refresh throws naming 'traycer host service install', zero writes", async () => {
    const label = labelFor("w-unrecognized");
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: execTaskXml("C:\\Windows\\System32\\notepad.exe", "readme.txt"),
      }),
      predictCli: async () => {
        throw new Error("must not be called before the action is recognised");
      },
      resolveCli: async () => {
        throw new Error("must not be called before the action is recognised");
      },
    });

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({
      kind: "unrecognized",
      reason: "its action is not a Traycer host start",
    });

    const { CLI_ERROR_CODES, CliError } =
      await import("../../../runner/errors");
    const { SERVICE_REINSTALL_COMMAND } =
      await import("../../service-definition");
    const calls: RecordedCall[] = [];
    const error = await refreshWindowsServiceDefinition(
      label,
      recordingRunner(calls, { text: null }),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED);
    expect(error.message).toContain(SERVICE_REINSTALL_COMMAND);
    expect(calls).toEqual([]);
  });
});

describe("cli-invocation.json (the invocation record)", () => {
  it("when the resolved CLI is unchanged (invocationUnchanged): the record is byte-identical with an unchanged mtime after refresh - proof it was never opened", async () => {
    const label = labelFor("w-record-unchanged");
    const resolvedCli: CliInvocation = {
      command: DIRECT_CLI_COMMAND,
      args: [],
    };
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: execTaskXml(DIRECT_CLI_COMMAND, DIRECT_ARGUMENTS_LINE),
      }),
      predictCli: async () => resolvedCli,
      resolveCli: async () => resolvedCli,
    });
    const recordPath = cliInvocationRecordPath(hostHomeDir(label.environment));
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, "untouched-marker-not-a-real-record");
    const before = await stat(recordPath);

    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner([], { text: null }),
    );
    expect(result.kind).toBe("refreshed");

    const after = await stat(recordPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(recordPath, "utf8")).toBe(
      "untouched-marker-not-a-real-record",
    );
  });

  it("when the launcher would run a DIFFERENT CLI: the record is rewritten to the new CLI, through the real invocation-record transaction", async () => {
    const label = labelFor("w-record-rewritten");
    const oldCli: CliInvocation = { command: DIRECT_CLI_COMMAND, args: [] };
    // The invocation-record writer validates `command` for REAL - an
    // absolute path to an existing, executable regular file
    // (`buildValidatedRegistrationRecord`) - so a fake Windows-style path
    // (fine everywhere else in this file, which only round-trips it through
    // string emitters) is rejected here. Use a real standalone script on
    // THIS machine instead, the same fixture shape
    // `cli-invocation-record.test.ts`'s own `standaloneCliPath` uses, and
    // deliberately NOT node/bun-family (that would additionally require
    // `args` to be exactly one absolute script path).
    const standaloneCliDir = await mkdtemp(
      join(tmpdir(), "traycer-windows-definition-refresh-standalone-cli-"),
    );
    const standaloneCliPath = join(standaloneCliDir, "traycer-standalone");
    await writeFile(standaloneCliPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    if (process.platform !== "win32") await chmod(standaloneCliPath, 0o755);
    const newCli: CliInvocation = { command: standaloneCliPath, args: [] };
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({
        kind: "xml",
        xml: execTaskXml(oldCli.command, DIRECT_ARGUMENTS_LINE),
      }),
      predictCli: async () => newCli,
      resolveCli: async () => newCli,
    });

    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner([], { text: null }),
    );
    expect(result.kind).toBe("refreshed");

    const recordPath = cliInvocationRecordPath(hostHomeDir(label.environment));
    const raw: unknown = JSON.parse(await readFile(recordPath, "utf8"));
    const record = parseCliInvocationRecord(raw);
    expect(record).not.toBeNull();
    expect(record?.command).toBe(newCli.command);

    // The new launcher on disk also runs the new CLI, not the old one.
    const newVbs = await readFile(launcherVbsPath(label));
    expect(newVbs.equals(currentVbsBytes(newCli, label))).toBe(true);

    await rm(standaloneCliDir, { recursive: true, force: true });
  });
});

/** Recursively lists every regular file under `root` as
 * `"<relative path>:<byte length>:<base64 bytes>"`, sorted - a content
 * snapshot cheap enough to diff before/after a call that must not write
 * anything. Missing `root` snapshots as empty, not an error. */
async function snapshotFilesRecursively(
  root: string,
): Promise<readonly string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        const bytes = await readFile(full);
        out.push(`${rel}:${bytes.length}:${bytes.toString("base64")}`);
      }
    }
  }
  await walk(root, "");
  return [...out].sort();
}

/**
 * A CLI manifest naming a real, executable, non-slot binary
 * - so the REAL `resolveServiceCliInvocation` (deps left at their default via
 * `setWindowsDefinitionDepsForTests(null)`) has something to resolve - plus a
 * launcher file already current for the SLOT invocation staging would
 * produce. On the fix, planning predicts that same slot path without ever
 * calling `stageWellKnownCliBinary`; on head, staging runs during planning
 * and writes the slot for real.
 */
async function setupF15Fixture(
  label: ServiceLabel,
): Promise<{ readonly sourceDir: string }> {
  const sourceDir = await mkdtemp(
    join(tmpdir(), "traycer-f15-manifest-source-"),
  );
  const sourceBinaryPath = join(sourceDir, "traycer-source-binary");
  await writeFile(sourceBinaryPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  if (process.platform !== "win32") await chmod(sourceBinaryPath, 0o755);

  const manifest = {
    version: "1.0.0",
    installedAt: new Date(0).toISOString(),
    binaryPath: sourceBinaryPath,
    source: "manual",
    pendingUpgrade: null,
  };
  const manifestPath = cliManifestPath(label.environment);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));

  const predictedCli: CliInvocation = {
    command: wellKnownCliBinaryPath(label.environment),
    args: [],
  };
  await mkdir(dirname(launcherVbsPath(label)), { recursive: true });
  await writeFile(launcherVbsPath(label), currentVbsBytes(predictedCli, label));

  return { sourceDir };
}

describe("planning predicts the slot invocation without staging", () => {
  it("inspect: a current task action, predicted-current launcher -> {kind: 'current'} with NO filesystem writes (head stages the slot during planning)", async () => {
    const label = labelFor("f15-inspect-no-stage");
    setWindowsDefinitionDepsForTests(null);
    const { sourceDir } = await setupF15Fixture(label);
    const queriedXml = buildScheduledTaskXml(
      { label, cli: { command: DIRECT_CLI_COMMAND, args: [] } },
      TEST_TASK_USER_ID,
    );
    runCommandForBytesMock.impl = async () => ({
      stdout: Buffer.from(`﻿${queriedXml}`, "utf16le"),
      exitCode: 0,
      stderr: "",
    });

    const cliInstallHomeBefore = await snapshotFilesRecursively(
      cliInstallHomeDir(label.environment),
    );
    const hostHomeBefore = await snapshotFilesRecursively(
      hostHomeDir(label.environment),
    );

    const state = await inspectWindowsServiceDefinition(label);

    expect(state).toEqual({ kind: "current" });
    const slotPath = wellKnownCliBinaryPath(label.environment);
    await expect(stat(slotPath)).rejects.toThrow();
    expect(
      await snapshotFilesRecursively(cliInstallHomeDir(label.environment)),
    ).toEqual(cliInstallHomeBefore);
    expect(
      await snapshotFilesRecursively(hostHomeDir(label.environment)),
    ).toEqual(hostHomeBefore);

    await rm(sourceDir, { recursive: true, force: true });
  });

  it("refresh: same fixture -> {kind: 'current'}, zero runner calls, NO filesystem writes (head stages the slot during planning)", async () => {
    const label = labelFor("f15-refresh-no-stage");
    setWindowsDefinitionDepsForTests(null);
    const { sourceDir } = await setupF15Fixture(label);
    const queriedXml = buildScheduledTaskXml(
      { label, cli: { command: DIRECT_CLI_COMMAND, args: [] } },
      TEST_TASK_USER_ID,
    );
    runCommandForBytesMock.impl = async () => ({
      stdout: Buffer.from(`﻿${queriedXml}`, "utf16le"),
      exitCode: 0,
      stderr: "",
    });

    const cliInstallHomeBefore = await snapshotFilesRecursively(
      cliInstallHomeDir(label.environment),
    );
    const hostHomeBefore = await snapshotFilesRecursively(
      hostHomeDir(label.environment),
    );

    const calls: RecordedCall[] = [];
    const result = await refreshWindowsServiceDefinition(
      label,
      recordingRunner(calls, { text: null }),
    );

    expect(result).toEqual({ kind: "current" });
    expect(calls).toEqual([]);
    const slotPath = wellKnownCliBinaryPath(label.environment);
    await expect(stat(slotPath)).rejects.toThrow();
    expect(
      await snapshotFilesRecursively(cliInstallHomeDir(label.environment)),
    ).toEqual(cliInstallHomeBefore);
    expect(
      await snapshotFilesRecursively(hostHomeDir(label.environment)),
    ).toEqual(hostHomeBefore);

    await rm(sourceDir, { recursive: true, force: true });
  });
});

describe("schtasks /Query /XML decode (reachable without the queryTaskXml seam)", () => {
  const UNRECOGNIZED_XML = execTaskXml(
    "C:\\Windows\\System32\\notepad.exe",
    "readme.txt",
  );

  it.each([
    {
      name: "UTF-16LE with BOM",
      encode: (xml: string) => Buffer.from(`\ufeff${xml}`, "utf16le"),
    },
    {
      name: "UTF-16LE without BOM",
      encode: (xml: string) => Buffer.from(xml, "utf16le"),
    },
    { name: "UTF-8", encode: (xml: string) => Buffer.from(xml, "utf8") },
  ])(
    "$name decodes correctly - proven by reaching 'unrecognized' (a real parse), not a decode-failure 'failed'",
    async ({ encode }) => {
      const label = labelFor("w-decode");
      // Deliberately NOT calling setWindowsDefinitionDepsForTests: the
      // default deps' real `queryScheduledTaskXml` is what calls the mocked
      // `runCommandForBytes` and decodes its bytes.
      runCommandForBytesMock.impl = async () => ({
        stdout: encode(UNRECOGNIZED_XML),
        exitCode: 0,
        stderr: "",
      });

      const state = await inspectWindowsServiceDefinition(label);

      expect(state).toEqual({
        kind: "unrecognized",
        reason: "its action is not a Traycer host start",
      });
    },
  );

  // This row used to read EVERY non-zero exit as not-registered - the
  // defect: an access denial or any other `/Query` failure then passed for
  // "nothing to refresh". A non-zero exit is still never decoded, but only
  // stderr that names a missing task reads as not-registered (the
  // describe below); a silent failure names nothing, so it is reported.
  it("a non-zero schtasks exit with no stderr is not decoded, and is reported rather than read as not-registered", async () => {
    const label = labelFor("w-decode-nonzero-exit");
    runCommandForBytesMock.impl = async () => ({
      stdout: Buffer.alloc(0),
      exitCode: 1,
      stderr: "",
    });

    const state = await inspectWindowsServiceDefinition(label);

    expect(state).toEqual({
      kind: "unrecognized",
      reason: "schtasks /Query failed (exit 1)",
    });
  });
});

// A non-zero `schtasks /Query` exit should not ALWAYS mean "no such
// task" - an access denial is a real failure the refresh must surface, not
// silently swallow as "nothing to refresh". Only stderr that actually NAMES
// a missing task may still read as not-registered.
describe("schtasks /Query non-zero exit disambiguated by stderr", () => {
  it("access denied (exit 1): inspect is 'unrecognized' naming schtasks /Query, refresh rejects SERVICE_DEFINITION_REFRESH_FAILED - head misreads this as not-registered", async () => {
    const label = labelFor("w-f18-access-denied");
    runCommandForBytesMock.impl = async () => ({
      stdout: Buffer.alloc(0),
      exitCode: 1,
      stderr: "ERROR: Access is denied.\r\n",
    });

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({
      kind: "unrecognized",
      reason: expect.stringContaining("schtasks /Query"),
    });

    const { CLI_ERROR_CODES, CliError } =
      await import("../../../runner/errors");
    const error = await refreshWindowsServiceDefinition(
      label,
      recordingRunner([], { text: null }),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED);
  });

  it("control: 'cannot find the file specified' (exit 1) still reads as not-registered", async () => {
    const label = labelFor("w-f18-missing-task-control");
    runCommandForBytesMock.impl = async () => ({
      stdout: Buffer.alloc(0),
      exitCode: 1,
      stderr: "ERROR: The system cannot find the file specified.\r\n",
    });

    const state = await inspectWindowsServiceDefinition(label);
    expect(state).toEqual({ kind: "not-registered" });
  });
});
