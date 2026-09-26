import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Test isolation, same technique `macos.test.ts` already uses:
// `serviceManifestPath`/`serviceLauncherScriptPath` normally resolve through
// the real `os.homedir()` to the developer's actual
// `~/Library/LaunchAgents/<label>.plist` and
// `~/.traycer/service/<label>/traycer-host-start` - redirect both into
// private temp roots.
const TEST_LAUNCH_AGENTS_DIR = mkdtempSync(
  join(tmpdir(), "traycer-macos-definition-refresh-agents-"),
);
const TEST_LAUNCHER_ROOT = mkdtempSync(
  join(tmpdir(), "traycer-macos-definition-refresh-launcher-"),
);
vi.mock("../../label", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../label")>();
  return {
    ...actual,
    serviceManifestPath: (label: { readonly id: string }) =>
      join(TEST_LAUNCH_AGENTS_DIR, `${label.id}.plist`),
    serviceLauncherScriptPath: (label: { readonly id: string }) =>
      join(TEST_LAUNCHER_ROOT, label.id, "traycer-host-start"),
  };
});

// Zero `launchctl` is a hard M1 invariant for this whole file: wrap the real
// `runCommand` (the module every launchctl call in macos.ts goes through)
// with a recorder, so EVERY test below - not just the ones that assert it
// explicitly - would fail loudly if any refresh path ever called it.
const processRunnerCalls: RecordedCall[] = [];
vi.mock("../../process-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process-runner")>();
  return {
    ...actual,
    runCommand: async (command: string, args: readonly string[]) => {
      processRunnerCalls.push({ command, args: [...args] });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
});

afterAll(async () => {
  await rm(TEST_LAUNCH_AGENTS_DIR, { recursive: true, force: true });
  await rm(TEST_LAUNCHER_ROOT, { recursive: true, force: true });
});

import {
  buildLaunchAgentPlist,
  inspectMacosServiceDefinition,
  refreshMacosServiceDefinition,
} from "../macos";
import {
  buildCompatibleHostStartScript,
  buildHostStartLauncherScript,
  COMPATIBLE_HOST_START_SCRIPT_PREFIX,
  posixShellQuote,
} from "../host-start-script";
import { escapeXml, unescapeXml } from "../../escape-xml";
import { SERVICE_REINSTALL_COMMAND } from "../../service-definition";
import { CLI_ERROR_CODES, CliError } from "../../../runner/errors";
import type { ServiceLabel } from "../../label";
import type { CliInvocation } from "../../cli-binary";

/**
 * `refreshMacosServiceDefinition` / `inspectMacosServiceDefinition` (M1):
 * bring a stale LaunchAgent to the current launcher form with ZERO
 * `launchctl` calls (`process-runner.ts` is mocked module-wide above so
 * every test in this file is that assertion, not just the ones naming it).
 *
 * Fixtures:
 *  - "launcher-file, old body": the plist ALREADY points at the launcher
 *    file (today's registered form); only the launcher FILE's content is
 *    stale (the historical pre-adoption-nonce body, commit 6796b8cca).
 *  - M1 "direct": `ProgramArguments = [<cli>, "host", "start"]` - the
 *    original launcher-less registration.
 *  - M2 "inline": `ProgramArguments = ["/bin/sh", "-c", <script>, <cli>]` -
 *    the pre-launcher-file `/bin/sh -c` wrapper (same
 *    `COMPATIBLE_HOST_START_SCRIPT_PREFIX` as the historical Linux wrapper).
 */

function labelFor(id: string): ServiceLabel {
  return {
    id,
    displayName: "Traycer Host (test)",
    environment: "dev",
    devSlot: null,
  };
}

const CLI: CliInvocation = { command: "/usr/local/bin/traycer", args: [] };
const CUSTOM_PATH = "/custom/writer/path:/usr/bin:/bin";

function plistPath(label: ServiceLabel): string {
  return join(TEST_LAUNCH_AGENTS_DIR, `${label.id}.plist`);
}

function launcherPath(label: ServiceLabel): string {
  return join(TEST_LAUNCHER_ROOT, label.id, "traycer-host-start");
}

async function writePlist(
  label: ServiceLabel,
  text: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(plistPath(label)), { recursive: true });
  await writeFile(plistPath(label), text, "utf8");
  await chmod(plistPath(label), mode);
}

async function writeLauncher(
  label: ServiceLabel,
  text: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(launcherPath(label)), { recursive: true });
  await writeFile(launcherPath(label), text, "utf8");
  await chmod(launcherPath(label), mode);
}

/** A hand-crafted plist with a controlled `ProgramArguments` array and a
 * distinctive `EnvironmentVariables PATH`, so a byte-diff against the
 * refreshed plist proves the patch touched ONLY the array. */
