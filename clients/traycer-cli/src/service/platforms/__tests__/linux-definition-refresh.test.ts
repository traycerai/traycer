import { mkdtempSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  readdir,
  writeFile,
} from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Test isolation: `serviceManifestPath` normally resolves through the real
// `os.homedir()` to `~/.config/systemd/user/<label>.service` - redirect it
// into a private temp dir, same technique `linux.test.ts` already uses for
// its own install-flow describe.
const TEST_UNIT_DIR = mkdtempSync(
  join(tmpdir(), "traycer-linux-definition-refresh-test-"),
);
vi.mock("../../label", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../label")>();
  return {
    ...actual,
    serviceManifestPath: (label: { readonly id: string }) =>
      join(TEST_UNIT_DIR, `${label.id}.service`),
  };
});

afterAll(async () => {
  await rm(TEST_UNIT_DIR, { recursive: true, force: true });
});

import {
  buildSystemdUnit,
  inspectLinuxServiceDefinition,
  refreshLinuxServiceDefinition,
  type ProcessRunner,
} from "../linux";
import { COMPATIBLE_HOST_START_SCRIPT_PREFIX } from "../host-start-script";
import {
  SERVICE_REFRESH_COMMAND,
  SERVICE_REINSTALL_COMMAND,
} from "../../service-definition";
import { CLI_ERROR_CODES, CliError } from "../../../runner/errors";
import { ProcessRunError, type RunResult } from "../../process-runner";
import type { ServiceLabel } from "../../label";
import type { CliInvocation } from "../../cli-binary";

/**
 * `refreshLinuxServiceDefinition` / `inspectLinuxServiceDefinition` (M1):
 * bring a stale systemd user unit to `buildSystemdUnit`'s current text
 * WITHOUT ever running `start`, `restart`, `stop`, `enable`, `disable`,
 * `kill` or `reset-failed` - the only mutating call allowed is exactly one
 * `systemctl --user daemon-reload`.
 *
 * L1 and L2 are real historical unit shapes, not invented ones: L1 is the
 * very first `buildUnit` (commit 6afe6b01b, launcher-less `<cli> host
 * start`); L2 is the `/bin/sh -c` capability-probe wrapper from commit
 * f28fbdb30, before the adoption-nonce logic existed
 * (`COMPATIBLE_HOST_START_SCRIPT_PREFIX` is the same shared constant that
 * wrapper used).
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

function manifestPath(label: ServiceLabel): string {
  return join(TEST_UNIT_DIR, `${label.id}.service`);
}

function quoteExecStartToken(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A plausible OLDER unit body: same scaffolding, an ExecStart this test
 * controls. Never equal to `buildSystemdUnit`'s current output, which is
 * exactly the point - every fixture below must read as stale. */
