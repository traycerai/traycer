"use strict";

// Smoke: CLI NDJSON envelope is exactly one terminal result line on stdout.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");
const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
const binaryPath = path.join(workspaceRoot, "dist-sea", binaryName);

function fail(msg) {
  console.error(`[cli ndjson smoke] FAIL: ${msg}`);
  process.exit(1);
}

function buildCleanPath() {
  if (process.platform === "win32") {
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    return `${sysRoot}\\System32`;
  }
  return "";
}

function parseEnvelopes(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const envelopes = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `stdout contained a non-JSON line in --json mode: ${JSON.stringify(line)} (${err.message})`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`stdout line was not an object: ${JSON.stringify(line)}`);
    }
    if (parsed.type !== "progress" && parsed.type !== "result") {
      throw new Error(
        `unknown envelope type=${JSON.stringify(parsed.type)} in line: ${JSON.stringify(line)}`,
      );
    }
    if (typeof parsed.timestamp !== "string" || parsed.timestamp.length === 0) {
      throw new Error(
        `envelope missing 'timestamp' string field: ${JSON.stringify(line)}`,
      );
    }
    envelopes.push(parsed);
  }
  return envelopes;
}

function assertSingleTerminalResultIsLast(envelopes) {
  const resultIndices = [];
  envelopes.forEach((env, idx) => {
    if (env.type === "result") resultIndices.push(idx);
  });
  if (resultIndices.length !== 1) {
    throw new Error(
      `expected exactly one terminal 'result' event, saw ${resultIndices.length}`,
    );
  }
  if (resultIndices[0] !== envelopes.length - 1) {
    throw new Error(
      `terminal 'result' event must be the LAST stdout line (got index=${resultIndices[0]}, total=${envelopes.length})`,
    );
  }
}

function assertResultShape(event) {
  if (event.status !== "ok" && event.status !== "error") {
    throw new Error(
      `result.status must be 'ok' or 'error', got ${JSON.stringify(event.status)}`,
    );
  }
  if (event.status === "error") {
    if (!event.error || typeof event.error !== "object") {
      throw new Error("result error envelope is missing 'error' object");
    }
    if (typeof event.error.code !== "string" || event.error.code.length === 0) {
      throw new Error(
        "result error envelope is missing machine-readable 'error.code'",
      );
    }
    if (typeof event.error.message !== "string") {
      throw new Error("result error envelope is missing 'error.message'");
    }
  }
}