function craftPlist(
  label: ServiceLabel,
  programArgs: readonly string[],
  customPath: string,
): string {
  const programArgsXml = programArgs
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label.id)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/test-writer</string>
    <key>PATH</key>
    <string>${escapeXml(customPath)}</string>
  </dict>
</dict>
</plist>
`;
}

const PROGRAM_ARGUMENTS_PATTERN =
  /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/;

function stripProgramArguments(xml: string): string {
  return xml.replace(
    PROGRAM_ARGUMENTS_PATTERN,
    "PROGRAM_ARGUMENTS_PLACEHOLDER",
  );
}

function programArgumentsOf(xml: string): readonly string[] {
  const match = xml.match(PROGRAM_ARGUMENTS_PATTERN);
  if (match === null || match[1] === undefined) {
    throw new Error("fixture has no ProgramArguments to read back");
  }
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((m) => m[1])
    .filter((v): v is string => v !== undefined)
    .map(unescapeXml);
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** The historical launcher-FILE body, pre-adoption-nonce (commit 6796b8cca):
 * a single capability probe, no adoption-nonce dance. Real history, not an
 * invented fixture. */
function historicalLauncherFileBody(labelId: string): string {
  return `#!/bin/sh
# Traycer host launcher. Written by 'traycer host service install'; the
# LaunchAgent plist executes this file with the CLI invocation as its
# arguments. It exists as a FILE (not an inline 'sh -c' program) so macOS
# names the login item after it instead of after /bin/sh.
"$@" host capabilities --has service-label >/dev/null 2>&1 && exec "$@" host start --service-label ${posixShellQuote(labelId)} || exec "$@" host start
`;
}

beforeEach(() => {
  processRunnerCalls.length = 0;
});

describe("launcher-file form: plist current, launcher FILE stale", () => {
  it("stale{launcher-file, next-start}; refresh writes ONLY the launcher (body === buildHostStartLauncherScript, mode 0o755); plist bytes+mtime unchanged", async () => {
    const label = labelFor("launcher-old-body");
    const plistText = buildLaunchAgentPlist({ label, cli: CLI });
    await writePlist(label, plistText, 0o644);
    await writeLauncher(label, historicalLauncherFileBody(label.id), 0o755);

    const state = await inspectMacosServiceDefinition(label);
    expect(state).toEqual({
      kind: "stale",
      form: "launcher-file",
      appliesAt: "next-start",
    });

    const plistBefore = await stat(plistPath(label));
    const result = await refreshMacosServiceDefinition(label);
    expect(result).toEqual({
      kind: "refreshed",
      form: "launcher-file",
      appliesAt: "next-start",
    });

    expect(await readFile(launcherPath(label), "utf8")).toBe(
      buildHostStartLauncherScript(label.id),
    );
    expect((await stat(launcherPath(label))).mode & 0o777).toBe(0o755);

    const plistAfter = await stat(plistPath(label));
    expect(plistAfter.mtimeMs).toBe(plistBefore.mtimeMs);
    expect(await readFile(plistPath(label), "utf8")).toBe(plistText);
    expect(processRunnerCalls).toEqual([]);
  });
});

interface LauncherlessFixture {
  readonly id: string;
  readonly name: string;
  readonly programArgs: (cli: CliInvocation, label: ServiceLabel) => string[];
}

const LAUNCHERLESS_FIXTURES: readonly LauncherlessFixture[] = [
  {
    id: "m1-direct",
    name: "M1: direct '<cli> host start' ProgramArguments",
    programArgs: (cli) => [cli.command, "host", "start"],
  },
  {
    id: "m2-inline-script",
    name: "M2: inline '/bin/sh -c' capability-probe wrapper ProgramArguments",
    programArgs: (cli, label) => [
      "/bin/sh",
      "-c",
      `${COMPATIBLE_HOST_START_SCRIPT_PREFIX} >/dev/null 2>&1 && exec "$0" "$@" host start --service-label '${label.id}' || exec "$0" "$@" host start`,
      cli.command,
    ],
  },
];

describe("launcher-less forms (M1 direct, M2 inline): patch ONLY ProgramArguments", () => {
  it.each(LAUNCHERLESS_FIXTURES)(
    "$name -> stale{..., next-login}; refresh writes the launcher AND patches ONLY the plist's ProgramArguments array, rest byte-for-byte (incl. a custom EnvironmentVariables PATH), mode preserved",
    async ({ id, programArgs }) => {
      const label = labelFor(id);
      const originalPlist = craftPlist(
        label,
        programArgs(CLI, label),
        CUSTOM_PATH,
      );
      await writePlist(label, originalPlist, 0o644);

      const state = await inspectMacosServiceDefinition(label);
      expect(state.kind).toBe("stale");
      if (state.kind !== "stale") throw new Error("unreachable");
      expect(state.appliesAt).toBe("next-login");

      const result = await refreshMacosServiceDefinition(label);
      expect(result.kind).toBe("refreshed");
      if (result.kind !== "refreshed") throw new Error("unreachable");
      expect(result.appliesAt).toBe("next-login");

      // The launcher is written too - a patched plist now runs it.
      expect(await readFile(launcherPath(label), "utf8")).toBe(
        buildHostStartLauncherScript(label.id),
      );
      expect((await stat(launcherPath(label))).mode & 0o777).toBe(0o755);

      const newPlist = await readFile(plistPath(label), "utf8");
      expect(newPlist).not.toBe(originalPlist);
      // Byte-for-byte outside the ProgramArguments array - the custom PATH
      // survives untouched, proving the patch never regenerated the plist.
      expect(stripProgramArguments(newPlist)).toBe(
        stripProgramArguments(originalPlist),
      );
      expect(newPlist).toContain(CUSTOM_PATH);
      expect((await stat(plistPath(label))).mode & 0o777).toBe(0o644);

      // The registered CLI invocation is carried over unchanged, now routed
      // through the launcher file.
      expect(programArgumentsOf(newPlist)).toEqual([
        launcherPath(label),
        CLI.command,
      ]);

      expect(processRunnerCalls).toEqual([]);
    },
  );
});

describe("current: no writes at all", () => {
  it("a current launcher-file plist + current launcher body: zero process-runner calls, both files' bytes+mtime unchanged", async () => {
    const label = labelFor("current-macos");
    const plistText = buildLaunchAgentPlist({ label, cli: CLI });
    await writePlist(label, plistText, 0o644);
    const launcherText = buildHostStartLauncherScript(label.id);
    await writeLauncher(label, launcherText, 0o755);
    const plistBefore = await stat(plistPath(label));
    const launcherBefore = await stat(launcherPath(label));

    const state = await inspectMacosServiceDefinition(label);
    expect(state).toEqual({ kind: "current" });

    const result = await refreshMacosServiceDefinition(label);
    expect(result).toEqual({ kind: "current" });

    const plistAfter = await stat(plistPath(label));
    const launcherAfter = await stat(launcherPath(label));
    expect(plistAfter.mtimeMs).toBe(plistBefore.mtimeMs);
    expect(launcherAfter.mtimeMs).toBe(launcherBefore.mtimeMs);
    expect(await readFile(plistPath(label), "utf8")).toBe(plistText);
    expect(await readFile(launcherPath(label), "utf8")).toBe(launcherText);
    expect(processRunnerCalls).toEqual([]);
  });
});

describe("not-registered and unrecognized", () => {
  it("no plist at all: not-registered, zero writes", async () => {
    const label = labelFor("not-registered-macos");
    const state = await inspectMacosServiceDefinition(label);
    expect(state).toEqual({ kind: "not-registered" });
    const result = await refreshMacosServiceDefinition(label);
    expect(result).toEqual({ kind: "not-registered" });
    expect(processRunnerCalls).toEqual([]);
  });

  it("a plist whose ProgramArguments is not a Traycer host start: unrecognized; refresh throws naming 'traycer host service install', plist untouched", async () => {
    const label = labelFor("unrecognized-macos");
    const originalPlist = craftPlist(
      label,
      ["/usr/bin/some-other-binary", "--flag"],
      CUSTOM_PATH,
    );
    await writePlist(label, originalPlist, 0o644);

    const state = await inspectMacosServiceDefinition(label);
    expect(state).toEqual({
      kind: "unrecognized",
      reason: "its ProgramArguments are not a Traycer host start",
    });

    const error = await refreshMacosServiceDefinition(label).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED);
    expect(error.message).toContain(SERVICE_REINSTALL_COMMAND);
    expect(await readFile(plistPath(label), "utf8")).toBe(originalPlist);
    expect(processRunnerCalls).toEqual([]);
  });
});

// Sanity check that this file's own fixtures use the SAME script text a real
// current CLI would embed - guards the M2 fixture against silently drifting
// from `buildCompatibleHostStartScript`'s actual current shape while still
// being deliberately the OLDER `"$0" "$@" host ` form the inline-script
// recognizer keys on.
describe("fixture sanity", () => {
  it('the current buildCompatibleHostStartScript also contains the \'"$0" "$@" host \' marker the recognizer keys on', () => {
    expect(buildCompatibleHostStartScript("ai.traycer.host")).toContain(
      '"$0" "$@" host ',
    );
  });
});