function historicalUnit(
  label: ServiceLabel,
  execStartTokens: readonly string[],
): string {
  const execStart = execStartTokens.map(quoteExecStartToken).join(" ");
  return `[Unit]
Description=${label.displayName}
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function writeUnit(
  label: ServiceLabel,
  text: string,
  mode: number | null,
): Promise<void> {
  await mkdir(TEST_UNIT_DIR, { recursive: true });
  await writeFile(manifestPath(label), text, "utf8");
  if (mode !== null) await chmod(manifestPath(label), mode);
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function recordingRunner(calls: RecordedCall[]): ProcessRunner {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    const result: RunResult = { stdout: "", stderr: "", exitCode: 0 };
    return result;
  };
}

const FORBIDDEN_VERBS = [
  "start",
  "restart",
  "stop",
  "enable",
  "disable",
  "kill",
  "reset-failed",
];

function assertNoForbiddenVerb(calls: readonly RecordedCall[]): void {
  for (const call of calls) {
    for (const verb of FORBIDDEN_VERBS) {
      expect(call.args).not.toContain(verb);
    }
  }
}

interface StaleFixture {
  readonly id: string;
  readonly name: string;
  readonly form: "direct" | "inline-script";
  readonly tokens: (cli: CliInvocation, label: ServiceLabel) => string[];
}

const STALE_FIXTURES: readonly StaleFixture[] = [
  {
    id: "l1-launcherless-direct",
    name: "L1: launcher-less '<cli> host start' (the very first buildUnit, 6afe6b01b)",
    form: "direct",
    tokens: (cli) => [cli.command, "host", "start"],
  },
  {
    id: "l2-capability-probe-wrapper",
    name: "L2: the pre-adoption-nonce '/bin/sh -c' capability-probe wrapper (f28fbdb30)",
    form: "inline-script",
    tokens: (cli, label) => [
      "/bin/sh",
      "-c",
      `${COMPATIBLE_HOST_START_SCRIPT_PREFIX} >/dev/null 2>&1 && exec "$0" "$@" host start --service-label '${label.id}' || exec "$0" "$@" host start`,
      cli.command,
    ],
  },
  {
    id: "labelled-direct-still-launcherless",
    name: "'<cli> host start --service-label <label>' (labelled, but still no launcher-file wrapper)",
    form: "direct",
    tokens: (cli, label) => [
      cli.command,
      "host",
      "start",
      "--service-label",
      label.id,
    ],
  },
];

describe("inspectLinuxServiceDefinition: stale fixtures", () => {
  it.each(STALE_FIXTURES)(
    "$name -> stale{form:'$form', appliesAt:'next-start'}",
    async ({ id, tokens, form }) => {
      const label = labelFor(`inspect-${id}`);
      await writeUnit(label, historicalUnit(label, tokens(CLI, label)), 0o644);

      const state = await inspectLinuxServiceDefinition(label);

      expect(state).toEqual({ kind: "stale", form, appliesAt: "next-start" });
    },
  );
});

describe("refreshLinuxServiceDefinition: stale fixtures rewrite to the current unit via daemon-reload only", () => {
  it.each(STALE_FIXTURES)(
    "$name -> unit text === buildSystemdUnit's current output, mode preserved, runner calls === exactly [[systemctl, --user daemon-reload]], no start|restart|stop|enable|disable|kill|reset-failed",
    async ({ id, tokens, form }) => {
      const label = labelFor(`refresh-${id}`);
      const originalMode = 0o640;
      await writeUnit(
        label,
        historicalUnit(label, tokens(CLI, label)),
        originalMode,
      );
      const calls: RecordedCall[] = [];

      const result = await refreshLinuxServiceDefinition(
        label,
        recordingRunner(calls),
      );

      expect(result).toEqual({
        kind: "refreshed",
        form,
        appliesAt: "next-start",
      });
      const newText = await readFile(manifestPath(label), "utf8");
      expect(newText).toBe(buildSystemdUnit({ label, cli: CLI }));
      const newMode = (await stat(manifestPath(label))).mode & 0o777;
      expect(newMode).toBe(originalMode);
      expect(calls).toEqual([
        { command: "systemctl", args: ["--user", "daemon-reload"] },
      ]);
      assertNoForbiddenVerb(calls);
    },
  );
});

describe("current unit: the positive controls above's negative counterpart", () => {
  it("a unit already at buildSystemdUnit's current output: zero runner calls, bytes+mtime unchanged, no leftover .*.tmp file", async () => {
    const label = labelFor("current-unit");
    const currentText = buildSystemdUnit({ label, cli: CLI });
    await writeUnit(label, currentText, 0o644);
    const before = await stat(manifestPath(label));
    const calls: RecordedCall[] = [];

    const result = await refreshLinuxServiceDefinition(
      label,
      recordingRunner(calls),
    );

    expect(result).toEqual({ kind: "current" });
    expect(calls).toEqual([]);
    const after = await stat(manifestPath(label));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(manifestPath(label), "utf8")).toBe(currentText);
    const entries = await readdir(TEST_UNIT_DIR);
    const leftoverTmp = entries.filter(
      (name) =>
        name.startsWith(`.${label.id}.service.`) && name.endsWith(".tmp"),
    );
    expect(leftoverTmp).toEqual([]);
  });

  it("inspect on the same current unit reports {kind:'current'} with zero writes", async () => {
    const label = labelFor("current-unit-inspect");
    await writeUnit(label, buildSystemdUnit({ label, cli: CLI }), 0o644);

    const state = await inspectLinuxServiceDefinition(label);

    expect(state).toEqual({ kind: "current" });
  });
});

describe("not-registered: no manifest at all", () => {
  it("inspect reports not-registered", async () => {
    const label = labelFor("not-registered-inspect");
    const state = await inspectLinuxServiceDefinition(label);
    expect(state).toEqual({ kind: "not-registered" });
  });

  it("refresh reports not-registered with zero runner calls", async () => {
    const label = labelFor("not-registered-refresh");
    const calls: RecordedCall[] = [];
    const result = await refreshLinuxServiceDefinition(
      label,
      recordingRunner(calls),
    );
    expect(result).toEqual({ kind: "not-registered" });
    expect(calls).toEqual([]);
  });
});

describe("unrecognized ExecStart", () => {
  it("inspect reports unrecognized with a reason naming the ExecStart", async () => {
    const label = labelFor("unrecognized-inspect");
    await writeUnit(
      label,
      historicalUnit(label, ["/usr/bin/some-other-binary", "--flag"]),
      0o644,
    );

    const state = await inspectLinuxServiceDefinition(label);

    expect(state).toEqual({
      kind: "unrecognized",
      reason: "its ExecStart is not a Traycer host start",
    });
  });

  it("refresh throws E_SERVICE_DEFINITION_REFRESH_FAILED naming 'traycer host service install', leaves the file untouched, zero runner calls", async () => {
    const label = labelFor("unrecognized-refresh");
    const originalText = historicalUnit(label, [
      "/usr/bin/some-other-binary",
      "--flag",
    ]);
    await writeUnit(label, originalText, 0o644);
    const calls: RecordedCall[] = [];

    const error = await refreshLinuxServiceDefinition(
      label,
      recordingRunner(calls),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED);
    expect(error.message).toContain(SERVICE_REINSTALL_COMMAND);
    expect(await readFile(manifestPath(label), "utf8")).toBe(originalText);
    expect(calls).toEqual([]);
  });
});

describe("daemon-reload rejects", () => {
  it("throws E_SERVICE_DEFINITION_REFRESH_FAILED naming 'traycer host service refresh'; the unit is already rewritten to the current form", async () => {
    const label = labelFor("daemon-reload-rejects");
    await writeUnit(
      label,
      historicalUnit(label, [CLI.command, "host", "start"]),
      0o644,
    );
    const calls: RecordedCall[] = [];
    const failingRunner: ProcessRunner = async (command, args) => {
      calls.push({ command, args: [...args] });
      throw new ProcessRunError(
        "systemctl --user daemon-reload exited with code 1: unit file changed on disk",
        command,
        args,
        1,
        "",
        "unit file changed on disk",
      );
    };

    const error = await refreshLinuxServiceDefinition(
      label,
      failingRunner,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.SERVICE_DEFINITION_REFRESH_FAILED);
    expect(error.message).toContain(SERVICE_REFRESH_COMMAND);
    // The write already committed before daemon-reload was even attempted -
    // strictly better than the stale unit, and what systemd loads at the
    // unit's next start, so it stays rewritten despite the reload failure.
    expect(await readFile(manifestPath(label), "utf8")).toBe(
      buildSystemdUnit({ label, cli: CLI }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "systemctl",
      args: ["--user", "daemon-reload"],
    });
  });
});