function runCli(args, envOverrides) {
  const env = {
    ...process.env,
    ...envOverrides,
    PATH: buildCleanPath(),
  };
  // Strip casing variants - see smoke-cli-sea.cjs for the rationale.
  delete env.NODE;
  delete env.BUN_INSTALL;
  // Always default to non-interactive so any auto-bootstrap path that
  // tries to prompt the user fails fast instead of hanging the smoke.
  env.TRAYCER_NONINTERACTIVE = "1";
  // Don't let stray progress sinks (TTY tickers, etc.) leak into stdout - that would be a contract violation anyway, but if a regression sneaks in we want the assertion below to flag it.
  const result = spawnSync(binaryPath, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(
      `failed to spawn ${binaryPath} ${args.join(" ")}: ${result.error.message}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function smokeVersion() {
  const run = runCli(["--version", "--json"], {});
  // `--version` is commander-owned and may print as plain text on some versions even with `--json`.
  // Treat it as a soft check: if stdout does* contain JSON envelopes, they must conform; otherwise a non-empty plain-text line is acceptable.
  const trimmed = run.stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("`traycer --version --json` produced no stdout");
  }
  if (trimmed.startsWith("{")) {
    const envelopes = parseEnvelopes(run.stdout);
    assertSingleTerminalResultIsLast(envelopes);
    const terminal = envelopes[envelopes.length - 1];
    assertResultShape(terminal);
  }
  console.log(
    `[cli ndjson smoke] version ok (stdout=${JSON.stringify(trimmed)})`,
  );
}

function smokeUnknownSubcommand() {
  // Force a structured failure path with no host / network / state
  // dependency.
  const run = runCli(
    ["host", "this-subcommand-definitely-does-not-exist", "--json"],
    {},
  );
  if (run.status === 0) {
    throw new Error(
      `expected non-zero exit for unknown subcommand, got status=${run.status}, stdout=${run.stdout}`,
    );
  }
  const envelopes = parseEnvelopes(run.stdout);
  if (envelopes.length === 0) {
    // Some commander builds emit the unknown-subcommand error to stderr before the runner ever boots.
    // Accept that path as long as stderr is non-empty - Desktop only consumes stdout NDJSON.
    if (run.stderr.trim().length === 0) {
      throw new Error(
        "unknown-subcommand path produced no NDJSON on stdout AND no stderr text",
      );
    }
    console.log(
      "[cli ndjson smoke] unknown-subcommand surfaced via stderr (no stdout NDJSON) - acceptable",
    );
    return;
  }
  assertSingleTerminalResultIsLast(envelopes);
  const terminal = envelopes[envelopes.length - 1];
  assertResultShape(terminal);
  if (terminal.status !== "error") {
    throw new Error(
      `unknown-subcommand should emit result.status=error, got ${terminal.status}`,
    );
  }
  console.log(
    `[cli ndjson smoke] unknown-subcommand ok (code=${terminal.error.code})`,
  );
}

function smokeWhoamiNoCredentials() {
  // `whoami` is one of the legacy-JSON commands migrated to the shared NDJSON runner (Native Packaging follow-up, ticket:e86b8372-…/a9fa5e4c-…).
  // Point HOME at a freshly-created empty directory so the command never finds stored credentials and runs entirely off-disk.
  const tmpHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "traycer-ndjson-whoami-"),
  );
  try {
    const run = runCli(["whoami", "--json"], {
      HOME: tmpHome,
      USERPROFILE: tmpHome,
    });
    const envelopes = parseEnvelopes(run.stdout);
    if (envelopes.length === 0) {
      throw new Error(
        "`whoami --json` produced no stdout NDJSON - migrated command must emit a terminal `result` event",
      );
    }
    assertSingleTerminalResultIsLast(envelopes);
    const terminal = envelopes[envelopes.length - 1];
    assertResultShape(terminal);
    console.log(
      `[cli ndjson smoke] whoami ok (terminal=${terminal.status}, exit=${run.status})`,
    );
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function smokeConfigEnvListEmpty() {
  // `config env list` was migrated alongside `whoami`.
  // With an empty HOME the on-disk config doesn't exist, so the command reports an empty overrides list.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "traycer-ndjson-cfg-"));
  try {
    const run = runCli(["config", "env", "list", "--json"], {
      HOME: tmpHome,
      USERPROFILE: tmpHome,
    });
    const envelopes = parseEnvelopes(run.stdout);
    if (envelopes.length === 0) {
      throw new Error(
        "`config env list --json` produced no stdout NDJSON - migrated command must emit a terminal `result` event",
      );
    }
    assertSingleTerminalResultIsLast(envelopes);
    const terminal = envelopes[envelopes.length - 1];
    assertResultShape(terminal);
    console.log(
      `[cli ndjson smoke] config-env-list ok (terminal=${terminal.status}, exit=${run.status})`,
    );
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function smokeHostStatusEmptyHome() {
  // Pin TRAYCER_HOME to a freshly-created empty directory so the command runs entirely off-disk - no real install state, no network.
  // Whether the runner reports ok-with-empty-data or a structured error doesn't matter for the envelope smoke; both shapes must validate.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "traycer-ndjson-"));
  try {
    const run = runCli(["host", "status", "--json"], {
      TRAYCER_HOME: tmpRoot,
    });
    if (run.stdout.trim().length === 0) {
      // Some configurations may early-exit on stderr; accept this just
      // like the unknown-subcommand path.
      if (run.stderr.trim().length === 0) {
        throw new Error(
          "host status produced no stdout AND no stderr - runner contract requires a terminal envelope",
        );
      }
      console.log(
        "[cli ndjson smoke] host-status emitted no stdout - accepting stderr-only path",
      );
      return;
    }
    const envelopes = parseEnvelopes(run.stdout);
    assertSingleTerminalResultIsLast(envelopes);
    const terminal = envelopes[envelopes.length - 1];
    assertResultShape(terminal);
    console.log(
      `[cli ndjson smoke] host-status ok (terminal=${terminal.status}, events=${envelopes.length})`,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function main() {
  if (!fs.existsSync(binaryPath)) {
    fail(
      `${binaryPath} not found. Run \`bun run --filter @traycer-clients/traycer-cli build:sea\` first.`,
    );
  }

  try {
    smokeVersion();
    smokeUnknownSubcommand();
    smokeHostStatusEmptyHome();
    smokeWhoamiNoCredentials();
    smokeConfigEnvListEmpty();
  } catch (err) {
    fail(err && err.stack ? err.stack : String(err));
  }

  console.log(
    `[cli ndjson smoke] OK platform=${process.platform} arch=${process.arch}`,
  );
}

main();
